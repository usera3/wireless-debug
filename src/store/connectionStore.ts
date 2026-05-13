import { create } from 'zustand';
import { wsClient } from '../lib/wsClient';

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
    url: import.meta.env.VITE_WS_URL ?? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
    connected: false,
    connecting: false,
    setUrl: (url) => set({ url }),
    connect: () => {
      set({ connecting: true, connected: false });
      wsClient.connect(get().url);
    },
    disconnect: () => {
      wsClient.disconnect();
      set({ connected: false, connecting: false });
    },
  };
});