'use strict';

const { appendCrc, verifyCrc } = require('./crc');

function buildReadHoldingRegisters(start, count, unit = 0x01) {
  const request = Buffer.alloc(6);
  request[0] = unit;
  request[1] = 0x03;
  request.writeUInt16BE(start, 2);
  request.writeUInt16BE(count, 4);
  return appendCrc(request);
}

function expectedResponseLength(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) return null;
  if (buffer[1] & 0x80) return 5;
  return 3 + buffer[2] + 2;
}

function parseReadResponse(frame, start) {
  if (!verifyCrc(frame)) {
    throw new Error(`Invalid Modbus CRC for response ${frame.toString('hex')}.`);
  }
  if (frame[1] & 0x80) {
    throw new Error(`SOK returned Modbus exception 0x${frame[2].toString(16).padStart(2, '0')}.`);
  }
  if (frame[1] !== 0x03) throw new Error(`Unsupported Modbus function 0x${frame[1].toString(16)}.`);
  const byteCount = frame[2];
  const data = frame.subarray(3, 3 + byteCount);
  if (data.length !== byteCount || data.length % 2 !== 0) throw new Error(`Invalid register byte count ${byteCount}.`);

  const registers = {};
  const values = [];
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

function decodeSnapshot(registerBlocks) {
  const telemetry = registerBlocks.telemetry;
  const limits = registerBlocks.limits;
  const decoded = {};

  if (telemetry) {
    decoded.telemetry = decodeTelemetry(telemetry.registers);
  }
  if (limits) {
    decoded.limits = decodeLimits(limits.registers);
  }
  if (registerBlocks.status?.values?.length) {
    decoded.statusWord = registerBlocks.status.values[0];
  }

  return decoded;
}

function decodeTelemetry(registers) {
  const model = readAscii(registers, 0x00dc, 10);
  const serial = readAscii(registers, 0x00e6, 21);
  const cellCount = readUnsigned(registers, 0x0091);
  const cellVoltages = readCellVoltages(registers, cellCount);

  return compactObject({
    currentA: scaleSigned(registers, 0x0080, 100),
    voltageV: scaleUnsigned(registers, 0x0081, 100),
    stateOfChargePercent: readUnsigned(registers, 0x0082),
    capacityAh: scaleUnsigned(registers, 0x0086, 100),
    temperatureC: scaleSigned(registers, 0x0090, 1),
    cellCount,
    cellVoltages,
    minCellVoltageV: cellVoltages.length ? Math.min(...cellVoltages) : undefined,
    maxCellVoltageV: cellVoltages.length ? Math.max(...cellVoltages) : undefined,
    model,
    serial
  });
}

function decodeLimits(registers) {
  return compactObject({
    chargeVoltageV: scaleUnsigned(registers, 0x0401, 100),
    floatVoltageV: scaleUnsigned(registers, 0x0402, 100),
    overVoltageV: scaleUnsigned(registers, 0x0404, 100),
    overVoltageRecoveryV: scaleUnsigned(registers, 0x0405, 100),
    underVoltageV: scaleUnsigned(registers, 0x0406, 100)
  });
}

function readCellVoltages(registers, cellCount) {
  const count = Number.isInteger(cellCount) && cellCount > 0 ? Math.min(cellCount, 32) : 4;
  const primary = readVoltageRun(registers, 0x009b, count);
  if (primary.length) return primary;
  return readVoltageRun(registers, 0x0092, count);
}

function readVoltageRun(registers, start, count) {
  const voltages = [];
  for (let index = 0; index < count; index += 1) {
    const value = readUnsigned(registers, start + index);
    if (value === undefined || value === 0xffff || value === 0x8000 || value < 1000) break;
    voltages.push(round(value / 1000, 3));
  }
  return voltages;
}

function readAscii(registers, start, maxRegisters) {
  const bytes = [];
  for (let offset = 0; offset < maxRegisters; offset += 1) {
    const value = readUnsigned(registers, start + offset);
    if (value === undefined || value === 0xffff) break;
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  const text = Buffer.from(bytes).toString('ascii').replace(/\0/g, '').trim();
  return text || undefined;
}

function readUnsigned(registers, address) {
  return registers[toAddress(address)];
}

function readSigned(registers, address) {
  const value = readUnsigned(registers, address);
  if (value === undefined) return undefined;
  return value & 0x8000 ? value - 0x10000 : value;
}

function scaleUnsigned(registers, address, divisor) {
  const value = readUnsigned(registers, address);
  return value === undefined || value === 0xffff ? undefined : round(value / divisor, 3);
}

function scaleSigned(registers, address, divisor) {
  const value = readSigned(registers, address);
  return value === undefined || value === -1 ? undefined : round(value / divisor, 3);
}

function toAddress(address) {
  return `0x${address.toString(16).padStart(4, '0')}`;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && !(Array.isArray(entry) && entry.length === 0)));
}

module.exports = {
  buildReadHoldingRegisters,
  decodeSnapshot,
  expectedResponseLength,
  parseReadResponse,
  verifyCrc
};
