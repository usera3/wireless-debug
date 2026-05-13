import { create } from 'zustand';

interface ModbusOscState {
  running: boolean;
  interval: number;       // ms, minimum 100
  selectedPage: string;
  /** alias -> 采样值数组（实际值） */
  waveData: Map<string, number[]>;
  setRunning: (v: boolean) => void;
  setInterval: (v: number) => void;
  setSelectedPage: (page: string) => void;
  pushSamples: (samples: Record<string, number>) => void;
  clearWaveData: () => void;
}

export const useModbusOscStore = create<ModbusOscState>((set) => ({
  running: false,
  interval: 500,
  selectedPage: '',
  waveData: new Map(),
  setRunning: (v) => set({ running: v }),
  setInterval: (v) => set({ interval: Math.max(100, v) }),
  setSelectedPage: (page) => set({ selectedPage: page }),
  pushSamples: (samples) =>
    set((s) => {
      const map = new Map(s.waveData);
      for (const [alias, val] of Object.entries(samples)) {
        const existing = map.get(alias) ?? [];
        map.set(alias, [...existing, val]);
      }
      return { waveData: map };
    }),
  clearWaveData: () => set({ waveData: new Map() }),
}));
