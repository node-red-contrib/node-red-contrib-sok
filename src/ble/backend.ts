import type { RegisterReadName } from '../constants.js';
import type { RegisterBlock, SokDecodedSnapshot } from '../modbus.js';

export type BluetoothBackendName = 'auto' | 'bluez' | 'noble';
export type ResolvedBluetoothBackendName = Exclude<BluetoothBackendName, 'auto'>;
export type Logger = (message: string) => void;

export interface SokDiscoveredDevice {
  id: string;
  name: string | null;
  address: string | null;
  addressType?: string | null;
  rssi: number | null;
  backend: ResolvedBluetoothBackendName;
}

export interface SokBatteryReading {
  device: SokDiscoveredDevice;
  timestamp: string;
  decoded: SokDecodedSnapshot;
}

export interface ReadOptions {
  bluetooth?: BluetoothBackendName;
  namePrefix?: string;
  deviceName?: string;
  reads?: RegisterReadName[] | string;
  timeoutMs?: number;
  responseTimeoutMs?: number;
  connectTimeoutMs?: number;
  scanServiceUuid?: string | null;
  matchServiceUuid?: string | null;
  logger?: Logger;
}

export interface DiscoverOptions {
  bluetooth?: BluetoothBackendName;
  namePrefix?: string;
  deviceName?: string;
  timeoutMs?: number;
  scanServiceUuid?: string | null;
  matchServiceUuid?: string | null;
  logger?: Logger;
}

export interface ResolvedDiscoverOptions {
  namePrefix: string;
  deviceName: string | null;
  timeoutMs: number;
  scanServiceUuid: string | null;
  matchServiceUuid: string | null;
  logger: Logger;
}

export interface ResolvedConnectOptions {
  device: SokDiscoveredDevice;
  timeoutMs: number;
  connectTimeoutMs: number;
  logger: Logger;
}

export interface SokCharacteristic {
  uuid: string;
  properties: string[];
  write(data: Buffer, withoutResponse?: boolean): Promise<void>;
  subscribe(): Promise<void>;
  onData(listener: (data: Buffer) => void): void;
  removeDataListener(listener: (data: Buffer) => void): void;
}

export interface SokSession {
  device: SokDiscoveredDevice;
  notify: SokCharacteristic;
  write: SokCharacteristic;
  disconnect(): Promise<void>;
}

export interface BluetoothBackend {
  name: ResolvedBluetoothBackendName;
  isAvailable(logger?: Logger): Promise<boolean>;
  discover(options: ResolvedDiscoverOptions): Promise<SokDiscoveredDevice[]>;
  connect(options: ResolvedConnectOptions): Promise<SokSession>;
  shutdown(): Promise<void>;
}

export type RegisterBlocks = Partial<Record<RegisterReadName, RegisterBlock>>;
