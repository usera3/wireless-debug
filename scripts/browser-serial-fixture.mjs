/** Install only the browser/OS serial boundary. Protocol replies belong to tests. */
export function installBrowserSerialFixture(options = {}) {
  const fixture = { requests: 0, discoveries: 0, opens: 0, closes: 0, writes: [], business: [], ports: [], granted: [], pendingDiscovery: [], pendingDiscoveryErrors: [], pendingChooser: [], pendingOpen: [], allowNetworkAttempts: !!options.remoteDevice };
  class Port extends EventTarget {
    readable = null; writable = null;
    constructor(id) { super(); this.id = id; }
    getInfo() { return options.portInfo?.[this.id - 1] ?? { usbVendorId: 0x1234, usbProductId: 0x5600 + this.id }; }
    async open(settings) {
      fixture.opens++; this.settings = settings;
      if (fixture.openError) throw new DOMException(fixture.openError, 'NetworkError');
      if (fixture.deferOpen) await new Promise(resolve => fixture.pendingOpen.push(resolve));
      this.readable = new ReadableStream({ start: c => { this.reader = c; }, cancel: () => { fixture.cancelled = (fixture.cancelled || 0) + 1; } });
      this.writable = new WritableStream({ write: bytes => {
        if (fixture.writeError) throw new Error(fixture.writeError);
        const copy = Array.from(bytes);
        fixture.writes.push(copy);
        return fixture.onWrite?.(copy, this);
      }, abort: () => { fixture.aborted = (fixture.aborted || 0) + 1; } });
    }
    async close() { fixture.closes++; if (fixture.closeError) throw new Error(fixture.closeError); }
  }
  fixture.ports = [new Port(1), new Port(2)];
  fixture.receive = (bytes, splits = [bytes.length], port = fixture.ports[0]) => {
    let offset = 0, index = 0;
    while (offset < bytes.length) {
      const size = splits[index++ % splits.length];
      if (!Number.isInteger(size) || size <= 0) throw new Error('RX split sizes must be positive integers');
      port.reader.enqueue(new Uint8Array(bytes.slice(offset, offset + size)));
      offset += size;
    }
  };
  fixture.granted = fixture.ports.slice(0, options.granted || 0);
  const api = new EventTarget();
  api.getPorts = async () => {
    fixture.discoveries++;
    if (fixture.deferDiscovery) return new Promise((resolve, reject) => { fixture.pendingDiscovery.push(resolve); fixture.pendingDiscoveryErrors.push(reject); });
    return fixture.granted.slice();
  };
  api.requestPort = () => {
    fixture.requests++;
    fixture.chooserActivated = navigator.userActivation.isActive;
    if (fixture.chooserError) return Promise.reject(new DOMException('chooser refused', fixture.chooserError));
    const grant = () => { const port = fixture.ports[0]; if (!fixture.granted.includes(port)) fixture.granted.push(port); return port; };
    if (fixture.deferChooser) return new Promise(resolve => fixture.pendingChooser.push(() => resolve(grant())));
    return Promise.resolve(grant());
  };
  fixture.event = (kind, id) => {
    const port = fixture.ports[id];
    if (kind === 'disconnect') fixture.granted = fixture.granted.filter(item => item !== port);
    else if (!fixture.granted.includes(port)) fixture.granted.push(port);
    const event = new Event(kind); Object.defineProperty(event, 'port', { value: port }); api.dispatchEvent(event);
    if (kind === 'disconnect') port.dispatchEvent(new Event('disconnect'));
  };
  fixture.api = api;
  if (options.supported !== false) Object.defineProperty(navigator, 'serial', { configurable: true, value: api });
  else Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
  if (options.insecure) Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
  localStorage.setItem('wireless_debug_ws_url', options.savedUrl || 'webserial://local');
  if (options.remoteDevice) {
    window.__WIRELESS_REMOTE_DEVICE_ID = 'test-cloud-device';
    window.__WIRELESS_REMOTE_WS_URL = 'wss://cloud.example/ws/device/test-cloud-device';
  }
  const nativeFetch = window.fetch;
  window.fetch = (...args) => {
    if (!fixture.allowNetworkAttempts) fixture.business.push(`fetch:${String(args[0])}`);
    return Promise.reject(new Error('Business HTTP forbidden in browser serial fixture'));
  };
  fixture.restoreFetch = () => { window.fetch = nativeFetch; };
  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(url, protocols) {
      if (protocols !== 'vite-hmr') { if (!fixture.allowNetworkAttempts) fixture.business.push(`ws:${url}`); throw new Error('Business WS forbidden in browser serial fixture'); }
      super(url, protocols);
    }
  };
  window.__serialFixture = fixture;
}
