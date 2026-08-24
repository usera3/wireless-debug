import { create } from 'zustand';
import { wsClient } from '../lib/wsClient';
import { resolveConnectionTarget } from '../lib/connectionTarget';
import { selectInitialConnectionUrl } from '../lib/connectionPreference';
import { currentRuntimeInfo } from '../lib/runtimeMode';

const URL_LS_KEY = 'wireless_debug_ws_url';

function initialWsUrl(): string {
  const runtime = currentRuntimeInfo();
  return selectInitialConnectionUrl({
    remoteUrl: runtime.mode === 'cloud-device' ? runtime.defaultConnectionUrl : null,
    savedUrl: localStorage.getItem(URL_LS_KEY),
    defaultUrl: import.meta.env.VITE_WS_URL ?? runtime.defaultConnectionUrl,
    allowSavedUrl: runtime.mode !== 'cloud-platform',
  }) || '';
}

interface ConnectionState {
  url: string;
  connected: boolean;
  connecting: boolean;
  setUrl: (url: string) => void;
  connect: () => void;
  disconnect: () => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => {
  // 注册 WebSocket 事件回调，驱动连接状态
  wsClient.onOpen(() => set({ connected: true, connecting: false }));
  wsClient.onClose(() => set({ connected: false, connecting: false }));

  return {
    url: initialWsUrl(),
    connected: false,
    connecting: false,
    setUrl: (url) => {
      localStorage.setItem(URL_LS_KEY, url);
      set({ url });
    },
    connect: () => {
      const target = resolveConnectionTarget(get().url, window.location.origin);
      if (target.kind === 'invalid') {
        set({ connecting: false, connected: false });
        return;
      }
      set({ connecting: true, connected: false });
      wsClient.connect(target.wsUrl);
    },
    disconnect: () => {
      wsClient.disconnect();
      set({ connected: false, connecting: false });
    },
  };
});
