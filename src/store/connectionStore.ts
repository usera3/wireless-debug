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
  url: 'ws://192.168.4.1:8765',
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
