import { create } from 'zustand';

const MAX_ENTRIES = 300;

export interface DebugEntry {
  id: number;
  dir: 'tx' | 'rx';
  ts: number;        // Date.now()
  hex: string;
  desc: string;
}

interface DebugState {
  entries: DebugEntry[];
  paused: boolean;
  addEntry: (entry: Omit<DebugEntry, 'id'>) => void;
  clear: () => void;
  setPaused: (v: boolean) => void;
}

let _id = 0;

export const useDebugStore = create<DebugState>((set) => ({
  entries: [],
  paused: true,
  addEntry: (entry) =>
    set((s) => {
      if (s.paused) return s;
      const next = [...s.entries, { ...entry, id: ++_id }];
      return { entries: next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next };
    }),
  clear: () => set({ entries: [] }),
  setPaused: (v) => set({ paused: v }),
}));
