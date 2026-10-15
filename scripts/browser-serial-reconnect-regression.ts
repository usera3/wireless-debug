// Real connection store/transport and native Streams; only OS ports and time are simulated.
import assert from 'node:assert/strict';
import type { BrowserSerialPort } from '../src/lib/browserSerial';

const storage = new Map([['wireless_debug_ws_url', 'webserial://local']]);
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } } as Storage;
globalThis.window = { location: new URL('http://127.0.0.1:5679/index.html') } as unknown as Window & typeof globalThis;
globalThis.fetch = async () => { throw new Error('No HTTP in serial recovery'); };
let now = 0, nextTimer = 0;
const timers = new Map<number, { due: number; run: () => void }>();
globalThis.setTimeout = ((run: () => void, delay = 0) => { const id = ++nextTimer; timers.set(id, { due: now + delay, run }); return id; }) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
async function advance(ms: number) {
  const end = now + ms;
  for (;;) {
    const next = [...timers].filter(([, t]) => t.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
    if (!next) break;
    now = next[1].due; timers.delete(next[0]); next[1].run(); await settle();
  }
  now = end; await settle();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
class Port extends EventTarget implements BrowserSerialPort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  opens = 0; closes = 0; writes: number[][] = [];
  options!: Parameters<BrowserSerialPort['open']>[0];
  opening?: Promise<void>;
  closing?: Promise<void>;
  failures: Error[] = [];
  closeError = false;
  missingWritable = false;
  async open(options: Parameters<BrowserSerialPort['open']>[0]) {
    this.opens++; this.options = options;
    if (this.failures.length) throw this.failures.shift();
    await this.opening;
    this.readable = new ReadableStream();
    this.writable = this.missingWritable ? null : new WritableStream({ write: bytes => { this.writes.push([...bytes]); } });
  }
  async close() { this.closes++; await this.closing; if (this.closeError) throw new Error('OS cleanup failed'); }
  getInfo() { return { usbVendorId: 0x1234, usbProductId: 0x5678 }; }
}
class SerialApi extends EventTarget {
  granted: Port[] = [];
  discovery?: Promise<Port[]>;
  getPorts() { return this.discovery ?? Promise.resolve(this.granted.slice()); }
  requestPort(): Promise<never> { throw new Error('Recovery must never request permission'); }
  event(type: string, port: Port, legacy = false) {
    const event = new Event(type);
    Object.defineProperty(event, legacy ? 'port' : 'target', { value: port });
    this.dispatchEvent(event);
  }
}
const api = new SerialApi();
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serial: api } });
const { useConnectionStore: store } = await import('../src/store/connectionStore');
const { useBootloaderStore } = await import('../src/store/bootloaderStore');
const { wsClient } = await import('../src/lib/wsClient');
function remove(port: Port) {
  api.granted = api.granted.filter(item => item !== port);
  api.event('disconnect', port);
  port.dispatchEvent(new Event('disconnect'));
}
function insert(port: Port, legacy = false) {
  if (!api.granted.includes(port)) api.granted.push(port);
  api.event('connect', port, legacy);
}
async function opened(baud = 921600) {
  const port = new Port(); api.granted.push(port);
  await store.getState().connectSerial(port, baud);
  assert.equal(store.getState().connected, true);
  return port;
}
let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await store.getState().disconnect();
  store.getState().setUrl('webserial://local', true);
  await settle(); api.granted = []; api.discovery = undefined;
  await run();
  useBootloaderStore.setState({ isFlashing: false });
  await store.getState().disconnect(); await settle();
  assert.equal(timers.size, 0, 'No owned recovery timers remain after cancellation');
  console.log(`PASS ${name}`); passed++;
}

await test('a previously opened exact port reconnects with its original baud and no replay', async () => {
  const port = await opened(); const oldSignal = wsClient.signal;
  remove(port); await settle();
  assert.equal(store.getState().serialRecovering, true);
  assert.equal(store.getState().connected, false);
  assert.equal(oldSignal.aborted, true);
  assert.equal(port.readable!.locked, false); assert.equal(port.writable!.locked, false);
  const identicalModel = new Port(); insert(identicalModel); await advance(4000);
  assert.equal(identicalModel.opens, 0, 'Never identify another device using VID/PID');
  insert(port); insert(port); await advance(599);
  assert.equal(port.opens, 1, 'Arrival is debounced');
  await advance(1);
  assert.equal(store.getState().connected, true);
  assert.equal(store.getState().serialRecovering, false);
  assert.equal(port.opens, 2); assert.equal(port.options.baudRate, 921600);
  assert.deepEqual(port.writes, []);
});
await test('initial discovery and failed explicit open never arm recovery', async () => {
  const port = new Port(); insert(port); await advance(5000); assert.equal(port.opens, 0);
  port.failures.push(new DOMException('Busy', 'NetworkError'));
  await store.getState().connectSerial(port, 115200);
  remove(port); insert(port); await advance(5000);
  assert.equal(port.opens, 1); assert.equal(store.getState().serialRecovering, false);
});
await test('manual disconnect cancels recovery both before and after loss', async () => {
  const port = await opened();
  await store.getState().disconnect(); remove(port); insert(port); await advance(2000);
  assert.equal(port.opens, 1);
  await store.getState().connectSerial(port, 115200);
  remove(port); await settle(); insert(port);
  await store.getState().disconnect(); await advance(5000);
  assert.equal(port.opens, 2); assert.equal(store.getState().serialRecovering, false);
});
await test('switching mode cancels queued recovery and stale device events', async () => {
  const port = await opened(); remove(port); await settle(); insert(port);
  store.getState().setUrl('ws://custom.example/ws', false); await advance(5000);
  assert.equal(port.opens, 1); assert.equal(store.getState().serialMode, false);
  assert.equal(store.getState().serialRecovering, false);
});
await test('cancellation while permission discovery is pending cannot open the port', async () => {
  const port = await opened(); remove(port); await settle();
  const discovery = deferred<Port[]>(); api.discovery = discovery.promise;
  insert(port); await advance(600); await store.getState().disconnect();
  discovery.resolve([port]); await settle();
  assert.equal(port.opens, 1); assert.equal(store.getState().connected, false);
});
await test('late native open after cancellation releases its own streams', async () => {
  const port = await opened(); remove(port); await settle();
  const opening = deferred<void>(); port.opening = opening.promise;
  insert(port); await advance(600); assert.equal(port.opens, 2);
  const close = store.getState().disconnect(); opening.resolve(); await close; await settle();
  assert.equal(store.getState().connected, false); assert.equal(port.closes, 2);
  assert.equal(port.readable!.locked, false); assert.equal(port.writable!.locked, false);
});
await test('temporary OS failures recover within three attempts including legacy events', async () => {
  const port = await opened(115200); remove(port); await settle();
  port.failures.push(new DOMException('Busy', 'NetworkError'), new DOMException('Still enumerating', 'NetworkError'));
  insert(port, true); await advance(2600);
  assert.equal(port.opens, 4); assert.equal(store.getState().connected, true);
  assert.equal(port.options.baudRate, 115200); assert.deepEqual(port.writes, []);
});
await test('retry exhaustion ends recovery instead of looping forever', async () => {
  const port = await opened(); remove(port); await settle();
  port.failures.push(...Array.from({ length: 3 }, () => new DOMException('Busy', 'NetworkError')));
  insert(port); await advance(10000);
  assert.equal(port.opens, 4); assert.equal(store.getState().serialRecovering, false);
  assert.equal(store.getState().connected, false); assert.match(store.getState().error!, /自动重连失败/);
});
await test('permission loss stops recovery without opening or a permission popup', async () => {
  const port = await opened(); remove(port); await settle();
  api.event('connect', port); await advance(5000);
  assert.equal(port.opens, 1); assert.equal(store.getState().serialRecovering, false);
  assert.match(store.getState().error!, /授权/);
});
await test('permission denial while opening is terminal without repeated prompts', async () => {
  const port = await opened(); remove(port); await settle();
  port.failures.push(new DOMException('Denied', 'NotAllowedError'));
  insert(port); await advance(5000);
  assert.equal(port.opens, 2); assert.equal(store.getState().serialRecovering, false);
});
await test('loss during programming remains manual after the activity lock clears', async () => {
  const port = await opened(); useBootloaderStore.setState({ isFlashing: true });
  remove(port); await settle(); useBootloaderStore.setState({ isFlashing: false });
  insert(port); await advance(5000);
  assert.equal(port.opens, 1); assert.equal(store.getState().serialRecovering, false);
});
await test('cleanup failure cannot be followed by an automatic reopen', async () => {
  const port = await opened(); port.closeError = true;
  remove(port); await settle(); insert(port); await advance(5000);
  assert.equal(port.opens, 1); assert.equal(store.getState().serialRecovering, false);
  assert.match(store.getState().error!, /OS cleanup failed/);
});
await test('a removal during debounce waits for the next stable arrival', async () => {
  const port = await opened(); remove(port); await settle(); insert(port);
  await advance(300); remove(port); await advance(5000); assert.equal(port.opens, 1);
  insert(port); await advance(600); assert.equal(port.opens, 2);
  assert.equal(store.getState().connected, true);
});
await test('late cleanup rejection cancels a recovery already waiting for old streams', async () => {
  const port = await opened(); const closing = deferred<void>();
  port.closing = closing.promise; port.closeError = true;
  remove(port); await settle(); insert(port); await advance(600);
  assert.equal(port.opens, 1, 'No overlapping port owners during old cleanup');
  closing.resolve(); await settle();
  assert.equal(store.getState().serialRecovering, false);
  await advance(10000);
  assert.equal(port.opens, 1); assert.match(store.getState().error!, /OS cleanup failed/);
});
await test('cleanup failure in the new automatic open attempt is terminal', async () => {
  const port = await opened(); remove(port); await settle();
  port.missingWritable = true; port.closeError = true;
  insert(port); await advance(600);
  assert.equal(store.getState().serialRecovering, false);
  assert.match(store.getState().error!, /cleanup failed/);
  await advance(10000); assert.equal(port.opens, 2, 'Never retry after new attempt cleanup fails');
});
await test('removal while reopen awaits old cleanup invalidates the pending open', async () => {
  const port = await opened(); const closing = deferred<void>(); port.closing = closing.promise;
  remove(port); await settle(); insert(port); await advance(600);
  remove(port); closing.resolve(); await settle(); await advance(5000);
  assert.equal(port.opens, 1); assert.equal(store.getState().connected, false);
  assert.equal(store.getState().serialRecovering, true);
  insert(port); await advance(600);
  assert.equal(port.opens, 2); assert.equal(store.getState().connected, true);
});
await test('duplicate arrival events cannot reset the retry budget', async () => {
  const port = await opened(); remove(port); await settle();
  port.failures.push(...Array.from({ length: 10 }, () => new DOMException('Busy', 'NetworkError')));
  insert(port); await advance(600);
  for (let i = 0; i < 6; i++) { insert(port); await advance(1000); }
  assert.equal(port.opens, 4); assert.equal(store.getState().serialRecovering, false);
});
await test('new object with identical metadata requires explicit confirmation, never an automatic open', async () => {
  const original = await opened(); remove(original); await settle();
  const replacement = new Port(); insert(replacement); await advance(5000);
  assert.equal(store.getState().serialNeedsConfirmation, true);
  assert.equal(store.getState().connected, false); assert.equal(replacement.opens, 0);
  await store.getState().connectSerial(replacement, 115200);
  assert.equal(store.getState().serialNeedsConfirmation, false);
  assert.equal(store.getState().connected, true); assert.equal(replacement.opens, 1);
  assert.deepEqual(replacement.writes, []);
});
await test('original object can still recover while another available port awaits confirmation', async () => {
  const original = await opened(); remove(original); await settle();
  const other = new Port(); insert(other); await settle();
  assert.equal(store.getState().serialNeedsConfirmation, true);
  insert(original); await advance(600);
  assert.equal(store.getState().connected, true);
  assert.equal(store.getState().serialNeedsConfirmation, false); assert.equal(other.opens, 0);
});
await test('withdrawing a new candidate clears confirmation and keeps waiting for the original', async () => {
  const original = await opened(); remove(original); await settle();
  const other = new Port(); insert(other); await settle();
  assert.equal(store.getState().serialNeedsConfirmation, true);
  remove(other); await settle();
  assert.equal(store.getState().serialNeedsConfirmation, false);
  assert.equal(store.getState().serialRecovering, true); assert.equal(other.opens, 0);
});
await test('late candidate discovery cannot resurrect confirmation after cancellation', async () => {
  const original = await opened(); remove(original); await settle();
  const discovery = deferred<Port[]>(); api.discovery = discovery.promise;
  const other = new Port(); insert(other);
  await store.getState().disconnect(); discovery.resolve([other]); await settle();
  assert.equal(store.getState().serialNeedsConfirmation, false);
  assert.equal(store.getState().serialRecovering, false); assert.equal(other.opens, 0);
});
await test('older candidate discovery cannot overwrite a newer removal snapshot', async () => {
  const original = await opened(); remove(original); await settle();
  const discovery = deferred<Port[]>(); api.discovery = discovery.promise;
  const other = new Port(); insert(other);
  api.discovery = undefined; remove(other); await settle();
  discovery.resolve([other]); await settle();
  assert.equal(store.getState().serialNeedsConfirmation, false);
  assert.equal(store.getState().serialRecovering, true); assert.equal(other.opens, 0);
});
await test('late candidate discovery cannot relabel a restored original session', async () => {
  const original = await opened(921600); remove(original); await settle();
  const discovery = deferred<Port[]>(); api.discovery = discovery.promise;
  const other = new Port(); insert(other);
  api.discovery = undefined; insert(original); await advance(600);
  discovery.resolve([other]); await settle();
  assert.equal(store.getState().serialNeedsConfirmation, false);
  assert.equal(store.getState().serialSession?.port, original);
  assert.equal(store.getState().serialSession?.baud, 921600);
  assert.equal(store.getState().connected, true); assert.equal(other.opens, 0);
});
console.log(`Browser serial reconnect: ${passed} passed (OS/time simulation, no hardware)`);
