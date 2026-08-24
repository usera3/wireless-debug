# Mock ESP32 WebSocket Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a Node.js mock WebSocket server (`mock-server/server.mjs`) that faithfully simulates ESP32 Modbus RTU + oscilloscope protocol over WebSocket binary frames, sending multi-channel sine-wave data when oscilloscope is running.

**Architecture:** Single-file ESM Node.js script using the built-in `ws` package (added as devDependency). Maintains an in-memory register bank (512 words). On oscilloscope start (`0x71`), starts a `setInterval` that pushes 130-byte oscilloscope frames at a rate derived from the negotiated channel config. All Modbus frames are validated with CRC16 before responding.

**Tech Stack:** Node.js ≥ 18 ESM, `ws` npm package, no TypeScript (plain `.mjs` for zero build step).

---

### Task 1: Add `ws` devDependency

**Files:**
- Modify: `package.json`

**Step 1: Install `ws`**

```bash
cd /home/coder/project/wireless_debug_web
npm install --save-dev ws
```

Expected: `ws` appears in `devDependencies` in `package.json`.

**Step 2: Add `mock` script to `package.json`**

In the `"scripts"` block, add:
```json
"mock": "node mock-server/server.mjs"
```

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add ws devDependency and mock script"
```

---

### Task 2: Create CRC16 helper (pure JS, mirrors `src/lib/crc16.ts`)

**Files:**
- Create: `mock-server/crc16.mjs`

**Step 1: Write the file**

```js
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
```

**Step 2: Quick sanity check (inline node)**

```bash
node -e "
import('./mock-server/crc16.mjs').then(({ crc16 }) => {
  // FC03 read 1 reg from 0x2001: expected CRC bytes 0xCB 0xD4
  const frame = Buffer.from([0xFF,0x03,0x20,0x01,0x00,0x01]);
  const crc = crc16(frame);
  console.log((crc & 0xff).toString(16), ((crc>>8)&0xff).toString(16)); // expect: cb d4
});
"
```

Expected output: `cb d4`

**Step 3: Commit**

```bash
git add mock-server/crc16.mjs
git commit -m "feat(mock): add CRC16 helper"
```

---

### Task 3: Create the main mock server

**Files:**
- Create: `mock-server/server.mjs`

**Constant and register bank setup** (top of file):

```js
import { WebSocketServer } from 'ws';
import { appendCrc, verifyCrc } from './crc16.mjs';

const PORT    = 8765;
const SLAVE   = 0xff;
const REG_SIZE = 512; // 16-bit registers

// --- per-connection state factory ---
function makeState() {
  return {
    regs: new Uint16Array(REG_SIZE),   // Modbus register bank
    oscChannels: [],                    // [{ch, type, addr}]
    oscRunning: false,
    oscTimer: null,
    frameLen: 130,                      // bytes: 4+120+2+4
    dataAreaLen: 120,
    sampleRate: 6000,
    t: 0,                               // sample counter for sine gen
  };
}
```

**Oscilloscope frame builder** (inside `makeState` scope):

Data area layout: channels packed in order, each channel 2 bytes (INT16 for type 0x00/0x01/0x02) or 4 bytes (INT32/Float for 0x03), big-endian. Fill leftover bytes with 0x00.

```js
const FRAME_HEADER = Buffer.from([0xff, 0x77, 0xaa, 0x55]);
const FRAME_FOOTER = Buffer.from([0xff, 0x77, 0xaa, 0x55]);

function buildOscFrame(state) {
  const dataArea = Buffer.alloc(state.dataAreaLen, 0);
  let offset = 0;
  for (const ch of state.oscChannels) {
    // sine wave: each channel uses a different frequency multiplier
    const freq = ch.ch * 0.5; // ch1→0.5 Hz, ch2→1.0 Hz …
    const amplitude = 10000;
    const val = Math.round(amplitude * Math.sin(2 * Math.PI * freq * state.t / state.sampleRate));
    if (ch.type === 0x03) {
      if (offset + 4 > state.dataAreaLen) break;
      dataArea.writeInt32BE(val, offset); offset += 4;
    } else {
      if (offset + 2 > state.dataAreaLen) break;
      dataArea.writeInt16BE(val, offset); offset += 2;
    }
  }
  state.t++;

  const crc = crc16(dataArea);
  const crcBuf = Buffer.from([crc & 0xff, (crc >> 8) & 0xff]);
  return Buffer.concat([FRAME_HEADER, dataArea, crcBuf, FRAME_FOOTER]);
}
```

**Import `crc16` raw function too** (for `buildOscFrame`):

```js
import { appendCrc, verifyCrc, crc16 } from './crc16.mjs';
```

**Request handlers** (switch on `frame[1]` — the function code):

| FC | Action |
|----|--------|
| `0x03` | Read holding regs: reply `FF 03 <byteCount> <data…> <CRC>` |
| `0x06` | Write single reg: update `state.regs`, echo frame |
| `0x10` | Write multiple regs: update `state.regs`, reply standard response |
| `0x04` reg=0x0000 | Return frameLen `0x0082` |
| `0x04` reg=0x0001 | Return maxChannels `0x000C` |
| `0x04` reg=0x0002 | Return sampleRate `0x1770` |
| `0x75` | Set osc channel config; echo frame |
| `0x71` | Start osc: send echo, start `setInterval` pushing osc frames |
| `0x72` | Stop osc: send echo, clear interval, reset channels |
| `0x73` | Set comm rate: echo frame |
| `0x08` | Heartbeat: echo frame |

**Server wiring:**

```js
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
});
```

**Full `handleFrame` implementation:**

```js
function handleFrame(ws, state, frame) {
  const fc = frame[1];
  console.log(`[rx] FC=0x${fc.toString(16).padStart(2,'0')} ${frame.toString('hex')}`);

  if (fc === 0x03) {
    const startAddr = (frame[2] << 8) | frame[3];
    const count     = (frame[4] << 8) | frame[5];
    const byteCount = count * 2;
    const resp = Buffer.alloc(3 + byteCount);
    resp[0] = SLAVE; resp[1] = 0x03; resp[2] = byteCount;
    for (let i = 0; i < count; i++) {
      const v = state.regs[startAddr + i] ?? 0;
      resp[3 + i * 2] = (v >> 8) & 0xff;
      resp[4 + i * 2] = v & 0xff;
    }
    ws.send(appendCrc(resp));

  } else if (fc === 0x06) {
    const addr  = (frame[2] << 8) | frame[3];
    const value = (frame[4] << 8) | frame[5];
    state.regs[addr] = value;
    ws.send(frame); // echo

  } else if (fc === 0x10) {
    const startAddr  = (frame[2] << 8) | frame[3];
    const regCount   = (frame[4] << 8) | frame[5];
    const byteCount  = frame[6];
    for (let i = 0; i < regCount; i++) {
      state.regs[startAddr + i] = (frame[7 + i * 2] << 8) | frame[8 + i * 2];
    }
    // response: addr(2) + FC + startAddr(2) + regCount(2) + byteCount(1) + CRC
    const resp = Buffer.alloc(7);
    resp[0] = SLAVE; resp[1] = 0x10;
    resp[2] = frame[2]; resp[3] = frame[3];
    resp[4] = frame[4]; resp[5] = frame[5];
    resp[6] = byteCount;
    ws.send(appendCrc(resp));

  } else if (fc === 0x04) {
    const regAddr = (frame[2] << 8) | frame[3];
    let value;
    if      (regAddr === 0x0000) value = state.frameLen;    // 130
    else if (regAddr === 0x0001) value = 12;                 // maxChannels
    else if (regAddr === 0x0002) value = state.sampleRate;   // 6000
    else { console.warn('[rx] FC04 unknown regAddr', regAddr); return; }
    const resp = Buffer.from([SLAVE, 0x04, 0x02, (value >> 8) & 0xff, value & 0xff]);
    ws.send(appendCrc(resp));

  } else if (fc === 0x75) {
    const ch   = frame[2];
    const type = frame[3];
    const addr = (frame[4] << 8) | frame[5];
    state.oscChannels.push({ ch, type, addr });
    ws.send(frame); // echo

  } else if (fc === 0x71) {
    ws.send(frame); // echo start
    if (!state.oscRunning) {
      state.oscRunning = true;
      // interval in ms = (frameLen bytes) / (sampleRate bytes/s * (channels * 2 bytes/sample)) — simplified
      // just push one frame per (1000/fps) ms; fps = sampleRate / samplesPerFrame
      const chCount = state.oscChannels.length || 1;
      const bytesPerSample = chCount * 2; // assume INT16
      const samplesPerFrame = Math.floor(state.dataAreaLen / bytesPerSample);
      const fps = state.sampleRate / samplesPerFrame;
      const intervalMs = Math.max(16, Math.round(1000 / fps));
      console.log(`[osc] start: ${chCount} ch, ~${fps.toFixed(0)} fps, interval=${intervalMs}ms`);
      state.oscTimer = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
          ws.send(buildOscFrame(state));
        }
      }, intervalMs);
    }

  } else if (fc === 0x72) {
    clearInterval(state.oscTimer);
    state.oscRunning = false;
    state.oscChannels = [];
    state.t = 0;
    ws.send(frame); // echo stop

  } else if (fc === 0x73) {
    ws.send(frame); // echo set-rate

  } else if (fc === 0x08) {
    ws.send(frame); // echo heartbeat

  } else {
    console.warn(`[rx] unknown FC 0x${fc.toString(16)}`);
  }
}
```

**Step 1: Create `mock-server/server.mjs` with the complete code above (all sections combined in order).**

**Step 2: Start the server and verify it binds**

```bash
node mock-server/server.mjs
```

Expected output:
```
Mock ESP32 WS server listening on ws://0.0.0.0:8765
```

If `ws` not found, run `npm install` first.

**Step 3: Commit**

```bash
git add mock-server/server.mjs
git commit -m "feat(mock): add ESP32 WebSocket mock server with sine-wave osc data"
```

---

### Task 4: Add npm run script and verify end-to-end

**Files:**
- Verify: `package.json` has `"mock": "node mock-server/server.mjs"`

**Step 1: Start mock server in background, open web app, connect to `ws://localhost:8765`**

```bash
node mock-server/server.mjs &
```

**Step 2: Confirm web app can connect, read registers, and see oscilloscope waveforms.**

Manual verification steps:
1. Open `http://localhost:5173/`
2. In connection panel, enter `ws://localhost:8765` and connect → status should turn green
3. Try reading a register → should return `0x0000`
4. Write a value → should echo back correctly
5. Start oscilloscope → waveform panel should show sine waves per channel

**Step 3: Commit if any fixups were needed**

```bash
git add -A
git commit -m "fix(mock): address any integration issues found during manual test"
```
