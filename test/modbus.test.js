'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildReadHoldingRegisters, decodeSnapshot, parseReadResponse } = require('../lib/modbus');

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
  assert.equal(decoded.telemetry.capacityAh, 314);
  assert.deepEqual(decoded.telemetry.cellVoltages, [3.291, 3.292, 3.291, 3.294]);
  assert.equal(decoded.telemetry.model, 'XT4S200A-E167-2.6');
  assert.equal(decoded.telemetry.serial, 'E1671224440012A');
});
