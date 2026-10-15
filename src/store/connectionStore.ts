import { create } from 'zustand';
import { wsClient } from '../lib/wsClient';
import { resolveConnectionTarget } from '../lib/connectionTarget';
import { selectInitialConnectionUrl } from '../lib/connectionPreference';
import { currentRuntimeInfo } from '../lib/runtimeMode';
import { BROWSER_SERIAL_URL, connectionChoiceFromUrl } from '../lib/connectionSelection';
import { deviceStatusJson, type AdapterStatus } from '../lib/deviceCapabilities';
import { SerialCleanupError, validateSerialBaud, type BrowserSerialApi, type BrowserSerialPort } from '../lib/browserSerial';
import { cleanupConnectionActivity } from '../lib/connectionLifecycle';
import { frameRouter } from '../lib/frameRouter';
import { useParamStore } from './paramStore';
import { useBootloaderStore } from './bootloaderStore';

const URL_LS_KEY = 'wireless_debug_ws_url';
const browserSerialAdapter: AdapterStatus = {
  adapter_kind: 'browser-serial',
  capabilities: { serial: true, wifi: false, ble: false, comm_mode: false, device_files: false },
};

function initialWsUrl(): string {
  const runtime = currentRuntimeInfo();
  const url = selectInitialConnectionUrl({
    remoteUrl: runtime.mode === 'cloud-device' ? runtime.defaultConnectionUrl : null,
    savedUrl: localStorage.getItem(URL_LS_KEY),
    defaultUrl: import.meta.env.VITE_WS_URL ?? runtime.defaultConnectionUrl,
    allowSavedUrl: runtime.mode !== 'cloud-platform',
  }) || '';
  if (runtime.mode === 'local-device' && url === BROWSER_SERIAL_URL) localStorage.setItem(URL_LS_KEY, url);
  return url;
}

interface ConnectionState {
  url: string;
  connected: boolean;
  connecting: boolean;
  serialMode: boolean;
  serialRecovering: boolean;
  serialNeedsConfirmation: boolean;
  // Actual transport's port/settings while opening or connected, not UI drafts.
  serialSession: { port: BrowserSerialPort; baud: number } | null;
  adapter: AdapterStatus | null;
  error: string | null;
  revision: number;
  setUrl: (url: string, serialMode?: boolean) => void;
  setAdapter: (url: string, adapter: AdapterStatus) => void;
  connect: (auto?: boolean) => Promise<void>;
  connectSerial: (port: BrowserSerialPort, baud: number) => Promise<void>;
  disconnect: () => Promise<void>;
}

interface SerialRecoveryTarget {
  port: BrowserSerialPort;
  baud: number;
  api: BrowserSerialApi;
  present: boolean;
  attempts: number;
}

export const useConnectionStore = create<ConnectionState>((set, get) => {
  let handshake: { resolve: () => void; reject: (error: Error) => void } | null = null;
  let serialTarget: SerialRecoveryTarget | null = null;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryNoticeRevision = 0;
  let removeSerialListeners = () => {};
  function clearRecoveryTimer() {
    clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
  }
  function forgetSerialTarget() {
    recoveryNoticeRevision++;
    clearRecoveryTimer();
    removeSerialListeners();
    removeSerialListeners = () => {};
    serialTarget = null;
  }
  async function refreshRecoveryNotice(target: SerialRecoveryTarget) {
    const noticeRevision = ++recoveryNoticeRevision;
    const revision = get().revision;
    const current = () => serialTarget === target && get().serialMode &&
      get().revision === revision && recoveryNoticeRevision === noticeRevision &&
      get().serialRecovering && !get().connected && !get().connecting;
    if (!current()) return;
    try {
      const granted = await target.api.getPorts();
      if (!current()) return;
      // An authorized object is not proof of physical identity, even if its
      // VID/PID matches. Only expose a manual choice; never replace the target.
      set({ serialNeedsConfirmation: !granted.includes(target.port) && granted.length > 0 });
    } catch { /* Discovery failure must not replace transport/cleanup errors. */ }
  }
  function scheduleRecovery(target: SerialRecoveryTarget, delay = 600) {
    clearRecoveryTimer();
    if (serialTarget !== target || !target.present) return;
    recoveryTimer = setTimeout(() => { recoveryTimer = undefined; void recoverSerial(target); }, delay);
  }
  async function recoverSerial(target: SerialRecoveryTarget) {
    if (serialTarget !== target || !target.present || !get().serialRecovering || get().connected || get().connecting) return;
    const revision = get().revision + 1;
    const current = () => serialTarget === target && get().serialMode && get().revision === revision;
    target.attempts++;
    set({ revision, connecting: true, serialNeedsConfirmation: false, serialSession: { port: target.port, baud: target.baud }, error: null });
    try {
      const granted = await target.api.getPorts();
      if (!current()) return;
      if (!target.present) { set({ connecting: false, serialSession: null }); return; }
      if (!granted.includes(target.port)) throw new DOMException('原串口授权已失效，请重新选择并授权串口', 'NotAllowedError');
      if (useBootloaderStore.getState().isFlashing) throw new DOMException('烧录期间停止自动重连', 'InvalidStateError');
      // The facade waits for the old generation's owned streams to be released.
      await wsClient.connectSerial(target.port, target.baud);
      if (current()) set({ serialRecovering: false });
    } catch (error) {
      if (!current()) return;
      const err = error as Error;
      const terminal = err instanceof SerialCleanupError || ['NotAllowedError', 'SecurityError', 'InvalidStateError'].includes(err.name) || target.attempts >= 3;
      set({ connected: false, connecting: false, serialRecovering: !terminal, serialNeedsConfirmation: false, serialSession: null,
        error: terminal ? `自动重连失败：${err.message}。请检查设备后手动连接` : `串口暂未就绪，正在重试：${err.message}` });
      if (terminal) forgetSerialTarget();
      else scheduleRecovery(target, 1000);
    }
  }
  function rememberSerialTarget(port: BrowserSerialPort, baud: number) {
    forgetSerialTarget();
    const api = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { serial?: BrowserSerialApi }).serial;
    if (!api) return;
    const target: SerialRecoveryTarget = { port, baud, api, present: true, attempts: 0 };
    serialTarget = target;
    const changed: EventListener = event => {
      const changedPort = (event as Event & { port?: BrowserSerialPort }).port ?? event.target;
      if (serialTarget !== target) return;
      if (changedPort !== port) { void refreshRecoveryNotice(target); return; }
      const wasPresent = target.present;
      target.present = event.type === 'connect';
      if (target.present) {
        if (!wasPresent) target.attempts = 0;
        // Duplicate notifications must not refill the retry budget or postpone
        // an existing timer. A read/write fault can precede any removal event.
        if (!wasPresent || (target.attempts === 0 && recoveryTimer === undefined)) scheduleRecovery(target);
      }
      else {
        clearRecoveryTimer();
        if (get().serialRecovering && get().connecting) {
          // Removal can happen before the new transport owns streams/listeners,
          // while it is still awaiting old cleanup or a late native open.
          set({ revision: get().revision + 1, connecting: false, serialSession: null });
          void wsClient.disconnect().catch(error => {
            if (serialTarget !== target || !get().serialRecovering) return;
            forgetSerialTarget();
            set({ connecting: false, serialRecovering: false, serialNeedsConfirmation: false, serialSession: null,
              error: `释放串口失败：${(error as Error).message}。自动重连已停止，请检查设备后手动连接` });
          });
        }
      }
      void refreshRecoveryNotice(target);
    };
    api.addEventListener('connect', changed);
    api.addEventListener('disconnect', changed);
    removeSerialListeners = () => {
      api.removeEventListener('connect', changed);
      api.removeEventListener('disconnect', changed);
    };
  }
  function resetActivity() {
    cleanupConnectionActivity();
    useParamStore.getState().setDashboardEnabled(false);
    frameRouter.onOscFrame(() => {});
    frameRouter.onModbusFrame(() => {});
    frameRouter.reset();
  }
  function socketConnect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const pending = {
        resolve: () => { clearTimeout(timer); handshake = null; resolve(); },
        reject: (error: Error) => { clearTimeout(timer); handshake = null; reject(error); },
      };
      const timer = setTimeout(() => { if (handshake === pending) pending.reject(new Error('WebSocket 连接超时')); }, 8000);
      handshake = pending;
      try { wsClient.connect(url); } catch { handshake.reject(new Error('WebSocket 连接失败')); }
    });
  }
  wsClient.onOpen(() => {
    if (serialTarget) serialTarget.attempts = 0;
    set({ connected: true, connecting: false, serialRecovering: false, serialNeedsConfirmation: false });
    handshake?.resolve();
  });
  wsClient.onClose((error) => {
    const serial = get().serialMode;
    const recoveryTarget = serialTarget;
    // Capture programming before activity cleanup clears its lock.
    const recover = serial && recoveryTarget !== null && !useBootloaderStore.getState().isFlashing;
    if (!recover) forgetSerialTarget();
    // Cloud controllers already tolerate transient WebSocket loss. Keep that
    // policy; serial/local loss and explicit disconnects still stop activity.
    if (serial || resolveConnectionTarget(get().url).kind !== 'cloud') resetActivity();
    handshake?.reject(new Error('WebSocket 连接失败或已断开'));
    const revision = get().revision + 1;
    const message = serial ? `串口意外断开：${error?.message || '设备已移除'}。${recover ? '等待原端口恢复；若浏览器端口身份变化，需手动确认' : '请检查设备并手动重新连接'}` : 'WebSocket 已断开';
    set({ connected: false, connecting: false, serialRecovering: recover, serialNeedsConfirmation: false, serialSession: null, error: message, revision });
    if (recover) void refreshRecoveryNotice(recoveryTarget);
    // Fault invalidation has already begun transport cleanup. Observe its result
    // even during programming, and never overwrite a replacement connection.
    void wsClient.disconnect().catch(cleanupError => {
      if (get().revision === revision || (recoveryTarget !== null && serialTarget === recoveryTarget && get().serialRecovering)) {
        forgetSerialTarget();
        set({ connecting: false, serialRecovering: false, serialNeedsConfirmation: false, serialSession: null, error: `释放串口失败：${(cleanupError as Error).message}。自动重连已停止，请检查设备后手动连接` });
      }
    });
  });
  const initialUrl = initialWsUrl();

  return {
    url: initialUrl,
    connected: false,
    connecting: false,
    serialMode: initialUrl === BROWSER_SERIAL_URL,
    serialRecovering: false,
    serialNeedsConfirmation: false,
    serialSession: null,
    adapter: initialUrl === BROWSER_SERIAL_URL ? browserSerialAdapter : null,
    error: null,
    revision: 0,
    setUrl: (input, serialMode) => {
      if (useBootloaderStore.getState().isFlashing) { set({ error: '固件烧录期间不能切换连接' }); return; }
      void get().disconnect();
      const serial = serialMode ?? connectionChoiceFromUrl(input) === 'serial';
      const url = serial ? BROWSER_SERIAL_URL : input;
      localStorage.setItem(URL_LS_KEY, url);
      set({ url, serialMode: serial, adapter: serial ? browserSerialAdapter : null, error: null, revision: get().revision + 1 });
    },
    setAdapter: (url, adapter) => {
      if (get().url !== url) return;
      if (!get().serialMode) set({ adapter });
    },
    connect: async (auto = false) => {
      if (get().serialMode || get().connecting || get().connected || useBootloaderStore.getState().isFlashing) return;
      const url = get().url;
      const revision = get().revision + 1;
      const target = resolveConnectionTarget(url, window.location.origin);
      if (target.kind === 'invalid') { set({ error: target.error }); return; }
      set({ connecting: true, error: null, revision });
      try {
        // Keep network capability discovery and legacy ESP32 fallback.
        try {
          const adapter = await deviceStatusJson<AdapterStatus>(target.apiBase, '/api/device/status');
          if (get().revision !== revision) return;
          get().setAdapter(url, adapter);
        } catch { /* Legacy status endpoint may be unavailable. */ }
        if (get().revision !== revision || (auto && get().serialMode)) return;
        await socketConnect(target.wsUrl);
      } catch (error) {
        if (get().revision === revision) { void wsClient.disconnect().catch(() => {}); set({ connected: false, connecting: false, error: (error as Error).message }); }
      }
    },
    connectSerial: async (port, baud) => {
      if (!get().serialMode || get().connecting || get().connected || useBootloaderStore.getState().isFlashing) return;
      forgetSerialTarget();
      const revision = get().revision + 1;
      set({ revision, connecting: true, serialRecovering: false, serialNeedsConfirmation: false, serialSession: { port, baud }, error: null });
      try {
        if (!port) throw new Error('请选择串口端口');
        validateSerialBaud(baud);
        await wsClient.connectSerial(port, baud);
        if (get().revision === revision && get().connected) rememberSerialTarget(port, baud);
      } catch (error) {
        if (get().revision === revision) {
          resetActivity();
          set({ connecting: false, connected: false, serialSession: null, error: `打开串口失败：${(error as Error).message}。请关闭占用串口的其他程序，检查设备和权限后重试` });
        }
      }
    },
    disconnect: async () => {
      if (useBootloaderStore.getState().isFlashing) { set({ error: '固件烧录期间不能断开连接' }); return; }
      const wasRecovering = get().serialRecovering;
      forgetSerialTarget();
      resetActivity();
      handshake?.reject(new Error('连接已取消'));
      const cleanup = wsClient.disconnect();
      const revision = get().revision + 1;
      set({ connected: false, connecting: false, serialRecovering: false, serialNeedsConfirmation: false, serialSession: null, error: wasRecovering ? null : get().error, revision });
      try { await cleanup; }
      catch (error) { if (get().revision === revision) set({ error: `释放串口失败：${(error as Error).message}` }); }
    },
  };
});
