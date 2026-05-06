import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReadHoldingRegisters, decodeSnapshot, matchesSokDevice, normalizeReads, parseReadResponse } from '../dist/index.js';
import { parseIntervalMs, toReadOptions } from '../dist/cli.js';

test('builds SOK Modbus read requests from the capture', () => {
  assert.equal(buildReadHoldingRegisters(0x0080, 0x007a).toString('hex'), '01030080007ac5c1');
  assert.equal(buildReadHoldingRegisters(0x0902, 0x0001).toString('hex'), '0103090200012656');
  assert.equal(buildReadHoldingRegisters(0x0401, 0x0031).toString('hex'), '010304010031d4ee');
});

test('parses and decodes captured telemetry response', () => {
  const frame = Buffer.from(
    '0103f401280524003c00644b887eeb7aa8004e00000000000000000126000500000000001d00040cde0cdb000200fc00fb01200135ffffffff0cdb0cdc0cdb0cdeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00fb00fc800080008000800080008000ffffffffffffffffffff00000000000000000000000000000000001d0524003c0000ffffffffffffffffffffffffffffffff58543453323030412d453136372d322e360000004531363731323234343430303132412020202020202020202020202020202020202020202020202026f2',
    'hex'
  );
  const block = parseReadResponse(frame, 0x0080);
  const decoded = decodeSnapshot({ telemetry: block });

  assert.equal(block.count, 122);
  assert.equal(decoded.telemetry.voltageV, 13.16);
  assert.equal(decoded.telemetry.currentA, 2.96);
  assert.equal(decoded.telemetry.stateOfChargePercent, 60);
  assert.equal(decoded.telemetry.capacityAh, 324.91);
  assert.equal(decoded.telemetry.fullCapacityAh, 324.91);
  assert.equal(decoded.telemetry.remainingCapacityAh, 193.36);
  assert.equal(decoded.telemetry.ratedCapacityAh, 314);
  assert.equal(decoded.telemetry.temperatureC, 25.2);
  assert.deepEqual(decoded.telemetry.temperaturesC, {
    t1: 25.2,
    t2: 25.1,
    mcg: 28.8,
    environment: 30.9
  });
  assert.deepEqual(decoded.telemetry.cellVoltages, [3.291, 3.292, 3.291, 3.294]);
  assert.equal(decoded.telemetry.model, 'XT4S200A-E167-2.6');
  assert.equal(decoded.telemetry.serial, 'E1671224440012A');
});

test('decodes app-visible fields from live telemetry response', () => {
  const frame = Buffer.from(
    '0103f4fe7e0532006200647c797eeb7aa8004f0000000000000000020e000500000000ffda00040cff0cff000200ce00cc00e700ffffffffff0cff0cff0cff0cffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00cc00ce800080008000800080008000ffffffffffffffffffff00000000000000000000000000000000ffda053200620000ffffffffffffffffffffffffffffffff58543453323030412d453136372d322e3600000045313637313232343434303031324120202020202020202020202020202020202020202020202020c9ab',
    'hex'
  );
  const block = parseReadResponse(frame, 0x0080);
  const decoded = decodeSnapshot({ telemetry: block });

  assert.equal(decoded.telemetry.voltageV, 13.3);
  assert.equal(decoded.telemetry.currentA, -3.86);
  assert.equal(decoded.telemetry.stateOfChargePercent, 98);
  assert.equal(Math.round(decoded.telemetry.fullCapacityAh), 325);
  assert.equal(Math.round(decoded.telemetry.remainingCapacityAh), 319);
  assert.equal(decoded.telemetry.ratedCapacityAh, 314);
  assert.deepEqual(decoded.telemetry.cellVoltages, [3.327, 3.327, 3.327, 3.327]);
  assert.deepEqual(decoded.telemetry.temperaturesC, {
    t1: 20.6,
    t2: 20.4,
    mcg: 23.1,
    environment: 25.5
  });
  assert.equal(decoded.telemetry.temperaturesF, undefined);
});

test('decodes app-visible parameter limits without exposing raw debug maps', () => {
  const frame = Buffer.from(
    '01036205dc056400140e740ed80d7a0014041003e804b0001409c408fc0c1c0014ffffffff00d200dc006400fa012c00ff01040258032003e804b0001e0258028a0226028a02bc02580000ffce0000ff6aff38ff6a041a044c0384035203b60320ff6aff38db2b',
    'hex'
  );
  const block = parseReadResponse(frame, 0x0401);
  const decoded = decodeSnapshot({ limits: block });

  assert.deepEqual(decoded.limits.parameters, {
    overCellVoltageMv: 3800,
    underCellVoltageMv: 2300,
    overTotalVoltageV: 15,
    underTotalVoltageV: 10,
    overChargeCurrentA: 220,
    overDischargeCurrentA: 260,
    chargeOverTemperatureC: 65,
    dischargeOverTemperatureC: 70,
    chargeUnderTemperatureC: -5,
    dischargeUnderTemperatureC: -20,
    environmentOverTemperatureC: 95,
    environmentUnderTemperatureC: -20,
    mosOverTemperatureC: 110,
    shortCircuitCurrentA: 1200
  });
  assert.equal(Object.hasOwn(decoded, 'registers'), false);
  assert.equal(Object.hasOwn(decoded, 'frames'), false);
});

test('matches devices by exact name before prefix or service fallback', () => {
  assert.equal(matchesSokDevice({ name: 'SK12V324PH00057' }, { namePrefix: 'SK', deviceName: 'SK12V324PH00057' }), true);
  assert.equal(matchesSokDevice({ name: 'SK12V324PH00057' }, { namePrefix: 'SK', deviceName: 'SK12V324PH00058' }), false);
  assert.equal(matchesSokDevice({ name: 'SK12V324PH00057' }, { namePrefix: 'SK' }), true);
  assert.equal(matchesSokDevice({ name: 'Other', serviceUuids: ['0000fff0-0000-1000-8000-00805f9b34fb'] }, { namePrefix: 'SK', serviceUuid: 'fff0' }), true);
});

test('normalizes read groups and rejects unknown groups', () => {
  assert.deepEqual(
    normalizeReads('telemetry,status').map((read) => read.name),
    ['telemetry', 'status']
  );
  assert.throws(() => normalizeReads('bogus'), /Unknown SOK read/);
});

test('maps CLI globals and optional device name to read options', () => {
  const options = toReadOptions({ bluetooth: 'noble', namePrefix: 'SK', reads: 'telemetry', debug: false }, 'SK12V324PH00057');
  assert.equal(options.bluetooth, 'noble');
  assert.equal(options.namePrefix, 'SK');
  assert.equal(options.reads, 'telemetry');
  assert.equal(options.deviceName, 'SK12V324PH00057');
});

test('parses CLI interval option in seconds', () => {
  assert.equal(parseIntervalMs(undefined), null);
  assert.equal(parseIntervalMs('5'), 5000);
  assert.equal(parseIntervalMs('0.5'), 500);
  assert.throws(() => parseIntervalMs('0'), /greater than 0/);
  assert.throws(() => parseIntervalMs('soon'), /greater than 0/);
});
