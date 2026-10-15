import assert from 'node:assert/strict';
import { WsClient } from '../src/lib/wsClient';
import { wsClient } from '../src/lib/wsClient';
import { waitForMatchingModbusFrame } from '../src/lib/modbusRequest';
import { BlModbusClient } from '../src/lib/blModbusClient';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class Port extends EventTarget {
  input!: ReadableStreamDefaultController<Uint8Array>;
  output!: WritableStreamDefaultController;
  readable = new ReadableStream<Uint8Array>({ start: controller => { this.input = controller; } });
  writes: number[][] = [];
  writeGate?: ReturnType<typeof deferred>;
  openGate?: ReturnType<typeof deferred>;
  closeGate?: ReturnType<typeof deferred>;
  closeError?: Error;
  settings: unknown;
  openCalls = 0;
  closeCalls = 0;
  writable = new WritableStream<Uint8Array>({ start: controller => { this.output = controller; }, write: async data => {
    this.writes.push([...data]);
    await this.writeGate?.promise;
  } });
  async open(options: unknown) { this.openCalls += 1; this.settings = options; await this.openGate?.promise; }
  async close() {
    this.closeCalls += 1;
    await this.closeGate?.promise;
    if (this.closeError) throw this.closeError;
  }
  getInfo() { return {}; }
  unlocked() {
    assert.equal(this.readable.locked, false, 'reader lock released');
    assert.equal(this.writable.locked, false, 'writer lock released');
    assert.equal(this.closeCalls, 1, 'owned port closed once');
  }
}

// This assertion is intentionally executable against the pre-feature facade.
assert.equal(typeof new WsClient().connectSerial, 'function', 'WsClient must support browser serial connections');
assert.equal(new WsClient().readyState, 3, 'disconnected facade needs no WebSocket global');

let input!: ReadableStreamDefaultController<Uint8Array>;
const writes: number[][] = [];
let closeCalls = 0;
let settings: unknown;
const port = {
  readable: new ReadableStream<Uint8Array>({ start(controller) { input = controller; } }),
  writable: new WritableStream<Uint8Array>({ write(data) { writes.push([...data]); } }),
  async open(options: unknown) { settings = options; },
  async close() { closeCalls += 1; },
  getInfo() { return {}; },
};
const client = new WsClient();
const frames: number[][] = [];
client.onFrame(data => frames.push([...data]));
await client.connectSerial(port, 2000000);
assert.deepEqual(settings, { baudRate: 2000000, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
input.enqueue(new Uint8Array([255]));
input.enqueue(new Uint8Array([0, 13, 10]));
client.send(new Uint8Array([255, 0, 13, 10]));
client.send(new Uint8Array([1, 2]));
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(frames, [[255], [0, 13, 10]]);
assert.deepEqual(writes, [[255, 0, 13, 10], [1, 2]]);
await client.disconnect();
assert.equal(port.readable.locked, false);
assert.equal(port.writable.locked, false);
assert.equal(closeCalls, 1);
assert.equal(client.transportKind, null);
console.log('browser serial basic transport regression passed');

{
  const client = new WsClient();
  const port = new Port();
  port.writeGate = deferred();
  const raw: number[][] = [];
  let opens = 0;
  let closes = 0;
  client.onRawSend(bytes => raw.push([...bytes]));
  client.onOpen(() => { opens += 1; });
  client.onClose(() => { closes += 1; });
  await client.connectSerial(port, 2000000);
  assert.equal(client.transportKind, 'serial');
  assert.equal(client.readyState, 1);
  client.send(new Uint8Array([1]));
  const bytes = new Uint8Array([2, 255, 0]);
  client.send(bytes);
  bytes.fill(99);
  await tick();
  assert.deepEqual(port.writes, [[1]], 'one native stream write remains in flight');
  port.writeGate.resolve();
  await tick();
  assert.deepEqual(port.writes, [[1], [2, 255, 0]], 'queued data is copied before caller mutation');
  assert.deepEqual(raw, [[1], [2, 255, 0]]);
  await client.disconnect();
  assert.equal(opens, 1);
  assert.equal(closes, 0, 'explicit disconnect is silent');
  port.unlocked();
  console.log('PASS copied ordered queues and facade hooks');
}
{
  const client = new WsClient();
  const port = new Port();
  const faults: (Error | undefined)[] = [];
  client.onClose(error => faults.push(error));
  await client.connectSerial(port, 2000000);
  const signal = client.signal;
  const generation = client.generation;
  const error = new Error('Idle OS writable stream failed');
  port.output.error(error);
  await tick();
  assert.equal(client.readyState, 3, 'idle writable failure must close the active connection');
  assert.equal(signal.aborted, true, 'idle writable failure aborts pending generation work');
  assert.ok(client.generation > generation);
  assert.deepEqual(faults, [error], 'idle writable failure reports the original error once');
  assert.deepEqual(port.writes, [], 'fault is detected without sending any bytes');
  port.unlocked();
  await client.disconnect();
  await client.disconnect();
  assert.deepEqual(faults, [error]);
  port.unlocked();
  console.log('PASS idle writable error aborts generation and cleans up without a send');
}
for (const reason of ['read error', 'write rejection', 'stream done', 'removal'] as const) {
  const client = new WsClient();
  const port = new Port();
  const errors: (Error | undefined)[] = [];
  client.onClose(error => errors.push(error));
  await client.connectSerial(port, 2000000);
  const signal = client.signal;
  if (reason === 'read error') port.input.error(new Error('RX failed'));
  if (reason === 'stream done') port.input.close();
  if (reason === 'removal') port.dispatchEvent(new Event('disconnect'));
  if (reason === 'write rejection') {
    port.writeGate = deferred();
    client.send(new Uint8Array([1]));
    port.writeGate.reject(new Error('TX failed'));
  }
  await tick();
  assert.equal(signal.aborted, true, reason);
  assert.equal(client.readyState, 3, reason);
  assert.equal(errors.length, 1, reason);
  assert.ok(errors[0] instanceof Error);
  port.dispatchEvent(new Event('disconnect'));
  await client.disconnect();
  await client.disconnect();
  assert.equal(errors.length, 1);
  port.unlocked();
  console.log(`PASS ${reason}`);
}
{
  const port = new Port();
  const client = new WsClient();
  port.writeGate = deferred();
  port.closeGate = deferred();
  await client.connectSerial(port, 2000000);
  client.send(new Uint8Array([1]));
  const bytes = new Uint8Array([2]);
  client.send(bytes);
  bytes.fill(99);
  await tick();
  const signal = client.signal;
  const generation = client.generation;
  const closing = client.disconnect();
  assert.equal(signal.aborted, true);
  assert.ok(client.generation > generation);
  assert.equal(client.readyState, 3);
  port.writeGate.resolve();
  await tick();
  assert.deepEqual(port.writes, [[1]], 'cancellation drops queued writes');
  port.closeGate.resolve();
  await closing;
  port.unlocked();
  console.log('PASS synchronous cancellation and dropped queued writes');
}
{
  const port = new Port();
  const client = new WsClient();
  port.writeGate = deferred();
  const errors: Error[] = [];
  client.onClose(error => { if (error) errors.push(error); });
  await client.connectSerial(port, 2000000);
  const signal = client.signal;
  client.send(new Uint8Array(1048576));
  await tick();
  assert.throws(() => client.send(new Uint8Array([1])), /queue|1048576/i);
  assert.equal(signal.aborted, true);
  assert.equal(errors.length, 1);
  port.writeGate.resolve();
  await client.disconnect();
  assert.equal(port.writes.length, 1);
  port.unlocked();
  console.log('PASS queued plus in-flight bytes bounded to 1048576');
}
{
  const client = new WsClient();
  const port = new Port();
  port.openGate = deferred();
  let opens = 0;
  client.onOpen(() => { opens += 1; });
  const opening = client.connectSerial(port, 2000000);
  const rejected = assert.rejects(opening, { name: 'AbortError' });
  await tick();
  assert.equal(port.openCalls, 1);
  assert.equal(client.readyState, 0);
  const closing = client.disconnect();
  port.openGate.resolve();
  await Promise.all([closing, rejected]);
  port.unlocked();
  assert.equal(opens, 0);
  console.log('PASS late open cancellation cleanup');
}
class Socket {
  static CLOSED = 3;
  static last: Socket;
  readyState = 1;
  binaryType = '';
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: ArrayBuffer }) => void;
  constructor(readonly url: string) { Socket.last = this; }
  close() { this.readyState = 3; }
  send() {}
}
{
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const client = new WsClient();
  const old = new Port();
  old.closeGate = deferred();
  let frames = 0;
  let closes = 0;
  client.onFrame(() => { frames += 1; });
  client.onClose(() => { closes += 1; });
  await client.connectSerial(old, 2000000);
  old.input.enqueue(new Uint8Array([9]));
  client.connect('ws://example.test/ws');
  assert.equal(client.transportKind, 'websocket');
  const socket = Socket.last;
  old.dispatchEvent(new Event('disconnect'));
  old.closeGate.resolve();
  const current = new Port();
  await client.connectSerial(current, 2000000);
  const generation = client.generation;
  socket.onopen?.(); socket.onclose?.(); socket.onerror?.();
  socket.onmessage?.({ data: new Uint8Array([1]).buffer });
  old.dispatchEvent(new Event('disconnect'));
  await tick();
  assert.equal(frames, 0);
  assert.equal(closes, 0);
  assert.equal(client.generation, generation);
  current.input.enqueue(new Uint8Array([2]));
  await tick();
  assert.equal(frames, 1);
  await client.disconnect();
  old.unlocked(); current.unlocked();
  console.log('PASS serial-network-serial stale callbacks');
}
{
  const client = new WsClient();
  const port = new Port();
  port.closeError = new Error('OS close failed');
  await client.connectSerial(port, 2000000);
  const first = client.disconnect();
  const second = client.disconnect();
  await Promise.all([assert.rejects(first, /OS close failed/), assert.rejects(second, /OS close failed/)]);
  port.unlocked();
  console.log('PASS cleanup failure surfaced and close idempotent');
}
{
  const client = new WsClient();
  const port = new Port();
  port.openGate = deferred();
  const opening = client.connectSerial(port, 2000000);
  const rejected = assert.rejects(opening, /occupied/);
  await tick();
  port.openGate.reject(new Error('occupied'));
  await rejected;
  assert.equal(client.readyState, 3);
  assert.equal(port.closeCalls, 0, 'failed open does not own an open port');
  const incomplete = new Port();
  Object.assign(incomplete, { writable: null });
  await assert.rejects(client.connectSerial(incomplete, 2000000), /stream/i);
  assert.equal(incomplete.readable.locked, false);
  assert.equal(incomplete.closeCalls, 1);
  console.log('PASS failed open and missing streams');
}
for (const reason of ['removal', 'write rejection'] as const) {
  const port = new Port();
  await wsClient.connectSerial(port, 2000000);
  if (reason === 'write rejection') port.writeGate = deferred();
  const modbus = waitForMatchingModbusFrame({ timeoutMs: 10000, subscribe: () => () => {} });
  const bootloader = new BlModbusClient(255, 10000).enterBootloaderMode();
  const rejected = Promise.all([
    assert.rejects(modbus, { name: 'AbortError' }),
    assert.rejects(bootloader, { name: 'AbortError' }),
  ]);
  if (reason === 'removal') port.dispatchEvent(new Event('disconnect'));
  else port.writeGate!.reject(new Error('OS write failed while protocol requests wait'));
  await rejected;
  await wsClient.disconnect();
  port.unlocked();
  console.log(`PASS ${reason} aborts pending Modbus and bootloader waits`);
}
console.log('browser serial transport regression passed');
