import { BrowserSerialConnection, serialConnectionCancelled } from './browserSerial';
import type { BrowserSerialPort } from './browserSerial';

type FrameHandler = (frame: Uint8Array) => void;
type RawHook = (data: Uint8Array) => void;
type StateHook = () => void;
type CloseHook = (error?: Error) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private serial: BrowserSerialConnection | null = null;
  private pendingCleanup = new Set<Promise<void>>();
  private connectionGeneration = 0;
  private generationAbort = new AbortController();

  private advanceGeneration() {
    this.connectionGeneration += 1;
    this.generationAbort.abort();
    this.generationAbort = new AbortController();
  }
  get signal(): AbortSignal { return this.generationAbort.signal; }
  private handlers: FrameHandler[] = [];
  private rawSendHooks: RawHook[] = [];
  private openHook: StateHook = () => {};
  private closeHook: CloseHook = () => {};

  private trackCleanup(cleanup: Promise<void>) {
    this.pendingCleanup.add(cleanup);
    // Legacy callers may ignore disconnect's promise. Awaiters still receive failures.
    void cleanup.catch(() => {});
  }

  private invalidate() {
    const socket = this.ws;
    const serial = this.serial;
    this.ws = null;
    this.serial = null;
    this.advanceGeneration();
    socket?.close();
    if (serial) this.trackCleanup(serial.close());
  }

  async connectSerial(port: BrowserSerialPort, baud: number): Promise<void> {
    this.invalidate();
    const generation = this.generation;
    const serial = new BrowserSerialConnection(port, chunk => {
      if (this.serial === serial) this.onData(chunk);
    }, error => {
      if (this.serial !== serial) return;
      this.invalidate();
      this.closeHook(error);
    });
    this.serial = serial;
    try {
      await this.awaitCleanup();
      if (this.generation !== generation) throw serialConnectionCancelled();
      await serial.open(baud);
      if (this.serial !== serial) throw serialConnectionCancelled();
      this.openHook();
    } catch (error) {
      if (this.serial === serial) this.invalidate();
      // The caller owns errors from this open attempt, including its cleanup.
      await serial.close();
      throw error;
    }
  }

  connect(url: string) {
    this.invalidate();
    const socket = new WebSocket(url);
    this.ws = socket;
    this.advanceGeneration();
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      if (this.ws === socket) this.openHook();
    };
    const closeCurrentSocket = () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.advanceGeneration();
      socket.close();
      this.closeHook();
    };
    socket.onclose = closeCurrentSocket;
    socket.onerror = closeCurrentSocket;
    socket.onmessage = (e) => {
      if (this.ws === socket) this.onData(new Uint8Array(e.data as ArrayBuffer));
    };
  }

  private awaitCleanup(): Promise<void> {
    const pending = [...this.pendingCleanup];
    const result = Promise.all(pending).then(() => {});
    void result.then(() => pending.forEach(item => this.pendingCleanup.delete(item)),
      () => pending.forEach(item => this.pendingCleanup.delete(item)));
    // Observe without changing the returned promise's rejection for awaiters.
    void result.catch(() => {});
    return result;
  }

  disconnect(): Promise<void> {
    this.invalidate();
    return this.awaitCleanup();
  }

  send(data: Uint8Array) {
    this.rawSendHooks.forEach((h) => h(data));
    if (this.serial) { this.serial.send(data); return; }
    this.ws?.send(data);
  }

  onFrame(handler: FrameHandler) {
    this.handlers.push(handler);
  }

  removeHandler(handler: FrameHandler) {
    this.handlers = this.handlers.filter((h) => h !== handler);
  }

  /** 注册原始发送钩子（调试用） */
  onRawSend(hook: RawHook) { this.rawSendHooks.push(hook); }

  get readyState(): number {
    return this.serial?.readyState ?? this.ws?.readyState ?? 3;
  }

  get transportKind(): 'serial' | 'websocket' | null {
    return this.serial ? 'serial' : this.ws ? 'websocket' : null;
  }

  get generation(): number {
    return this.connectionGeneration;
  }

  onOpen(hook: StateHook) { this.openHook = hook; }
  onClose(hook: CloseHook) { this.closeHook = hook; }

  private onData(chunk: Uint8Array) {
    // 直接把每个 WS 消息分发给所有 handler，由 frameRouter 自行维护跨消息 buffer
    this.handlers.forEach((h) => h(chunk));
  }
}

export const wsClient = new WsClient();
