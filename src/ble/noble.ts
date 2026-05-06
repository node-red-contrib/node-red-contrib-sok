import { createRequire } from 'node:module';

import { SOK } from '../constants.js';
import type { BluetoothBackend, ResolvedConnectOptions, ResolvedDiscoverOptions, SokCharacteristic, SokDiscoveredDevice, SokSession } from './backend.js';
import { asError, matchesSokDevice, normalizeUuid, uniqueDevices } from './utils.js';
import type { Noble, NobleCharacteristic, NoblePeripheral } from '@abandonware/noble';

const DISCONNECT_TIMEOUT_MS = 3000;
const STOP_SCAN_TIMEOUT_MS = 250;
const requireOptional = createRequire(import.meta.url);

let nobleModule: Noble | null = null;
let activePeripheral: NoblePeripheral | null = null;
const discoveredPeripherals = new Map<string, NoblePeripheral>();

export const nobleBackend: BluetoothBackend = {
  name: 'noble',
  isAvailable: async () => true,
  discover: discoverNobleDevices,
  connect: connectNobleDevice,
  shutdown: shutdownNoble
};

async function discoverNobleDevices(options: ResolvedDiscoverOptions): Promise<SokDiscoveredDevice[]> {
  const noble = loadNoble();
  await waitForPoweredOn(noble);
  options.logger('Bluetooth adapter powered on.');

  return new Promise((resolve, reject) => {
    const devices: SokDiscoveredDevice[] = [];
    let settled = false;

    const finish = async (error?: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      noble.removeListener('discover', onDiscover);
      await stopScanningAndWait(noble);
      if (error) reject(error);
      else resolve(uniqueDevices(devices));
    };

    const timeout = setTimeout(() => {
      finish().catch(reject);
    }, options.timeoutMs);

    const onDiscover = (peripheral: NoblePeripheral) => {
      const name = peripheral.advertisement?.localName || null;
      const serviceUuids = peripheral.advertisement?.serviceUuids || [];
      if (!matchesSokDevice({ name, address: peripheral.address || null, serviceUuids }, { namePrefix: options.namePrefix, deviceName: options.deviceName, serviceUuid: options.matchServiceUuid })) {
        return;
      }

      const device = toDiscoveredDevice(peripheral);
      cachePeripheral(peripheral);
      options.logger(`Discovered ${device.name || '<unnamed>'} (${device.address || device.id}, rssi=${device.rssi ?? 'unknown'}).`);
      devices.push(device);
      if (options.deviceName) finish().catch(reject);
    };

    noble.on('discover', onDiscover);
    noble.startScanning(options.scanServiceUuid ? [options.scanServiceUuid] : [], true, (error?: Error) => {
      if (error) finish(error).catch(reject);
    });
  });
}

async function connectNobleDevice({ device, timeoutMs, connectTimeoutMs, logger }: ResolvedConnectOptions): Promise<SokSession> {
  const noble = loadNoble();
  await waitForPoweredOn(noble);
  const peripheral = await connectCachedOrScan({ noble, device, scanTimeoutMs: timeoutMs, connectTimeoutMs, logger });
  activePeripheral = peripheral;

  logger('Discovering SOK services and characteristics.');
  const characteristics = await discoverCharacteristics(peripheral, timeoutMs);
  const byUuid = new Map(characteristics.map((characteristic) => [normalizeUuid(characteristic.uuid), characteristic]));
  logger(`Discovered characteristic UUIDs: ${[...byUuid.keys()].sort().join(', ')}.`);

  const notify = byUuid.get(SOK.notifyUuid);
  const write = byUuid.get(SOK.writeUuid);
  if (!notify || !write) {
    throw new Error(`Missing SOK BLE characteristics fff1/fff2. Found: ${[...byUuid.keys()].sort().join(', ')}`);
  }

  const wrappedNotify = wrapCharacteristic(notify);
  const wrappedWrite = wrapCharacteristic(write);
  await wrappedNotify.subscribe();
  logger('Subscribed to SOK notification characteristic fff1.');

  return {
    device: toDiscoveredDevice(peripheral),
    notify: wrappedNotify,
    write: wrappedWrite,
    disconnect: async () => {
      await disconnectQuietly(peripheral);
      if (activePeripheral === peripheral) activePeripheral = null;
    }
  };
}

async function connectCachedOrScan({
  noble,
  device,
  scanTimeoutMs,
  connectTimeoutMs,
  logger
}: {
  noble: Noble;
  device: SokDiscoveredDevice;
  scanTimeoutMs: number;
  connectTimeoutMs: number;
  logger: (message: string) => void;
}): Promise<NoblePeripheral> {
  const cached = findCachedPeripheral(device);
  if (cached) {
    logger(`Using recently discovered ${displayPeripheral(cached)}.`);
    try {
      await connectAsync(cached, connectTimeoutMs, logger);
      return cached;
    } catch (error) {
      logger(`Could not connect to cached peripheral: ${error instanceof Error ? error.message : String(error)}. Scanning again.`);
    }
  }

  return scanAndConnect({ noble, device, scanTimeoutMs, connectTimeoutMs, logger });
}

function scanAndConnect({
  noble,
  device,
  scanTimeoutMs,
  connectTimeoutMs,
  logger
}: {
  noble: Noble;
  device: SokDiscoveredDevice;
  scanTimeoutMs: number;
  connectTimeoutMs: number;
  logger: (message: string) => void;
}): Promise<NoblePeripheral> {
  return new Promise((resolve, reject) => {
    let connecting = false;
    let settled = false;

    const finish = async (error?: Error | null, peripheral?: NoblePeripheral | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      noble.removeListener('discover', onDiscover);
      await stopScanningAndWait(noble);
      if (error) reject(error);
      else if (peripheral) resolve(peripheral);
      else reject(new Error('Connect completed without a peripheral.'));
    };

    const timeout = setTimeout(() => {
      finish(new Error(`Timed out after ${scanTimeoutMs}ms scanning for ${device.name || device.address || device.id}.`)).catch(reject);
    }, scanTimeoutMs);

    const onDiscover = (peripheral: NoblePeripheral) => {
      if (connecting || !matchesKnownDevice(peripheral, device)) return;
      connecting = true;
      cachePeripheral(peripheral);
      logger(`Found ${displayPeripheral(peripheral)}.`);
      connectAsync(peripheral, connectTimeoutMs, logger)
        .then(() => finish(null, peripheral))
        .catch((error) => finish(asError(error)).catch(reject));
    };

    noble.on('discover', onDiscover);
    noble.startScanning([], true, (error?: Error) => {
      if (error) finish(error).catch(reject);
    });
  });
}

function cachePeripheral(peripheral: NoblePeripheral): void {
  const keys = [peripheral.id, peripheral.address, peripheral.advertisement?.localName].filter((key): key is string => !!key);
  for (const key of keys) discoveredPeripherals.set(key.toLowerCase(), peripheral);
}

function findCachedPeripheral(device: SokDiscoveredDevice): NoblePeripheral | null {
  const keys = [device.id, device.address, device.name].filter((key): key is string => !!key);
  for (const key of keys) {
    const peripheral = discoveredPeripherals.get(key.toLowerCase());
    if (peripheral) return peripheral;
  }
  return null;
}

function matchesKnownDevice(peripheral: NoblePeripheral, device: SokDiscoveredDevice): boolean {
  const name = peripheral.advertisement?.localName || null;
  const address = peripheral.address || null;
  return (!!device.name && name === device.name) || (!!device.address && address?.toLowerCase() === device.address.toLowerCase()) || peripheral.id === device.id;
}

function waitForPoweredOn(noble: Noble): Promise<void> {
  if (noble.state === 'poweredOn') return Promise.resolve();
  if (noble.state === 'unsupported' || noble.state === 'unauthorized') {
    return Promise.reject(new Error(`Bluetooth adapter state is ${noble.state}.`));
  }

  return new Promise((resolve, reject) => {
    const onStateChange = (state: string) => {
      if (state === 'poweredOn') {
        noble.removeListener('stateChange', onStateChange);
        resolve();
      } else if (state === 'unsupported' || state === 'unauthorized') {
        noble.removeListener('stateChange', onStateChange);
        reject(new Error(`Bluetooth adapter state is ${state}.`));
      }
    };
    noble.on('stateChange', onStateChange);
  });
}

function connectAsync(peripheral: NoblePeripheral, timeoutMs: number, logger: (message: string) => void): Promise<void> {
  if (peripheral.state === 'connected') return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const startedAt = Date.now();

    const finish = (error?: Error | string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      const normalized = normalizeConnectError(error);
      logger(`Connect finished after ${Date.now() - startedAt}ms with ${normalized ? `error: ${normalized.message}` : 'success'}.`);
      if (normalized) reject(normalized);
      else resolve();
    };

    const timeout = setTimeout(() => {
      cancelPendingConnect(peripheral, logger);
      finish(new Error(`Timed out after ${timeoutMs}ms while connecting.`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      peripheral.removeListener('connect', onConnect);
      peripheral.removeListener('disconnect', onDisconnect);
    };

    const onConnect = (error?: Error | string | null) => finish(error);
    const onDisconnect = () => finish(new Error('Peripheral disconnected before connect completed.'));

    peripheral.once('connect', onConnect);
    peripheral.once('disconnect', onDisconnect);
    peripheral.connect((error?: Error | string | null) => finish(error));
  });
}

function cancelPendingConnect(peripheral: NoblePeripheral, logger: (message: string) => void): void {
  if (peripheral.state !== 'connecting') return;
  try {
    if (typeof peripheral.cancelConnect === 'function') {
      peripheral.cancelConnect();
      return;
    }
    const noble = loadNoble();
    if (typeof noble._bindings?.disconnect === 'function') noble._bindings.disconnect(peripheral.id);
  } catch (error) {
    logger(`Could not cancel pending connection: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

function discoverCharacteristics(peripheral: NoblePeripheral, timeoutMs: number): Promise<NobleCharacteristic[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms discovering SOK GATT services.`)), timeoutMs);
    peripheral.discoverAllServicesAndCharacteristics((error, _services, characteristics) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(characteristics);
    });
  });
}

function wrapCharacteristic(characteristic: NobleCharacteristic): SokCharacteristic {
  return {
    uuid: normalizeUuid(characteristic.uuid),
    properties: characteristic.properties || [],
    write(data, withoutResponse = false) {
      return new Promise((resolve, reject) => {
        characteristic.write(data, withoutResponse, (error) => (error ? reject(error) : resolve()));
      });
    },
    subscribe() {
      return new Promise((resolve, reject) => {
        characteristic.subscribe((error) => (error ? reject(error) : resolve()));
      });
    },
    onData(listener) {
      characteristic.on('data', listener);
    },
    removeDataListener(listener) {
      characteristic.removeListener('data', listener);
    }
  };
}

function stopScanningAndWait(noble: Noble): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      noble.removeListener('scanStop', finish);
      resolve();
    };
    const timeout = setTimeout(finish, STOP_SCAN_TIMEOUT_MS);
    noble.once('scanStop', finish);
    noble.stopScanning();
  });
}

async function disconnectQuietly(peripheral: NoblePeripheral | null | undefined): Promise<void> {
  if (!peripheral || peripheral.state === 'disconnected') return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      peripheral.removeListener('disconnect', finish);
      resolve();
    };
    const timeout = setTimeout(finish, DISCONNECT_TIMEOUT_MS);
    peripheral.once('disconnect', finish);
    peripheral.disconnect(() => finish());
  });
}

async function shutdownNoble(): Promise<void> {
  const noble = nobleModule;
  if (!noble) return;
  noble.removeAllListeners('discover');
  await stopScanningAndWait(noble);
  await disconnectQuietly(activePeripheral);
  activePeripheral = null;
  discoveredPeripherals.clear();
}

function toDiscoveredDevice(peripheral: NoblePeripheral): SokDiscoveredDevice {
  return {
    id: peripheral.id,
    address: peripheral.address || null,
    addressType: peripheral.addressType || null,
    name: peripheral.advertisement?.localName || null,
    rssi: typeof peripheral.rssi === 'number' ? peripheral.rssi : null,
    backend: 'noble'
  };
}

function displayPeripheral(peripheral: NoblePeripheral): string {
  const name = peripheral.advertisement?.localName || '<unnamed>';
  return `${name} (${peripheral.address || peripheral.id}, ${peripheral.addressType || 'unknown'}, rssi=${peripheral.rssi ?? 'unknown'})`;
}

function normalizeConnectError(error: Error | string | null | undefined): Error | null {
  if (!error) return null;
  return error instanceof Error ? error : new Error(String(error));
}

function loadNoble(): Noble {
  if (!nobleModule) nobleModule = requireOptional('@abandonware/noble') as Noble;
  return nobleModule;
}
