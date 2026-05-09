import { create } from 'zustand';

export interface ChannelConfig {
  channelNo: number;  // 1-based
  varAddr: number;    // 变量地址
  paramType: number;  // 0x00-0x04
  label: string;
  byteWidth: number;  // 2/4/8
}

interface OscState {
  running: boolean;
  sampleRate: number;
  maxChannels: number;
  frameLen: number;
  channels: ChannelConfig[];
  waveData: Map<number, number[]>; // channelNo -> 最新 N 个点
  maxPoints: number;
  setRunning: (v: boolean) => void;
  setSampleRate: (v: number) => void;
  setMaxChannels: (v: number) => void;
  setFrameLen: (v: number) => void;
  setChannels: (v: ChannelConfig[]) => void;
  pushSamples: (channelNo: number, samples: number[]) => void;
  clearWaveData: () => void;
}

export const useOscStore = create<OscState>((set) => ({
  running: false,
  sampleRate: 6000,
  maxChannels: 12,
  frameLen: 130,
  channels: [],
  waveData: new Map(),
  maxPoints: 3000,
  setRunning: (v) => set({ running: v }),
  setSampleRate: (v) => set({ sampleRate: v }),
  setMaxChannels: (v) => set({ maxChannels: v }),
  setFrameLen: (v) => set({ frameLen: v }),
  setChannels: (v) => set({ channels: v }),
  pushSamples: (channelNo, samples) =>
    set((s) => {
      const map = new Map(s.waveData);
      const existing = map.get(channelNo) ?? [];
      const merged = [...existing, ...samples].slice(-s.maxPoints);
      map.set(channelNo, merged);
      return { waveData: map };
    }),
  clearWaveData: () => set({ waveData: new Map() }),
}));
