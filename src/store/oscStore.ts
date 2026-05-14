import { create } from 'zustand';

export interface ChannelConfig {
  channelNo: number;  // 1-based
  varAddr: number;    // 变量地址
  paramType: number;  // 0x00-0x04
  label: string;
  byteWidth: number;  // 2/4/8
}

export interface ChannelRowState {
  varAddrHex: string;
  paramType: number;
  label: string;
}

export function defaultRow(channelNo: number): ChannelRowState {
  return { varAddrHex: '0000', paramType: 0x00, label: `CH${channelNo}` };
}

interface OscState {
  running: boolean;
  sampleRate: number;
  maxChannels: number;
  frameLen: number;
  channels: ChannelConfig[];
  waveData: Map<number, number[]>;
  // channel config form state (persisted across tab switches)
  configRows: ChannelRowState[];
  numChannels: number;
  setRunning: (v: boolean) => void;
  setSampleRate: (v: number) => void;
  setMaxChannels: (v: number) => void;
  setFrameLen: (v: number) => void;
  setChannels: (v: ChannelConfig[]) => void;
  pushSamples: (channelNo: number, samples: number[]) => void;
  batchPushSamples: (batch: Map<number, number[]>) => void;
  clearWaveData: () => void;
  setConfigRows: (rows: ChannelRowState[]) => void;
  setNumChannels: (n: number) => void;
}

export const useOscStore = create<OscState>((set) => ({
  running: false,
  sampleRate: 6000,
  maxChannels: 12,
  frameLen: 130,
  channels: [],
  waveData: new Map(),
  configRows: Array.from({ length: 4 }, (_, i) => defaultRow(i + 1)),
  numChannels: 4,
  setRunning: (v) => set({ running: v }),
  setSampleRate: (v) => set({ sampleRate: v }),
  setMaxChannels: (v) => set({ maxChannels: v }),
  setFrameLen: (v) => set({ frameLen: v }),
  setChannels: (v) => set({ channels: v }),
  pushSamples: (channelNo, samples) =>
    set((s) => {
      const map = new Map(s.waveData);
      const existing = map.get(channelNo) ?? [];
      map.set(channelNo, [...existing, ...samples]);
      return { waveData: map };
    }),
  batchPushSamples: (batch) =>
    set((s) => {
      const map = new Map(s.waveData);
      batch.forEach((samples, channelNo) => {
        const existing = map.get(channelNo) ?? [];
        map.set(channelNo, [...existing, ...samples]);
      });
      return { waveData: map };
    }),
  clearWaveData: () => set({ waveData: new Map() }),
  setConfigRows: (rows) => set({ configRows: rows }),
  setNumChannels: (n) => set({ numChannels: n }),
}));