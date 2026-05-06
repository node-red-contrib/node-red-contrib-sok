import { READS, SOK, type RegisterReadName } from './constants.js';
import { buildReadHoldingRegisters, decodeSnapshot, expectedResponseLength, parseReadResponse } from './modbus.js';
import { bluezBackend } from './ble/bluez.js';
import { nobleBackend } from './ble/noble.js';
import { displayDevice } from './ble/utils.js';
import type {
  BluetoothBackend,
  BluetoothBackendName,
  DiscoverOptions,
  ReadOptions,
  RegisterBlocks,
  ResolvedBluetoothBackendName,
  SokBatteryReading,
  SokDiscoveredDevice,
  SokSession
} from './ble/backend.js';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 5000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15000;

export interface SokBatteryReader {
  device: SokDiscoveredDevice;
  read(reads?: RegisterReadName[] | string): Promise<SokBatteryReading>;
  disconnect(): Promise<void>;
}

export async function discoverBatteries(options: DiscoverOptions = {}): Promise<SokDiscoveredDevice[]> {
  const logger = options.logger || (() => {});
  const bluetooth = options.bluetooth || 'auto';
  const backend = await selectBluetoothBackend(options.bluetooth || 'auto', logger);
  try {
    return await backend.discover({
      namePrefix: options.namePrefix || SOK.advertisedNamePrefix,
      deviceName: options.deviceName || null,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      scanServiceUuid: options.scanServiceUuid ?? null,
      matchServiceUuid: options.matchServiceUuid || SOK.serviceUuid,
      logger
    });
  } catch (error) {
    if (bluetooth === 'auto' && isBluetoothUnavailableError(error)) {
      logger(`No usable Bluetooth backend found: ${error instanceof Error ? error.message : String(error)}.`);
      return [];
    }
    throw error;
  }
}

export async function readBatteries(options: ReadOptions = {}): Promise<SokBatteryReading[]> {
  const logger = options.logger || (() => {});
  const devices = await discoverBatteries({ ...options, logger });
  const readings: SokBatteryReading[] = [];

  for (const device of devices) {
    logger(`Reading ${displayDevice(device)}.`);
    readings.push(await readBatteryDevice(device, { ...options, logger }));
  }

  return readings;
}

export async function readBatteryDevice(device: SokDiscoveredDevice, options: ReadOptions = {}): Promise<SokBatteryReading> {
  const reader = await connectBatteryDevice(device, options);
  try {
    return await reader.read();
  } finally {
    await reader.disconnect().catch(() => {});
  }
}

export async function connectBatteryReaders(options: ReadOptions = {}): Promise<SokBatteryReader[]> {
  const logger = options.logger || (() => {});
  const devices = await discoverBatteries({ ...options, logger });
  const readers: SokBatteryReader[] = [];

  try {
    for (const device of devices) {
      logger(`Connecting ${displayDevice(device)}.`);
      readers.push(await connectBatteryDevice(device, { ...options, logger }));
    }
    return readers;
  } catch (error) {
    await Promise.all(readers.map((reader) => reader.disconnect().catch(() => {})));
    throw error;
  }
}

export async function connectBatteryDevice(device: SokDiscoveredDevice, options: ReadOptions = {}): Promise<SokBatteryReader> {
  const logger = options.logger || (() => {});
  const backend = backendForDevice(device);
  const session = await backend.connect({
    device,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    connectTimeoutMs: options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS,
    logger
  });

  let disconnected = false;

  return {
    device: session.device,
    read: (reads) => readBatterySession(session, { ...options, reads: reads ?? options.reads, logger }),
    disconnect: async () => {
      if (disconnected) return;
      disconnected = true;
      await session.disconnect();
    }
  };
}

export async function readBatterySession(session: SokSession, options: ReadOptions = {}): Promise<SokBatteryReading> {
  const logger = options.logger || (() => {});
  const blocks: RegisterBlocks = {};
  for (const read of normalizeReads(options.reads)) {
    logger(`Reading SOK ${read.name} registers from 0x${read.start.toString(16)} (${read.count}).`);
    blocks[read.name] = await readRegisters(session, read, {
      responseTimeoutMs: options.responseTimeoutMs || DEFAULT_RESPONSE_TIMEOUT_MS,
      logger
    });
  }

  return {
    device: session.device,
    timestamp: new Date().toISOString(),
    decoded: decodeSnapshot(blocks)
  };
}

export function readRegisters(
  session: SokSession,
  read: (typeof READS)[RegisterReadName],
  { responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS, logger = () => {} }: { responseTimeoutMs?: number; logger?: (message: string) => void } = {}
) {
  const request = buildReadHoldingRegisters(read.start, read.count);
  return new Promise<ReturnType<typeof parseReadResponse>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let timeout: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      session.notify.removeDataListener(onData);
    };

    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onData = (data: Buffer) => {
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

    session.notify.onData(onData);
    logger(`Writing SOK request ${request.toString('hex')}.`);
    session.write.write(request, true).catch(fail);
  });
}

export async function shutdownBluetooth(): Promise<void> {
  await Promise.all([nobleBackend.shutdown(), bluezBackend.shutdown()]);
}

export function normalizeReads(reads: RegisterReadName[] | string | undefined): Array<(typeof READS)[RegisterReadName]> {
  if (!reads) return [READS.telemetry, READS.limits, READS.status];
  const names = Array.isArray(reads) ? reads : String(reads).split(',');
  return names.map((name) => {
    const key = String(name).trim() as RegisterReadName;
    if (!READS[key]) throw new Error(`Unknown SOK read "${key}". Known reads: ${Object.keys(READS).join(', ')}.`);
    return READS[key];
  });
}

async function selectBluetoothBackend(bluetooth: BluetoothBackendName, logger: (message: string) => void): Promise<BluetoothBackend> {
  if (bluetooth === 'bluez') return bluezBackend;
  if (bluetooth === 'noble') return nobleBackend;
  if (await bluezBackend.isAvailable(logger)) return bluezBackend;
  return nobleBackend;
}

function backendForDevice(device: SokDiscoveredDevice): BluetoothBackend {
  const backends: Record<ResolvedBluetoothBackendName, BluetoothBackend> = {
    bluez: bluezBackend,
    noble: nobleBackend
  };
  return backends[device.backend];
}

function isBluetoothUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('bluetooth adapter state is unsupported') || message.includes('no compatible bluetooth') || message.includes('not available on');
}
