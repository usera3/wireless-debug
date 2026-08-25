// Modbus RTU CRC16, polynomial 0xA001 (reversed 0x8005)
export function crc16(buf) {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc; // little-endian: low byte first
}

export function appendCrc(payload) {
  const crc = crc16(payload);
  const out = Buffer.alloc(payload.length + 2);
  payload.copy(out);
  out[payload.length]     = crc & 0xff;
  out[payload.length + 1] = (crc >> 8) & 0xff;
  return out;
}

export function verifyCrc(frame) {
  if (frame.length < 3) return false;
  const body = frame.slice(0, -2);
  const crc  = crc16(body);
  return (
    frame[frame.length - 2] === (crc & 0xff) &&
    frame[frame.length - 1] === ((crc >> 8) & 0xff)
  );
}
