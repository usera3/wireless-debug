import { create } from 'zustand';
import { wsClient } from '../lib/wsClient';

interface ConnectionState {
  url: string;
  connected: boolean;
  setUrl: (url: string) => void;
  connect: () => void;
  disconnect: () => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  url: import.meta.env.VITE_WS_URL ?? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
  connected: false,
  setUrl: (url) => set({ url }),
  connect: () => {
    wsClient.connect(get().url);
    set({ connected: true });
  },
  disconnect: () => {
    wsClient.disconnect();
    set({ connected: false });
  },
}));