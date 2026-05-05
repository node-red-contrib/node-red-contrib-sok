import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

import { SOK } from '../constants.js';
import type { BluetoothBackend, Logger, ResolvedConnectOptions, ResolvedDiscoverOptions, SokCharacteristic, SokDiscoveredDevice, SokSession } from './backend.js';
import { errorMessage, formatCanonicalUuid, matchesSokDevice, normalizeUuid, nullableNumber, nullableString, unboxBluezValue, uniqueDevices } from './utils.js';

type BluezObjects = Record<string, Record<string, Record<string, unknown>>>;
type BluezVariantConstructor = new (signature: string, value: unknown) => unknown;

interface BluezBus {
  getProxyObject(service: string, path: string): Promise<{ getInterface(name: string): unknown }>;
  disconnect(): void;
}

interface BluezObjectManager {
  GetManagedObjects(): Promise<BluezObjects>;
}

interface BluezAdapter {
  StartDiscovery(): Promise<void>;
  StopDiscovery(): Promise<void>;
  SetDiscoveryFilter(filter: Record<string, unknown>): Promise<void>;
}

interface BluezDevice {
  Connect(): Promise<void>;
  Disconnect(): Promise<void>;
}

interface BluezCharacteristic {
  ReadValue(options: Record<string, unknown>): Promise<number[]>;
  WriteValue(value: number[], options: Record<string, unknown>): Promise<void>;
  StartNotify(): Promise<void>;
}

interface BluezProperties {
  Get(interfaceName: string, propertyName: string): Promise<unknown>;
  on(event: 'PropertiesChanged', listener: (interfaceName: string, changed: Record<string, unknown>, invalidated: string[]) => void): void;
  removeListener(event: 'PropertiesChanged', listener: (interfaceName: string, changed: Record<string, unknown>, invalidated: string[]) => void): void;
}

const requireOptional = createRequire(import.meta.url);
const DISCOVERY_POLL_MS = 500;

let activeSessions = new Set<SokSession>();

export const bluezBackend: BluetoothBackend = {
  name: 'bluez',
  isAvailable: isBluezAvailable,
  discover: discoverBluezDevices,
  connect: connectBluezDevice,
  shutdown: shutdownBluez
};

async function isBluezAvailable(logger: Logger = () => {}): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  try {
    const { systemBus } = loadDbusNext();
    const bus = systemBus();
    try {
      const object = await bus.getProxyObject('org.bluez', '/');
      const objectManager = object.getInterface('org.freedesktop.DBus.ObjectManager') as BluezObjectManager;
      const objects = await objectManager.GetManagedObjects();
      return findBluezAdapterPath(objects) !== null;
    } finally {
      bus.disconnect();
    }
  } catch (error) {
    logger(`BlueZ backend is not available: ${errorMessage(error)}.`);
    return false;
  }
}

async function discoverBluezDevices(options: ResolvedDiscoverOptions): Promise<SokDiscoveredDevice[]> {
  if (process.platform !== 'linux') throw new Error('BlueZ backend is only available on Linux.');
  const { systemBus, Variant } = loadDbusNext();
  const bus = systemBus();

  try {
    const { objectManager, adapter } = await openBluezAdapter(bus);
    const canonicalServiceUuid = options.matchServiceUuid ? formatCanonicalUuid(options.matchServiceUuid) : null;
    await setBluezDiscoveryFilter(adapter, Variant, canonicalServiceUuid, options.logger);
    await adapter.StartDiscovery();
    options.logger(`BlueZ discovery started. Waiting ${options.timeoutMs}ms.`);

    const devices: SokDiscoveredDevice[] = [];
    const startedAt = Date.now();
    try {
      while (Date.now() - startedAt < options.timeoutMs) {
        const objects = await objectManager.GetManagedObjects();
        devices.push(...findBluezDevices(objects, options));
        await delay(DISCOVERY_POLL_MS);
      }
    } finally {
      await adapter.StopDiscovery().catch((error: unknown) => options.logger(`Warning: could not stop BlueZ discovery: ${errorMessage(error)}.`));
    }

    return uniqueDevices(devices);
  } finally {
    bus.disconnect();
  }
}

async function connectBluezDevice({ device, timeoutMs, connectTimeoutMs, logger }: ResolvedConnectOptions): Promise<SokSession> {
  if (process.platform !== 'linux') throw new Error('BlueZ backend is only available on Linux.');
  const { systemBus } = loadDbusNext();
  const bus = systemBus();

  try {
    const objectManagerObject = await bus.getProxyObject('org.bluez', '/');
    const objectManager = objectManagerObject.getInterface('org.freedesktop.DBus.ObjectManager') as BluezObjectManager;
    let objects = await objectManager.GetManagedObjects();
    let target = findBluezDeviceByDiscovered(objects, device);

    if (!target) {
      const matches = await discoverBluezDevices({
        namePrefix: SOK.advertisedNamePrefix,
        deviceName: device.name,
        timeoutMs,
        scanServiceUuid: null,
        matchServiceUuid: SOK.serviceUuid,
        logger
      });
      const refreshed = matches.find((match) => match.name === device.name || match.address === device.address || match.id === device.id);
      if (!refreshed) throw new Error(`Could not rediscover ${device.name || device.address || device.id}.`);
      objects = await objectManager.GetManagedObjects();
      target = findBluezDeviceByDiscovered(objects, refreshed);
    }

    if (!target) throw new Error(`Could not find ${device.name || device.address || device.id} in BlueZ managed objects.`);
    logger(`BlueZ connecting to ${target.address || '<unknown address>'} at ${target.path}.`);

    const deviceObject = await bus.getProxyObject('org.bluez', target.path);
    const bluezDevice = deviceObject.getInterface('org.bluez.Device1') as BluezDevice;
    const deviceProperties = deviceObject.getInterface('org.freedesktop.DBus.Properties') as BluezProperties;
    if (!(await getBluezBoolean(deviceProperties, 'org.bluez.Device1', 'Connected'))) {
      await withTimeout(bluezDevice.Connect(), connectTimeoutMs, 'BlueZ Device1.Connect()');
    }
    await waitForBluezBooleanProperty(deviceProperties, 'org.bluez.Device1', 'ServicesResolved', true, timeoutMs);
    logger('BlueZ connected and services resolved.');

    const refreshedObjects = await objectManager.GetManagedObjects();
    const characteristics = await buildBluezCharacteristics({ bus, objects: refreshedObjects, devicePath: target.path, logger });
    await characteristics.notify.subscribe();
    logger('Subscribed to SOK notification characteristic fff1 via BlueZ.');

    const session: SokSession = {
      device: toDiscoveredDevice(target.path, refreshedObjects[target.path]?.['org.bluez.Device1'] || {}, 'bluez'),
      notify: characteristics.notify,
      write: characteristics.write,
      disconnect: async () => {
        activeSessions.delete(session);
        await bluezDevice.Disconnect().catch(() => {});
        bus.disconnect();
      }
    };
    activeSessions.add(session);
    return session;
  } catch (error) {
    bus.disconnect();
    throw error;
  }
}

async function openBluezAdapter(bus: BluezBus): Promise<{ objectManager: BluezObjectManager; adapter: BluezAdapter; adapterPath: string }> {
  const objectManagerObject = await bus.getProxyObject('org.bluez', '/');
  const objectManager = objectManagerObject.getInterface('org.freedesktop.DBus.ObjectManager') as BluezObjectManager;
  const objects = await objectManager.GetManagedObjects();
  const adapterPath = findBluezAdapterPath(objects);
  if (!adapterPath) throw new Error('Could not find a BlueZ adapter via org.bluez ObjectManager.');
  const adapterObject = await bus.getProxyObject('org.bluez', adapterPath);
  const adapter = adapterObject.getInterface('org.bluez.Adapter1') as BluezAdapter;
  return { objectManager, adapter, adapterPath };
}

async function buildBluezCharacteristics({
  bus,
  objects,
  devicePath,
  logger
}: {
  bus: BluezBus;
  objects: BluezObjects;
  devicePath: string;
  logger: Logger;
}): Promise<{ notify: SokCharacteristic; write: SokCharacteristic }> {
  const byUuid = new Map<string, { path: string; properties: Record<string, unknown> }>();

  for (const [path, interfaces] of Object.entries(objects)) {
    if (!path.startsWith(`${devicePath}/`)) continue;
    const characteristic = interfaces['org.bluez.GattCharacteristic1'];
    if (!characteristic) continue;
    const uuid = nullableString(unboxBluezValue(characteristic.UUID));
    if (!uuid) continue;
    byUuid.set(normalizeUuid(uuid), { path, properties: characteristic });
  }

  logger(`BlueZ discovered ${byUuid.size} GATT characteristic(s): ${[...byUuid.keys()].sort().join(', ')}.`);
  const notify = byUuid.get(SOK.notifyUuid);
  const write = byUuid.get(SOK.writeUuid);
  if (!notify || !write) {
    throw new Error(`Missing SOK BLE characteristics fff1/fff2 via BlueZ. Found: ${[...byUuid.keys()].sort().join(', ')}`);
  }

  return {
    notify: await wrapBluezCharacteristic(bus, notify.path, notify.properties),
    write: await wrapBluezCharacteristic(bus, write.path, write.properties)
  };
}

async function wrapBluezCharacteristic(bus: BluezBus, path: string, initialProperties: Record<string, unknown>): Promise<SokCharacteristic> {
  const object = await bus.getProxyObject('org.bluez', path);
  const characteristic = object.getInterface('org.bluez.GattCharacteristic1') as BluezCharacteristic;
  const properties = object.getInterface('org.freedesktop.DBus.Properties') as BluezProperties;
  const listeners = new Set<(data: Buffer) => void>();
  const flags = Array.isArray(unboxBluezValue(initialProperties.Flags)) ? (unboxBluezValue(initialProperties.Flags) as unknown[]).map(String) : [];
  let writeQueue = Promise.resolve();

  const onPropertiesChanged = (interfaceName: string, changed: Record<string, unknown>) => {
    if (interfaceName !== 'org.bluez.GattCharacteristic1' || !('Value' in changed)) return;
    const value = Buffer.from((unboxBluezValue(changed.Value) as number[]) || []);
    for (const listener of listeners) listener(value);
  };

  properties.on('PropertiesChanged', onPropertiesChanged);

  return {
    uuid: normalizeUuid(String(unboxBluezValue(initialProperties.UUID) || '')),
    properties: flags,
    async write(data, withoutResponse = false) {
      const options = withoutResponse ? { type: new (loadDbusNext().Variant)('s', 'command') } : {};
      writeQueue = writeQueue.then(() => writeBluezValueWithRetry(characteristic, [...data], options));
      await writeQueue;
    },
    async subscribe() {
      await characteristic.StartNotify();
    },
    onData(listener) {
      listeners.add(listener);
    },
    removeDataListener(listener) {
      listeners.delete(listener);
    }
  };
}

function findBluezAdapterPath(objects: BluezObjects): string | null {
  for (const [path, interfaces] of Object.entries(objects)) {
    if (interfaces['org.bluez.Adapter1']) return path;
  }
  return null;
}

function findBluezDevices(objects: BluezObjects, options: ResolvedDiscoverOptions): SokDiscoveredDevice[] {
  const devices: SokDiscoveredDevice[] = [];
  for (const [path, interfaces] of Object.entries(objects)) {
    const device = interfaces['org.bluez.Device1'];
    if (!device) continue;
    const uuids = readBluezUuids(device);
    const discovered = toDiscoveredDevice(path, device, 'bluez');
    if (matchesSokDevice({ name: discovered.name, address: discovered.address, serviceUuids: uuids }, { namePrefix: options.namePrefix, deviceName: options.deviceName, serviceUuid: options.matchServiceUuid })) {
      devices.push(discovered);
    }
  }
  return devices;
}

function findBluezDeviceByDiscovered(objects: BluezObjects, selected: SokDiscoveredDevice): { path: string; address: string | null } | null {
  for (const [path, interfaces] of Object.entries(objects)) {
    const device = interfaces['org.bluez.Device1'];
    if (!device) continue;
    const discovered = toDiscoveredDevice(path, device, 'bluez');
    if (selected.id === path || (!!selected.name && selected.name === discovered.name) || (!!selected.address && selected.address.toUpperCase() === discovered.address?.toUpperCase())) {
      return { path, address: discovered.address };
    }
  }
  return null;
}

function toDiscoveredDevice(path: string, device: Record<string, unknown>, backend: 'bluez'): SokDiscoveredDevice {
  return {
    id: path,
    address: nullableString(unboxBluezValue(device.Address)),
    addressType: null,
    name: nullableString(unboxBluezValue(device.Name)) || nullableString(unboxBluezValue(device.Alias)),
    rssi: nullableNumber(unboxBluezValue(device.RSSI)),
    backend
  };
}

function readBluezUuids(device: Record<string, unknown>): string[] {
  const value = unboxBluezValue(device.UUIDs);
  return Array.isArray(value) ? value.map((uuid) => String(uuid)) : [];
}

async function setBluezDiscoveryFilter(adapter: BluezAdapter, Variant: BluezVariantConstructor, serviceUuid: string | null, logger: Logger): Promise<void> {
  const filters: Array<{ name: string; filter: Record<string, unknown> }> = [
    { name: 'transport', filter: { Transport: new Variant('s', 'le') } },
    { name: 'duplicates', filter: { DuplicateData: new Variant('b', false) } }
  ];
  if (serviceUuid) filters.push({ name: 'service UUID', filter: { UUIDs: new Variant('as', [serviceUuid]) } });

  for (const { name, filter } of filters) {
    await adapter.SetDiscoveryFilter(filter)
      .then(() => logger(`BlueZ discovery filter applied: ${name}.`))
      .catch((error: unknown) => logger(`Warning: could not set BlueZ discovery filter (${name}): ${errorMessage(error)}.`));
  }
}

async function getBluezBoolean(properties: BluezProperties, interfaceName: string, propertyName: string): Promise<boolean | null> {
  const value = await properties.Get(interfaceName, propertyName).catch(() => null);
  const unboxed = unboxBluezValue(value);
  return typeof unboxed === 'boolean' ? unboxed : null;
}

async function waitForBluezBooleanProperty(properties: BluezProperties, interfaceName: string, propertyName: string, expected: boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((await getBluezBoolean(properties, interfaceName, propertyName)) === expected) return;
    await delay(250);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for BlueZ ${propertyName}=${expected}.`);
}

async function writeBluezValueWithRetry(characteristic: BluezCharacteristic, value: number[], options: Record<string, unknown>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await characteristic.WriteValue(value, options);
      return;
    } catch (error) {
      lastError = error;
      if (!isBluezInProgressError(error)) throw error;
      await delay(80);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isBluezInProgressError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes('in progress') || message.includes('inprogress');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms during ${label}.`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

async function shutdownBluez(): Promise<void> {
  const sessions = [...activeSessions];
  activeSessions = new Set();
  await Promise.all(sessions.map((session) => session.disconnect().catch(() => {})));
}

function loadDbusNext(): { systemBus: () => BluezBus; Variant: BluezVariantConstructor } {
  try {
    return requireOptional('dbus-next') as { systemBus: () => BluezBus; Variant: BluezVariantConstructor };
  } catch (error) {
    throw new Error(`BlueZ backend requires the "dbus-next" dependency. Run npm install. ${errorMessage(error)}`);
  }
}
