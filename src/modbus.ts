import { appendCrc, verifyCrc } from './crc.js';

export interface RegisterBlock {
  start: number;
  count: number;
  values: number[];
  registers: Record<string, number>;
  raw: string;
}

export interface SokTelemetry {
  currentA?: number;
  voltageV?: number;
  stateOfChargePercent?: number;
  capacityAh?: number;
  fullCapacityAh?: number;
  remainingCapacityAh?: number;
  ratedCapacityAh?: number;
  temperatureC?: number;
  temperaturesC?: SokTemperatures;
  cellCount?: number;
  cellVoltages?: number[];
  minCellVoltageV?: number;
  maxCellVoltageV?: number;
  model?: string;
  serial?: string;
}

export interface SokTemperatures {
  t1?: number;
  t2?: number;
  mcg?: number;
  environment?: number;
}

export interface SokParameterLimits {
  overCellVoltageMv?: number;
  underCellVoltageMv?: number;
  overTotalVoltageV?: number;
  underTotalVoltageV?: number;
  overChargeCurrentA?: number;
  overDischargeCurrentA?: number;
  chargeOverTemperatureC?: number;
  dischargeOverTemperatureC?: number;
  chargeUnderTemperatureC?: number;
  dischargeUnderTemperatureC?: number;
  environmentOverTemperatureC?: number;
  environmentUnderTemperatureC?: number;
  mosOverTemperatureC?: number;
  shortCircuitCurrentA?: number;
}

export interface SokLimits {
  chargeVoltageV?: number;
  floatVoltageV?: number;
  overVoltageV?: number;
  overVoltageRecoveryV?: number;
  underVoltageV?: number;
  parameters?: SokParameterLimits;
}

export interface SokDecodedSnapshot {
  telemetry?: SokTelemetry;
  limits?: SokLimits;
  statusWord?: number;
}

export function buildReadHoldingRegisters(start: number, count: number, unit = 0x01): Buffer {
  const request = Buffer.alloc(6);
  request[0] = unit;
  request[1] = 0x03;
  request.writeUInt16BE(start, 2);
  request.writeUInt16BE(count, 4);
  return appendCrc(request);
}

export function expectedResponseLength(buffer: Buffer): number | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) return null;
  if (buffer[1] !== undefined && (buffer[1] & 0x80)) return 5;
  const byteCount = buffer[2];
  return byteCount === undefined ? null : 3 + byteCount + 2;
}

export function parseReadResponse(frame: Buffer, start: number): RegisterBlock {
  if (!verifyCrc(frame)) {
    throw new Error(`Invalid Modbus CRC for response ${frame.toString('hex')}.`);
  }
  const functionCode = frame[1];
  if (functionCode === undefined) throw new Error('Invalid Modbus response.');
  if (functionCode & 0x80) {
    const exception = frame[2] ?? 0;
    throw new Error(`SOK returned Modbus exception 0x${exception.toString(16).padStart(2, '0')}.`);
  }
  if (functionCode !== 0x03) throw new Error(`Unsupported Modbus function 0x${functionCode.toString(16)}.`);

  const byteCount = frame[2];
  if (byteCount === undefined) throw new Error('Invalid Modbus byte count.');
  const data = frame.subarray(3, 3 + byteCount);
  if (data.length !== byteCount || data.length % 2 !== 0) throw new Error(`Invalid register byte count ${byteCount}.`);

  const registers: Record<string, number> = {};
  const values: number[] = [];
  for (let offset = 0; offset < data.length; offset += 2) {
    const address = start + offset / 2;
    const value = data.readUInt16BE(offset);
    registers[toAddress(address)] = value;
    values.push(value);
  }

  return {
    start,
    count: values.length,
    values,
    registers,
    raw: frame.toString('hex')
  };
}

export function decodeSnapshot(registerBlocks: Partial<Record<'telemetry' | 'limits' | 'status', RegisterBlock>>): SokDecodedSnapshot {
  const telemetry = registerBlocks.telemetry;
  const limits = registerBlocks.limits;
  const decoded: SokDecodedSnapshot = {};

  if (telemetry) decoded.telemetry = decodeTelemetry(telemetry.registers);
  if (limits) decoded.limits = decodeLimits(limits.registers);
  const statusWord = registerBlocks.status?.values[0];
  if (statusWord !== undefined) decoded.statusWord = statusWord;

  return decoded;
}

function decodeTelemetry(registers: Record<string, number>): SokTelemetry {
  const model = readAscii(registers, 0x00dc, 10);
  const serial = readAscii(registers, 0x00e6, 21);
  const cellCount = readUnsigned(registers, 0x0091);
  const cellVoltages = readCellVoltages(registers, cellCount);
  const temperaturesC = readTemperaturesC(registers);

  return compactObject({
    currentA: scaleSigned(registers, 0x0080, 100),
    voltageV: scaleUnsigned(registers, 0x0081, 100),
    stateOfChargePercent: readUnsigned(registers, 0x0082),
    capacityAh: scaleUnsigned(registers, 0x0085, 100),
    fullCapacityAh: scaleUnsigned(registers, 0x0085, 100),
    remainingCapacityAh: scaleUnsigned(registers, 0x0084, 100),
    ratedCapacityAh: scaleUnsigned(registers, 0x0086, 100),
    temperatureC: temperaturesC.t1,
    temperaturesC,
    cellCount,
    cellVoltages,
    minCellVoltageV: cellVoltages.length ? Math.min(...cellVoltages) : undefined,
    maxCellVoltageV: cellVoltages.length ? Math.max(...cellVoltages) : undefined,
    model,
    serial
  });
}

function readTemperaturesC(registers: Record<string, number>): SokTemperatures {
  return compactObject({
    t1: scaleSigned(registers, 0x0095, 10),
    t2: scaleSigned(registers, 0x0096, 10),
    mcg: scaleSigned(registers, 0x0097, 10),
    environment: scaleSigned(registers, 0x0098, 10)
  });
}

function decodeLimits(registers: Record<string, number>): SokLimits {
  return compactObject({
    chargeVoltageV: scaleUnsigned(registers, 0x0401, 100),
    floatVoltageV: scaleUnsigned(registers, 0x0402, 100),
    overVoltageV: scaleUnsigned(registers, 0x0404, 100),
    overVoltageRecoveryV: scaleUnsigned(registers, 0x0405, 100),
    underVoltageV: scaleUnsigned(registers, 0x0406, 100),
    parameters: decodeParameterLimits(registers)
  });
}

function decodeParameterLimits(registers: Record<string, number>): SokParameterLimits {
  return compactObject({
    overCellVoltageMv: readUnsigned(registers, 0x0405),
    underCellVoltageMv: readUnsigned(registers, 0x040d),
    overTotalVoltageV: scaleUnsigned(registers, 0x0401, 100),
    underTotalVoltageV: scaleUnsigned(registers, 0x0409, 100),
    overChargeCurrentA: readUnsigned(registers, 0x0413),
    overDischargeCurrentA: readUnsigned(registers, 0x0418),
    chargeOverTemperatureC: scaleSigned(registers, 0x041f, 10),
    dischargeOverTemperatureC: scaleSigned(registers, 0x0422, 10),
    chargeUnderTemperatureC: scaleSigned(registers, 0x0425, 10),
    dischargeUnderTemperatureC: scaleSigned(registers, 0x0428, 10),
    environmentOverTemperatureC: scaleSigned(registers, 0x042e, 10),
    environmentUnderTemperatureC: scaleSigned(registers, 0x0431, 10),
    mosOverTemperatureC: scaleSigned(registers, 0x042b, 10),
    shortCircuitCurrentA: readUnsigned(registers, 0x041c)
  });
}

function readCellVoltages(registers: Record<string, number>, cellCount: number | undefined): number[] {
  const count = cellCount !== undefined && Number.isInteger(cellCount) && cellCount > 0 ? Math.min(cellCount, 32) : 4;
  const primary = readVoltageRun(registers, 0x009b, count);
  if (primary.length) return primary;
  return readVoltageRun(registers, 0x0092, count);
}

function readVoltageRun(registers: Record<string, number>, start: number, count: number): number[] {
  const voltages: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = readUnsigned(registers, start + index);
    if (value === undefined || value === 0xffff || value === 0x8000 || value < 1000) break;
    voltages.push(round(value / 1000, 3));
  }
  return voltages;
}

function readAscii(registers: Record<string, number>, start: number, maxRegisters: number): string | undefined {
  const bytes: number[] = [];
  for (let offset = 0; offset < maxRegisters; offset += 1) {
    const value = readUnsigned(registers, start + offset);
    if (value === undefined || value === 0xffff) break;
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  const text = Buffer.from(bytes).toString('ascii').replaceAll('\0', '').trim();
  return text || undefined;
}

function readUnsigned(registers: Record<string, number>, address: number): number | undefined {
  return registers[toAddress(address)];
}

function readSigned(registers: Record<string, number>, address: number): number | undefined {
  const value = readUnsigned(registers, address);
  if (value === undefined) return undefined;
  return value & 0x8000 ? value - 0x10000 : value;
}

function scaleUnsigned(registers: Record<string, number>, address: number, divisor: number): number | undefined {
  const value = readUnsigned(registers, address);
  return value === undefined || value === 0xffff ? undefined : round(value / divisor, 3);
}

function scaleSigned(registers: Record<string, number>, address: number, divisor: number): number | undefined {
  const value = readSigned(registers, address);
  return value === undefined || value === -1 ? undefined : round(value / divisor, 3);
}

function toAddress(address: number): string {
  return `0x${address.toString(16).padStart(4, '0')}`;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && !(Array.isArray(entry) && entry.length === 0))) as T;
}
