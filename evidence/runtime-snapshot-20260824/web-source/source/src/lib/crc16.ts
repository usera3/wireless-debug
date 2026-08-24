// Modbus RTU CRC16，多项式 0xA001（反转 0x8005）
export function crc16(buf: Uint8Array): number {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc; // low byte first (little-endian) matches Modbus
}

export function appendCrc(payload: Uint8Array): Uint8Array {
  const crc = crc16(payload);
  const out = new Uint8Array(payload.length + 2);
  out.set(payload);
  out[payload.length] = crc & 0xff;            // CRC low byte
  out[payload.length + 1] = (crc >> 8) & 0xff; // CRC high byte
  return out;
}

export function verifyCrc(frame: Uint8Array): boolean {
  if (frame.length < 3) return false;
  const body = frame.slice(0, -2);
  const crc = crc16(body);
  return (
    frame[frame.length - 2] === (crc & 0xff) &&
    frame[frame.length - 1] === ((crc >> 8) & 0xff)
  );
}
