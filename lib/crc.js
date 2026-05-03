'use strict';

function modbusCrc(data) {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const carry = crc & 0x0001;
      crc >>= 1;
      if (carry) crc ^= 0xa001;
    }
  }
  return crc & 0xffff;
}

function appendCrc(data) {
  const body = Buffer.from(data);
  const crc = modbusCrc(body);
  return Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
}

function verifyCrc(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 4) return false;
  const expected = modbusCrc(frame.subarray(0, -2));
  const actual = frame.readUInt16LE(frame.length - 2);
  return expected === actual;
}

module.exports = {
  appendCrc,
  modbusCrc,
  verifyCrc
};
