export { READS, SOK, type RegisterReadName } from './constants.js';
export { appendCrc, modbusCrc, verifyCrc } from './crc.js';
export { buildReadHoldingRegisters, decodeSnapshot, expectedResponseLength, parseReadResponse, type SokDecodedSnapshot, type SokLimits, type SokTelemetry } from './modbus.js';
export { connectBatteryDevice, connectBatteryReaders, discoverBatteries, normalizeReads, readBatteries, readBatteryDevice, readBatterySession, readRegisters, shutdownBluetooth, type SokBatteryReader } from './reader.js';
export { matchesSokDevice } from './ble/utils.js';
export type { BluetoothBackendName, DiscoverOptions, ReadOptions, SokBatteryReading, SokDiscoveredDevice, SokSession } from './ble/backend.js';
