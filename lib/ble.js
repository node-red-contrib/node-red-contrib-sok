'use strict';

const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const { READS, SOK } = require('./constants');
const { buildReadHoldingRegisters, decodeSnapshot, expectedResponseLength, parseReadResponse } = require('./modbus');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 5000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15000;

const requireOptional = createRequire(__filename);
let nobleModule = null;

async function readBattery(options = {}) {
  const logger = options.logger || (() => {});
  const session = await connectToSok(options);
  try {
    const blocks = {};
    const reads = normalizeReads(options.reads);
    for (const read of reads) {
      logger(`Reading SOK ${read.name} registers from 0x${read.start.toString(16)} (${read.count}).`);
      blocks[read.name] = await readRegisters(session, read, options);
    }

    return {
      device: session.device,
      timestamp: new Date().toISOString(),
      decoded: decodeSnapshot(blocks),
      registers: Object.fromEntries(Object.entries(blocks).map(([name, block]) => [name, block.registers])),
      frames: Object.fromEntries(Object.entries(blocks).map(([name, block]) => [name, block.raw]))
    };
  } finally {
    await disconnectQuietly(session.peripheral);
  }
}

async function connectToSok({
  bluetooth = 'auto',
  namePrefix = SOK.advertisedNamePrefix,
  address,
  scanServiceUuid = null,
  matchServiceUuid = SOK.serviceUuid,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  logger = () => {}
} = {}) {
  const backend = await selectBluetoothBackend(bluetooth, logger);
  return backend === 'bluez'
    ? connectToSokBluez({ namePrefix, address, matchServiceUuid, timeoutMs, connectTimeoutMs, logger })
    : connectToSokNoble({ namePrefix, address, scanServiceUuid, matchServiceUuid, timeoutMs, logger });
}

async function selectBluetoothBackend(bluetooth, logger) {
  if (bluetooth === 'bluez' || bluetooth === 'noble') return bluetooth;
  if (process.platform === 'linux' && (await isBluezAvailable(logger))) return 'bluez';
  return 'noble';
}

async function connectToSokNoble({ namePrefix, address, scanServiceUuid, matchServiceUuid, timeoutMs, logger }) {
  const noble = loadNoble();
  await waitForPoweredOn(noble);
  logger('Bluetooth adapter powered on.');

  const peripheral = await scanAndConnect({
    namePrefix,
    address,
    scanServiceUuid,
    matchServiceUuid,
    timeoutMs,
    logger
  });

  logger('Discovering SOK services and characteristics.');
  const characteristics = await discoverCharacteristics(peripheral, timeoutMs);
  const byUuid = new Map(characteristics.map((characteristic) => [normalizeUuid(characteristic.uuid), characteristic]));
  logger(`Discovered characteristic UUIDs: ${[...byUuid.keys()].sort().join(', ')}.`);

  const notify = byUuid.get(SOK.notifyUuid);
  const write = byUuid.get(SOK.writeUuid);
  if (!notify || !write) {
    throw new Error(`Missing SOK BLE characteristics fff1/fff2. Found: ${[...byUuid.keys()].sort().join(', ')}`);
  }

  await subscribeAsync(notify);
  logger('Subscribed to SOK notification characteristic fff1.');

  return {
    peripheral,
    notify,
    write,
    device: {
      id: peripheral.id,
      address: peripheral.address,
      addressType: peripheral.addressType,
      name: peripheral.advertisement?.localName || null,
      rssi: peripheral.rssi
    }
  };
}

function readRegisters(session, read, { responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS, logger = () => {} } = {}) {
  const request = buildReadHoldingRegisters(read.start, read.count);
  return new Promise((resolve, reject) => {
    let chunks = [];
    let timeout = null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      session.notify.removeListener('data', onData);
    };

    const fail = (error) => {
      cleanup();
      reject(error);
    };

    const onData = (data) => {
      chunks.push(Buffer.from(data));
      const frame = Buffer.concat(chunks);
      const expected = expectedResponseLength(frame);
      logger(`SOK notification ${data.toString('hex')} (${expected ? `${frame.length}/${expected}` : `${frame.length}/?`}).`);
      if (expected === null || frame.length < expected) return;
      cleanup();
      try {
        resolve(parseReadResponse(frame.subarray(0, expected), read.start));
      } catch (error) {
        reject(error);
      }
    };

    timeout = setTimeout(() => {
      const received = Buffer.concat(chunks).toString('hex') || '<none>';
      fail(new Error(`Timed out after ${responseTimeoutMs}ms waiting for SOK response to ${request.toString('hex')}; received ${received}.`));
    }, responseTimeoutMs);

    session.notify.on('data', onData);
    logger(`Writing SOK request ${request.toString('hex')}.`);
    writeAsync(session.write, request, true).catch(fail);
  });
}

function normalizeReads(reads) {
  if (!reads) return [READS.telemetry, READS.limits, READS.status];
  const names = Array.isArray(reads) ? reads : String(reads).split(',');
  return names.map((name) => {
    const key = String(name).trim();
    if (!READS[key]) throw new Error(`Unknown SOK read "${key}". Known reads: ${Object.keys(READS).join(', ')}.`);
    return READS[key];
  });
}

function waitForPoweredOn(noble) {
  if (noble.state === 'poweredOn') return Promise.resolve();
  if (noble.state === 'unsupported' || noble.state === 'unauthorized') {
    return Promise.reject(new Error(`Bluetooth adapter state is ${noble.state}.`));
  }

  return new Promise((resolve, reject) => {
    const onStateChange = (state) => {
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

function scanAndConnect({ namePrefix, address, scanServiceUuid, matchServiceUuid, timeoutMs, logger }) {
  const noble = loadNoble();
  return new Promise((resolve, reject) => {
    let settled = false;
    let connecting = false;
    const normalizedAddress = address ? String(address).toLowerCase() : null;

    const finish = async (error, peripheral) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      noble.removeListener('discover', onDiscover);
      await stopScanning();
      if (error) reject(error);
      else resolve(peripheral);
    };

    const timeout = setTimeout(() => {
      finish(new Error(`Timed out after ${timeoutMs}ms scanning for ${address || namePrefix}.`)).catch(reject);
    }, timeoutMs);

    const onDiscover = (peripheral) => {
      if (connecting) return;
      if (!isSokPeripheral(peripheral, { namePrefix, address: normalizedAddress, serviceUuid: matchServiceUuid })) return;
      connecting = true;
      logger(`Found ${displayPeripheral(peripheral)}.`);
      peripheral.connect((error) => {
        if (error) finish(error).catch(reject);
        else finish(null, peripheral).catch(reject);
      });
    };

    noble.on('discover', onDiscover);
    noble.startScanning(scanServiceUuid ? [scanServiceUuid] : [], true, (error) => {
      if (error) finish(error).catch(reject);
    });
  });
}

function isSokPeripheral(peripheral, { namePrefix = SOK.advertisedNamePrefix, address, serviceUuid = SOK.serviceUuid } = {}) {
  if (address && String(peripheral.address || '').toLowerCase() === address) return true;
  const name = peripheral.advertisement?.localName || '';
  if (name.startsWith(namePrefix)) return true;
  const expectedServiceUuid = normalizeUuid(serviceUuid);
  return (peripheral.advertisement?.serviceUuids || []).some((uuid) => normalizeUuid(uuid) === expectedServiceUuid);
}

function discoverCharacteristics(peripheral, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms discovering SOK GATT services.`)), timeoutMs);
    peripheral.discoverAllServicesAndCharacteristics((error, _services, characteristics) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(characteristics);
    });
  });
}

function writeAsync(characteristic, data, withoutResponse) {
  return new Promise((resolve, reject) => {
    characteristic.write(data, withoutResponse, (error) => (error ? reject(error) : resolve()));
  });
}

function subscribeAsync(characteristic) {
  return new Promise((resolve, reject) => {
    characteristic.subscribe((error) => (error ? reject(error) : resolve()));
  });
}

function stopScanning() {
  const noble = loadNoble();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      noble.removeListener('scanStop', finish);
      resolve();
    };
    const timeout = setTimeout(finish, 250);
    noble.once('scanStop', finish);
    noble.stopScanning();
  });
}

function disconnectQuietly(peripheral) {
  if (peripheral?.bluez) return peripheral.disconnect();
  if (!peripheral || peripheral.state === 'disconnected') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    peripheral.once('disconnect', done);
    peripheral.disconnect(() => done());
  });
}

function shutdownBluetooth() {
  const noble = nobleModule;
  if (!noble) return Promise.resolve();
  noble.removeAllListeners('discover');
  return stopScanning();
}

async function isBluezAvailable(logger = () => {}) {
  if (process.platform !== 'linux') return false;
  try {
    const { systemBus } = loadDbusNext();
    const bus = systemBus();
    try {
      const object = await bus.getProxyObject('org.bluez', '/');
      const objectManager = object.getInterface('org.freedesktop.DBus.ObjectManager');
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

async function connectToSokBluez({ namePrefix, address, matchServiceUuid, timeoutMs, connectTimeoutMs, logger }) {
  if (process.platform !== 'linux') throw new Error('BlueZ backend is only available on Linux.');
  const { systemBus, Variant } = loadDbusNext();
  const bus = systemBus();
  const normalizedServiceUuid = formatCanonicalUuid(matchServiceUuid || SOK.serviceUuid);

  try {
    const objectManagerObject = await bus.getProxyObject('org.bluez', '/');
    const objectManager = objectManagerObject.getInterface('org.freedesktop.DBus.ObjectManager');
    const objects = await objectManager.GetManagedObjects();
    const adapterPath = findBluezAdapterPath(objects);
    if (!adapterPath) throw new Error('Could not find a BlueZ adapter via org.bluez ObjectManager.');

    logger('Bluetooth adapter powered on.');
    logger(`BlueZ backend using adapter ${adapterPath}.`);
    const adapterObject = await bus.getProxyObject('org.bluez', adapterPath);
    const adapter = adapterObject.getInterface('org.bluez.Adapter1');
    await setBluezDiscoveryFilter(adapter, Variant, logger);
    await adapter.StartDiscovery();
    logger(`BlueZ discovery started. Waiting up to ${timeoutMs}ms for ${address || namePrefix}.`);

    let device;
    try {
      device = await waitForBluezDevice({
        objectManager,
        initialObjects: objects,
        namePrefix,
        address,
        serviceUuid: normalizedServiceUuid,
        timeoutMs,
        logger
      });
    } finally {
      await adapter.StopDiscovery().catch((error) => logger(`Warning: could not stop BlueZ discovery: ${errorMessage(error)}.`));
    }

    logger(`BlueZ connecting to ${device.address || '<unknown address>'} at ${device.path}.`);
    const deviceObject = await bus.getProxyObject('org.bluez', device.path);
    const bluezDevice = deviceObject.getInterface('org.bluez.Device1');
    const deviceProperties = deviceObject.getInterface('org.freedesktop.DBus.Properties');
    if (!(await getBluezBoolean(deviceProperties, 'org.bluez.Device1', 'Connected'))) {
      await withTimeout(bluezDevice.Connect(), connectTimeoutMs, 'BlueZ Device1.Connect()');
    }
    await waitForBluezBooleanProperty(deviceProperties, 'org.bluez.Device1', 'ServicesResolved', true, timeoutMs);
    logger('BlueZ connected and services resolved.');

    const refreshed = await objectManager.GetManagedObjects();
    const characteristics = await buildBluezCharacteristics({ bus, objects: refreshed, devicePath: device.path, logger });
    await characteristics.notify.subscribe();
    logger('Subscribed to SOK notification characteristic fff1 via BlueZ.');

    return {
      peripheral: {
        bluez: true,
        state: 'connected',
        disconnect: async () => {
          await bluezDevice.Disconnect().catch(() => {});
          bus.disconnect();
        }
      },
      notify: characteristics.notify,
      write: characteristics.write,
      device: {
        id: device.path,
        address: device.address,
        addressType: null,
        name: device.name,
        rssi: device.rssi,
        backend: 'bluez'
      }
    };
  } catch (error) {
    bus.disconnect();
    throw error;
  }
}

async function buildBluezCharacteristics({ bus, objects, devicePath, logger }) {
  const byUuid = new Map();

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

async function wrapBluezCharacteristic(bus, path, initialProperties) {
  const object = await bus.getProxyObject('org.bluez', path);
  const characteristic = object.getInterface('org.bluez.GattCharacteristic1');
  const properties = object.getInterface('org.freedesktop.DBus.Properties');
  const emitter = new EventEmitter();
  const flags = Array.isArray(unboxBluezValue(initialProperties.Flags)) ? unboxBluezValue(initialProperties.Flags).map(String) : [];
  let writeQueue = Promise.resolve();

  properties.on('PropertiesChanged', (interfaceName, changed) => {
    if (interfaceName !== 'org.bluez.GattCharacteristic1' || !('Value' in changed)) return;
    emitter.emit('data', Buffer.from(unboxBluezValue(changed.Value) || []));
  });

  return {
    uuid: normalizeUuid(String(unboxBluezValue(initialProperties.UUID) || '')),
    properties: flags,
    read(callback) {
      characteristic.ReadValue({}).then((value) => callback(null, Buffer.from(value)), callback);
    },
    write(data, withoutResponse, callback) {
      const options = withoutResponse ? { type: new (loadDbusNext().Variant)('s', 'command') } : {};
      writeQueue = writeQueue.then(() => writeBluezValueWithRetry(characteristic, [...data], options));
      writeQueue.then(() => callback?.(), callback);
    },
    subscribe(callback) {
      characteristic.StartNotify().then(() => callback?.(), callback);
    },
    on(event, listener) {
      emitter.on(event, listener);
    },
    removeListener(event, listener) {
      emitter.removeListener(event, listener);
    }
  };
}

function loadNoble() {
  if (!nobleModule) nobleModule = requireOptional('@abandonware/noble');
  return nobleModule;
}

function loadDbusNext() {
  try {
    return requireOptional('dbus-next');
  } catch (error) {
    throw new Error(`BlueZ backend requires the "dbus-next" dependency. Run npm install. ${errorMessage(error)}`);
  }
}

function findBluezAdapterPath(objects) {
  for (const [path, interfaces] of Object.entries(objects)) {
    if (interfaces['org.bluez.Adapter1']) return path;
  }
  return null;
}

async function setBluezDiscoveryFilter(adapter, Variant, logger) {
  const filters = [
    { name: 'transport', filter: { Transport: new Variant('s', 'le') } },
    { name: 'duplicates', filter: { DuplicateData: new Variant('b', false) } }
  ];

  for (const { name, filter } of filters) {
    await adapter.SetDiscoveryFilter(filter)
      .then(() => logger(`BlueZ discovery filter applied: ${name}.`))
      .catch((error) => logger(`Warning: could not set BlueZ discovery filter (${name}): ${errorMessage(error)}.`));
  }
}

async function waitForBluezDevice({ objectManager, initialObjects, namePrefix, address, serviceUuid, timeoutMs, logger }) {
  const initialMatch = findBluezDevice(initialObjects, { namePrefix, address, serviceUuid });
  if (initialMatch) return initialMatch;

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const objects = await objectManager.GetManagedObjects();
    const match = findBluezDevice(objects, { namePrefix, address, serviceUuid });
    if (match) {
      logger(`BlueZ matched ${match.name || match.address || match.path}.`);
      return match;
    }
    await delay(500);
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for BlueZ to discover ${address || namePrefix}.`);
}

function findBluezDevice(objects, { namePrefix, address, serviceUuid }) {
  const normalizedAddress = address ? String(address).toUpperCase() : null;
  for (const [path, interfaces] of Object.entries(objects)) {
    const device = interfaces['org.bluez.Device1'];
    if (!device) continue;
    const name = String(unboxBluezValue(device.Name) || unboxBluezValue(device.Alias) || '');
    const deviceAddress = nullableString(unboxBluezValue(device.Address));
    const rssi = nullableNumber(unboxBluezValue(device.RSSI));
    const uuids = Array.isArray(unboxBluezValue(device.UUIDs)) ? unboxBluezValue(device.UUIDs).map((uuid) => String(uuid).toLowerCase()) : [];
    if (normalizedAddress && deviceAddress?.toUpperCase() === normalizedAddress) return { path, address: deviceAddress, name, rssi };
    if (name.startsWith(namePrefix)) return { path, address: deviceAddress, name, rssi };
    if (serviceUuid && uuids.includes(serviceUuid.toLowerCase())) return { path, address: deviceAddress, name, rssi };
  }
  return null;
}

async function getBluezBoolean(properties, interfaceName, propertyName) {
  const value = await properties.Get(interfaceName, propertyName).catch(() => null);
  const unboxed = unboxBluezValue(value);
  return typeof unboxed === 'boolean' ? unboxed : null;
}

async function waitForBluezBooleanProperty(properties, interfaceName, propertyName, expected, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((await getBluezBoolean(properties, interfaceName, propertyName)) === expected) return;
    await delay(250);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for BlueZ ${propertyName}=${expected}.`);
}

async function writeBluezValueWithRetry(characteristic, value, options) {
  let lastError;
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
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

function formatCanonicalUuid(uuid) {
  const compact = normalizeUuid(uuid);
  if (compact.length === 4) return `0000${compact}-0000-1000-8000-00805f9b34fb`;
  if (compact.length !== 32) return String(uuid).toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function normalizeUuid(uuid) {
  const compact = String(uuid || '').toLowerCase().replaceAll('-', '');
  if (compact.length === 32 && compact.startsWith('0000') && compact.endsWith('00001000800000805f9b34fb')) return compact.slice(4, 8);
  return compact;
}

function displayPeripheral(peripheral) {
  const name = peripheral.advertisement?.localName || '<unnamed>';
  return `${name} (${peripheral.address || peripheral.id}, ${peripheral.addressType || 'unknown'}, rssi=${peripheral.rssi})`;
}

function nullableString(value) {
  return typeof value === 'string' && value ? value : null;
}

function nullableNumber(value) {
  return typeof value === 'number' ? value : null;
}

function unboxBluezValue(value) {
  if (value && typeof value === 'object' && 'value' in value) return value.value;
  return value;
}

function isBluezInProgressError(error) {
  const message = errorMessage(error).toLowerCase();
  return message.includes('in progress') || message.includes('inprogress');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  connectToSok,
  disconnectQuietly,
  isBluezAvailable,
  isSokPeripheral,
  readBattery,
  readRegisters,
  shutdownBluetooth
};
