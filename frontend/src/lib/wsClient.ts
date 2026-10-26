type FrameHandler = (frame: Uint8Array) => void;
type RawHook = (data: Uint8Array) => void;
type StateHook = () => void;

const RECONNECT_BASE_DELAY_MS = 300;
const RECONNECT_MAX_DELAY_MS = 5000;

function reconnectDelayMs(attempt: number): number {
  const exponential = Math.min(RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * (2 ** Math.min(attempt, 8)));
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.min(RECONNECT_MAX_DELAY_MS, Math.round(exponential * jitter));
}

export class WsClient {
  private ws: WebSocket | null = null;
  private desiredUrl: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private connectionGeneration = 0;
  private handlers: FrameHandler[] = [];
  private rawSendHooks: RawHook[] = [];
  private connectingHook: StateHook = () => {};
  private openHook: StateHook = () => {};
  private closeHooks: StateHook[] = [];
  private connectionResetHooks: StateHook[] = [];

  connect(url: string) {
    this.desiredUrl = url;
    this.reconnectAttempt = 0;
    this.cancelReconnect();
    this.closeCurrentSocket();
    this.openSocket(url);
  }

  private openSocket(url: string) {
    if (this.desiredUrl !== url) return;
    const socket = new WebSocket(url);
    this.ws = socket;
    this.connectionGeneration += 1;
    this.connectingHook();
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.reconnectAttempt = 0;
      this.cancelReconnect();
      this.openHook();
    };
    const closeCurrentSocket = () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.connectionGeneration += 1;
      this.connectionResetHooks.forEach((hook) => hook());
      this.closeHooks.forEach((hook) => hook());
      this.scheduleReconnect();
    };
    socket.onclose = closeCurrentSocket;
    socket.onerror = () => {
      socket.close();
      closeCurrentSocket();
    };
    socket.onmessage = (e) => {
      if (this.ws === socket) this.onData(new Uint8Array(e.data as ArrayBuffer));
    };
  }

  disconnect() {
    this.desiredUrl = null;
    this.reconnectAttempt = 0;
    this.cancelReconnect();
    this.closeCurrentSocket();
  }

  send(data: Uint8Array): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.rawSendHooks.forEach((h) => h(data));
    this.ws.send(data);
    return true;
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
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }

  get generation(): number {
    return this.connectionGeneration;
  }

  get wantsConnection(): boolean {
    return this.desiredUrl !== null;
  }

  onConnecting(hook: StateHook) { this.connectingHook = hook; }
  onOpen(hook: StateHook) { this.openHook = hook; }
  onClose(hook: StateHook) {
    this.closeHooks.push(hook);
    return () => {
      this.closeHooks = this.closeHooks.filter((candidate) => candidate !== hook);
    };
  }
  onConnectionReset(hook: StateHook) {
    this.connectionResetHooks.push(hook);
    return () => {
      this.connectionResetHooks = this.connectionResetHooks.filter(
        (candidate) => candidate !== hook,
      );
    };
  }

  private closeCurrentSocket() {
    const socket = this.ws;
    this.ws = null;
    this.connectionGeneration += 1;
    socket?.close();
    if (socket !== null) this.connectionResetHooks.forEach((hook) => hook());
  }

  private cancelReconnect() {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleReconnect() {
    if (this.desiredUrl === null || this.reconnectTimer !== null) return;
    const delay = reconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      const url = this.desiredUrl;
      if (url !== null) this.openSocket(url);
    }, delay);
  }

  private onData(chunk: Uint8Array) {
    // 直接把每个 WS 消息分发给所有 handler，由 frameRouter 自行维护跨消息 buffer
    this.handlers.forEach((h) => h(chunk));
  }
}

export const wsClient = new WsClient();
