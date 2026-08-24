import { strict as assert } from 'node:assert';
import WebSocket from 'ws';

const url = process.env.CLOUD_WS_URL ||
  'wss://wd.claudcode.xyz/ws/device/wd-ac276eab7c9c';
const cycles = Number.parseInt(process.env.CYCLES || '40', 10);
const intervalMs = Number.parseInt(process.env.INTERVAL_MS || '500', 10);
const timeoutMs = Number.parseInt(process.env.TIMEOUT_MS || '2800', 10);
const openTimeoutMs = Number.parseInt(process.env.OPEN_TIMEOUT_MS || '10000', 10);

function crc16(data) {
  let crc = 0xffff;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
  }
  return crc & 0xffff;
}

function readHolding(startAddress, count) {
  const body = Buffer.from([
    0xff,
    0x03,
    (startAddress >> 8) & 0xff,
    startAddress & 0xff,
    (count >> 8) & 0xff,
    count & 0xff,
  ]);
  const crc = crc16(body);
  return Buffer.concat([body, Buffer.from([crc & 0xff, crc >> 8])]);
}

function validReadResponse(frame, registerCount) {
  const expectedLength = 5 + registerCount * 2;
  if (frame.length !== expectedLength || frame[0] !== 0xff || frame[1] !== 0x03 ||
      frame[2] !== registerCount * 2) return false;
  const expectedCrc = frame[frame.length - 2] | (frame[frame.length - 1] << 8);
  return crc16(frame.subarray(0, -2)) === expectedCrc;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

const request = readHolding(0x0b00, 8);
const expectedResponseLength = 21;
const ws = new WebSocket(url);
let rx = Buffer.alloc(0);
let pending = null;

ws.on('message', (data, isBinary) => {
  if (!isBinary) return;
  rx = Buffer.concat([rx, Buffer.from(data)]);
  while (rx.length >= expectedResponseLength) {
    const start = rx.findIndex((value, index) =>
      value === 0xff && rx[index + 1] === 0x03 && rx[index + 2] === 16);
    if (start < 0) {
      rx = rx.subarray(Math.max(0, rx.length - 2));
      return;
    }
    if (rx.length - start < expectedResponseLength) {
      rx = rx.subarray(start);
      return;
    }
    const frame = rx.subarray(start, start + expectedResponseLength);
    rx = rx.subarray(start + expectedResponseLength);
    if (!validReadResponse(frame, 8) || pending == null) continue;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    current.resolve(performance.now() - current.startedAt);
  }
});

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('cloud websocket open timeout')), openTimeoutMs);
  ws.once('open', () => {
    clearTimeout(timer);
    resolve();
  });
  ws.once('error', reject);
});

const latencies = [];
let timeouts = 0;
for (let cycle = 0; cycle < cycles; cycle += 1) {
  const cycleStartedAt = performance.now();
  try {
    const latency = await new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const timer = setTimeout(() => {
        pending = null;
        reject(new Error(`cycle ${cycle + 1} timeout`));
      }, timeoutMs);
      pending = { resolve, timer, startedAt };
      ws.send(request);
    });
    latencies.push(latency);
  } catch {
    timeouts += 1;
  }
  const remaining = intervalMs - (performance.now() - cycleStartedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

ws.close();
assert.equal(timeouts, 0, `expected no missing responses, got ${timeouts}/${cycles}`);
assert.equal(latencies.length, cycles);

const result = {
  requests: cycles,
  responses: latencies.length,
  timeouts,
  intervalMs,
  minMs: Number(Math.min(...latencies).toFixed(1)),
  medianMs: Number(percentile(latencies, 0.5).toFixed(1)),
  p95Ms: Number(percentile(latencies, 0.95).toFixed(1)),
  maxMs: Number(Math.max(...latencies).toFixed(1)),
};
console.log(JSON.stringify(result));
