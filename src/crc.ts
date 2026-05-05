export function modbusCrc(data: Buffer): number {
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

export function appendCrc(data: Buffer): Buffer {
  const body = Buffer.from(data);
  const crc = modbusCrc(body);
  return Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
}

export function verifyCrc(frame: Buffer): boolean {
  if (!Buffer.isBuffer(frame) || frame.length < 4) return false;
  const expected = modbusCrc(frame.subarray(0, -2));
  const actual = frame.readUInt16LE(frame.length - 2);
  return expected === actual;
}
