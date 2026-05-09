import { WebSocketServer } from 'ws';
import { appendCrc, verifyCrc, crc16 } from './crc16.mjs';

const PORT     = 8765;
const SLAVE    = 0xff;
const REG_SIZE = 512; // 16-bit Modbus holding registers

const FRAME_HEADER = Buffer.from([0xff, 0x77, 0xaa, 0x55]);
const FRAME_FOOTER = Buffer.from([0xff, 0x77, 0xaa, 0x55]);

// ── per-connection state ──────────────────────────────────────────────────────
function makeState() {
  return {
    regs:        new Uint16Array(REG_SIZE), // Modbus register bank (all zero)
    oscChannels: [],                         // [{ch, type, addr}, ...]
    oscRunning:  false,
    oscTimer:    null,
    frameLen:    130,   // 4-header + 120-data + 2-crc + 4-footer
    dataAreaLen: 120,
    sampleRate:  6000,  // Hz
    t:           0,     // sample counter used for sine generation
  };
}

// ── oscilloscope frame builder ────────────────────────────────────────────────
// Each channel emits a sine wave at freq = ch_index * 0.5 Hz.
// Type 0x03 (INT32/Float) occupies 4 bytes; all other types occupy 2 bytes.
function buildOscFrame(state) {
  const dataArea = Buffer.alloc(state.dataAreaLen, 0);
  let offset = 0;
  for (const ch of state.oscChannels) {
    const freq      = ch.ch * 0.5;   // ch1 → 0.5 Hz, ch2 → 1.0 Hz …
    const amplitude = 10000;
    const val       = Math.round(
      amplitude * Math.sin(2 * Math.PI * freq * state.t / state.sampleRate)
    );
    if (ch.type === 0x03) {
      if (offset + 4 > state.dataAreaLen) break;
      dataArea.writeInt32BE(val, offset);
      offset += 4;
    } else {
      if (offset + 2 > state.dataAreaLen) break;
      dataArea.writeInt16BE(Math.max(-32768, Math.min(32767, val)), offset);
      offset += 2;
    }
  }
  state.t++;

  const crcVal = crc16(dataArea);
  const crcBuf = Buffer.from([crcVal & 0xff, (crcVal >> 8) & 0xff]);
  return Buffer.concat([FRAME_HEADER, dataArea, crcBuf, FRAME_FOOTER]);
}

// ── request dispatcher ────────────────────────────────────────────────────────
function handleFrame(ws, state, frame) {
  const fc = frame[1];
  console.log(`[rx] FC=0x${fc.toString(16).padStart(2, '0')} ${frame.toString('hex')}`);

  // 0x03 — Read holding registers
  if (fc === 0x03) {
    const startAddr = (frame[2] << 8) | frame[3];
    const count     = (frame[4] << 8) | frame[5];
    const byteCount = count * 2;
    const resp      = Buffer.alloc(3 + byteCount);
    resp[0] = SLAVE; resp[1] = 0x03; resp[2] = byteCount;
    for (let i = 0; i < count; i++) {
      const v = state.regs[startAddr + i] ?? 0;
      resp[3 + i * 2] = (v >> 8) & 0xff;
      resp[4 + i * 2] = v & 0xff;
    }
    ws.send(appendCrc(resp));

  // 0x06 — Write single holding register (echo)
  } else if (fc === 0x06) {
    const addr  = (frame[2] << 8) | frame[3];
    const value = (frame[4] << 8) | frame[5];
    state.regs[addr] = value;
    ws.send(frame);

  // 0x10 — Write multiple holding registers
  } else if (fc === 0x10) {
    const startAddr = (frame[2] << 8) | frame[3];
    const regCount  = (frame[4] << 8) | frame[5];
    const byteCount = frame[6];
    for (let i = 0; i < regCount; i++) {
      state.regs[startAddr + i] = (frame[7 + i * 2] << 8) | frame[8 + i * 2];
    }
    const resp = Buffer.alloc(7);
    resp[0] = SLAVE; resp[1] = 0x10;
    resp[2] = frame[2]; resp[3] = frame[3]; // echo startAddr
    resp[4] = frame[4]; resp[5] = frame[5]; // echo regCount
    resp[6] = byteCount;
    ws.send(appendCrc(resp));

  // 0x04 — Read input register (oscilloscope config queries)
  } else if (fc === 0x04) {
    const regAddr = (frame[2] << 8) | frame[3];
    let value;
    if      (regAddr === 0x0000) value = state.frameLen;   // 130
    else if (regAddr === 0x0001) value = 12;                // max channels
    else if (regAddr === 0x0002) value = state.sampleRate;  // 6000 Hz
    else {
      console.warn(`[rx] FC04 unknown regAddr 0x${regAddr.toString(16)}`);
      return;
    }
    const resp = Buffer.from([SLAVE, 0x04, 0x02, (value >> 8) & 0xff, value & 0xff]);
    ws.send(appendCrc(resp));

  // 0x75 — Set oscilloscope channel
  } else if (fc === 0x75) {
    const ch   = frame[2];
    const type = frame[3];
    const addr = (frame[4] << 8) | frame[5];
    state.oscChannels.push({ ch, type, addr });
    console.log(`[osc] channel ${ch} configured (type=0x${type.toString(16)}, addr=0x${addr.toString(16)})`);
    ws.send(frame);

  // 0x71 — Start / resume oscilloscope
  } else if (fc === 0x71) {
    ws.send(frame);
    if (!state.oscRunning) {
      state.oscRunning = true;
      const chCount        = state.oscChannels.length || 1;
      const bytesPerSample = chCount * 2; // assume INT16 for timing estimate
      const samplesPerFrame = Math.floor(state.dataAreaLen / bytesPerSample);
      const fps             = state.sampleRate / samplesPerFrame;
      const intervalMs      = Math.max(16, Math.round(1000 / fps));
      console.log(`[osc] start: ${chCount} ch, ~${fps.toFixed(0)} fps, interval=${intervalMs} ms`);
      state.oscTimer = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
          ws.send(buildOscFrame(state));
        }
      }, intervalMs);
    }

  // 0x72 — Stop oscilloscope
  } else if (fc === 0x72) {
    clearInterval(state.oscTimer);
    state.oscRunning  = false;
    state.oscChannels = [];
    state.t           = 0;
    console.log('[osc] stopped');
    ws.send(frame);

  // 0x73 — Set sampling communication rate (echo)
  } else if (fc === 0x73) {
    ws.send(frame);

  // 0x08 — Heartbeat (echo)
  } else if (fc === 0x08) {
    ws.send(frame);

  } else {
    console.warn(`[rx] unknown FC 0x${fc.toString(16)}, ignored`);
  }
}

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: PORT });
console.log(`Mock ESP32 WS server listening on ws://0.0.0.0:${PORT}`);

wss.on('connection', (ws) => {
  const state = makeState();
  console.log('[connect] new client');

  ws.on('message', (data) => {
    const frame = Buffer.from(data);
    if (!verifyCrc(frame)) {
      console.warn('[rx] CRC fail, ignored:', frame.toString('hex'));
      return;
    }
    handleFrame(ws, state, frame);
  });

  ws.on('close', () => {
    clearInterval(state.oscTimer);
    console.log('[disconnect]');
  });

  ws.on('error', (err) => {
    console.error('[ws error]', err.message);
  });
});
