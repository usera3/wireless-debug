import assert from 'node:assert/strict';
import type { BrowserSerialPort } from '../src/lib/browserSerial';

const storage = new Map([['wireless_debug_ws_url', 'webserial://local']]);
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } } as Storage;
globalThis.window = { location: new URL('http://127.0.0.1:5679/index.html') } as unknown as Window & typeof globalThis;
const cloudRuntime = process.argv.includes('--cloud-runtime');
if (cloudRuntime) Object.assign(window, { __WIRELESS_REMOTE_DEVICE_ID: 'cloud-device', __WIRELESS_REMOTE_WS_URL: 'ws://localhost:8000/ws' });
class Socket {
  static OPEN = 1; static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void; onclose?: () => void; onerror?: () => void;
  constructor(readonly url: string) { Socket.instances.push(this); }
  close() { this.readyState = 3; }
  send() {}
  open() { this.readyState = 1; this.onopen?.(); }
}
globalThis.WebSocket = Socket as unknown as typeof WebSocket;
const calls: string[] = [];
globalThis.fetch = async input => { calls.push(String(input)); return new Response('{"ok":true}'); };
class Port extends EventTarget implements BrowserSerialPort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  controller!: ReadableStreamDefaultController<Uint8Array>;
  opens = 0; closes = 0;
  options: unknown;
  opening?: Promise<void>;
  closing?: Promise<void>;
  closeError = false;
  async open(options: unknown) {
    this.opens++; this.options = options;
    await this.opening;
    this.readable = new ReadableStream({ start: c => { this.controller = c; } });
    this.writable = new WritableStream();
  }
  async close() { this.closes++; await this.closing; if (this.closeError) throw new Error('OS close refused'); }
  getInfo() { return { usbVendorId: 0x1234, usbProductId: 0x5678 }; }
}
const { useConnectionStore: store } = await import('../src/store/connectionStore');
const { useBootloaderStore } = await import('../src/store/bootloaderStore');
const { useParamStore } = await import('../src/store/paramStore');
const { useOscStore } = await import('../src/store/oscStore');
const { useModbusOscStore } = await import('../src/store/modbusOscStore');
// Register the real controllers' lifecycle callbacks, not cleanup mocks.
await import('../src/hooks/useOscController');
await import('../src/hooks/useModbusOscController');
const setSampling = () => {
  useOscStore.getState().setRunning(true);
  useModbusOscStore.getState().setRunning(true);
};
const assertSampling = (running: boolean, reason: string) => {
  assert.equal(useOscStore.getState().running, running, `address scope: ${reason}`);
  assert.equal(useModbusOscStore.getState().running, running, `parameter scope: ${reason}`);
};
const { wsClient } = await import('../src/lib/wsClient');
const { apiFetch } = await import('../src/lib/apiClient');
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
if (cloudRuntime) {
  assert.equal(store.getState().url, 'ws://localhost:8000/ws');
  assert.equal(store.getState().serialMode, false, 'Authoritative injected network runtime overrides saved browser serial preference');
  assert.equal(storage.get('wireless_debug_ws_url'), 'webserial://local', 'Cloud runtime does not overwrite saved local preference');
  assert.deepEqual(calls, []);
  console.log('browser serial cloud runtime precedence regression passed');
} else {
assert.equal(store.getState().url, 'webserial://local', 'Saved browser serial preference is restored without opening');
assert.equal(storage.get('wireless_debug_ws_url'), 'webserial://local');
assert.equal(store.getState().serialMode, true);
await store.getState().connect(true);
await assert.rejects(apiFetch('/api/device/status'), /串口|Serial/i);
assert.deepEqual(calls, [], 'Serial startup and API guard never fetch');
assert.equal(Socket.instances.length, 0);
assert.deepEqual(store.getState().adapter?.capabilities, { serial: true, wifi: false, ble: false, comm_mode: false, device_files: false });

const port = new Port();
await store.getState().connectSerial(port, 2000000);
assert.equal(store.getState().connected, true);
assert.equal(wsClient.transportKind, 'serial');
assert.deepEqual(port.options, { baudRate: 2000000, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
useBootloaderStore.setState({ isFlashing: true });
store.getState().setUrl('http://192.168.4.1');
await store.getState().disconnect();
assert.equal(store.getState().connected, true, 'Programming prevents manual connection changes');
const activitySignal = wsClient.signal;
useParamStore.getState().setDashboardEnabled(true);
setSampling();
port.controller.error(new Error('USB removed'));
await tick();
assert.equal(activitySignal.aborted, true, 'Unexpected loss aborts protocol generation even during programming');
assert.equal(store.getState().connected, false);
assert.equal(useParamStore.getState().dashboardEnabled, false, 'Unexpected loss stops activity');
assertSampling(false, 'serial loss stops acquisition');
assert.match(store.getState().error!, /USB removed/);
assert.equal(port.closes, 1);
useBootloaderStore.setState({ isFlashing: false });

const failingClose = new Port(); failingClose.closeError = true;
await store.getState().connectSerial(failingClose, 2000000);
failingClose.controller.error(new Error('Read failed'));
await tick();
assert.match(store.getState().error!, /OS close refused/, 'Fault cleanup failure must be visible after onClose');

const slowClose = new Port();
let releaseClose!: () => void;
slowClose.closing = new Promise(resolve => { releaseClose = resolve; }); slowClose.closeError = true;
await store.getState().connectSerial(slowClose, 2000000);
slowClose.controller.error(new Error('Old read failure')); await tick();
store.getState().setUrl('http://192.168.4.1');
const network = store.getState().connect(); await tick();
Socket.instances.at(-1)!.open(); await network;
releaseClose(); await tick();
assert.equal(store.getState().connected, true);
assert.equal(store.getState().error, null, 'Stale cleanup failure cannot overwrite replacement state');
assert.equal((await apiFetch('/api/network-check')).ok, true, 'Network API remains available outside browser serial mode');
assert.equal(calls.at(-1), 'http://192.168.4.1/api/network-check');
setSampling();
Socket.instances.at(-1)!.onclose?.();
await tick();
assertSampling(false, 'local network loss stops acquisition');
await store.getState().disconnect();

store.getState().setUrl('wss://cloud.example/ws/device/test-device');
const cloud = store.getState().connect(); await tick();
Socket.instances.at(-1)!.open(); await cloud;
setSampling();
const cloudSignal = wsClient.signal;
Socket.instances.at(-1)!.onclose?.(); await tick();
assert.equal(store.getState().connected, false);
assert.equal(cloudSignal.aborted, true, 'Cloud loss still invalidates pending transport requests');
assertSampling(true, 'transient cloud loss preserves the existing acquisition policy');
await store.getState().disconnect();
assertSampling(false, 'explicit cloud disconnect stops acquisition');
setSampling();
store.getState().setUrl('http://192.168.4.1');
assertSampling(false, 'explicit target switch stops acquisition');

store.getState().setUrl('webserial://local', true);
const late = new Port(); let releaseOpen!: () => void;
late.opening = new Promise(resolve => { releaseOpen = resolve; });
const pending = store.getState().connectSerial(late, 921600); await tick();
assert.equal(store.getState().connecting, true);
store.getState().setUrl('ws://custom.example/ws', false);
releaseOpen(); await pending; await tick();
assert.equal(late.closes, 1, 'Cancelled late open closes only its own port');
assert.equal(store.getState().connected, false);
assert.equal(store.getState().serialMode, false);
assert.equal(store.getState().error, null);

store.getState().setUrl('webserial://local', true);
const invalid = new Port();
await store.getState().connectSerial(invalid, 2000000.5);
assert.equal(invalid.opens, 0);
assert.match(store.getState().error!, /整数|integer/);
const valid = new Port(); await store.getState().connectSerial(valid, 2000000);
const signal = wsClient.signal; const disconnect = store.getState().disconnect();
assert.equal(signal.aborted, true, 'Manual disconnect invalidates synchronously');
assert.equal(store.getState().connected, false);
await disconnect;
assert.equal(valid.closes, 1);
assert.ok(calls.every(url => !/\/api\/serial\//.test(url)), 'No legacy agent lifecycle endpoints are called');
assert.ok(!JSON.stringify([...storage]).includes('session'), 'No lease persistence');
const customUrl = 'wss://custom.example/ws?session=customer-session&channel=2';
store.getState().setUrl(customUrl);
assert.equal(store.getState().url, customUrl, 'Custom network query parameters are not agent credentials to strip');
assert.equal(storage.get('wireless_debug_ws_url'), customUrl);
console.log('browser serial store regression passed (native Streams; no physical ports)');
}
