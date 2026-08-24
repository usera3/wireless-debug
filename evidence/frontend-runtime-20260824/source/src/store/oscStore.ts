import { create } from 'zustand';
import { oscHistory, OscHistoryStats } from '../lib/oscHistory';
import type { OscChannelTypeKey } from '../lib/oscChannelTypes';

export const OSC_VIEW_WINDOW_OPTIONS = [5, 10, 30, 60];
export const OSC_HISTORY_RETENTION_OPTIONS = [60, 300, 600, 1800];
export const OSC_DEFAULT_VIEW_WINDOW_SECONDS = 10;
export const OSC_DEFAULT_RETENTION_SECONDS = 300;

export interface ChannelConfig {
  channelNo: number;  // 1-based
  varAddr: number;    // 变量地址
  typeKey: OscChannelTypeKey;
  label: string;
}

export interface ChannelRowState {
  varAddrHex: string;
  typeKey: OscChannelTypeKey;
  label: string;
}

export function defaultRow(channelNo: number): ChannelRowState {
  return { varAddrHex: '0000', typeKey: 'default-int16', label: `CH${channelNo}` };
}

interface OscState {
  running: boolean;
  startError: string | null;
  sampleRate: number;
  maxChannels: number;
  frameLen: number;
  channels: ChannelConfig[];
  historyVersion: number;
  historyStats: OscHistoryStats;
  viewWindowSeconds: number;
  retentionSeconds: number;
  viewPaused: boolean;
  reviewEndSeconds: number | null;
  // channel config form state (persisted across tab switches)
  configRows: ChannelRowState[];
  numChannels: number;
  /** 通讯速率限制（bit/s），0 = 不限制 */
  commRateLimit: number;
  setRunning: (v: boolean) => void;
  setStartError: (v: string | null) => void;
  setSampleRate: (v: number) => void;
  setMaxChannels: (v: number) => void;
  setFrameLen: (v: number) => void;
  setChannels: (v: ChannelConfig[]) => void;
  appendSamples: (batch: Map<number, number[]>, elapsedMs?: number) => void;
  resetHistory: (channels?: ChannelConfig[], sampleRate?: number) => void;
  refreshHistoryStats: () => void;
  setViewWindowSeconds: (v: number) => void;
  setRetentionSeconds: (v: number) => void;
  setViewPaused: (v: boolean) => void;
  setReviewEndSeconds: (v: number | null) => void;
  setConfigRows: (rows: ChannelRowState[]) => void;
  setNumChannels: (n: number) => void;
  setCommRateLimit: (v: number) => void;
}

function normalizeWindow(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return OSC_DEFAULT_VIEW_WINDOW_SECONDS;
  // 视口允许亚秒值；图表层按采样间隔保证至少能看到一个样本。
  return seconds;
}

function normalizeRetention(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return OSC_DEFAULT_RETENTION_SECONDS;
  return Math.max(1, seconds);
}

export const useOscStore = create<OscState>((set, get) => ({
  running: false,
  startError: null,
  sampleRate: 6000,
  maxChannels: 12,
  frameLen: 130,
  channels: [],
  historyVersion: oscHistory.getStats().version,
  historyStats: oscHistory.getStats(),
  viewWindowSeconds: OSC_DEFAULT_VIEW_WINDOW_SECONDS,
  retentionSeconds: OSC_DEFAULT_RETENTION_SECONDS,
  viewPaused: false,
  reviewEndSeconds: null,
  configRows: Array.from({ length: 4 }, (_, i) => defaultRow(i + 1)),
  numChannels: 4,
  commRateLimit: 0,
  setRunning: (v) => set({ running: v }),
  setStartError: (v) => set({ startError: v }),
  setSampleRate: (v) => {
    oscHistory.setSampleRate(v);
    const stats = oscHistory.getStats();
    set({ sampleRate: v, historyStats: stats, historyVersion: stats.version });
  },
  setMaxChannels: (v) => set({ maxChannels: v }),
  setFrameLen: (v) => set({ frameLen: v }),
  setChannels: (v) => set({ channels: v }),
  appendSamples: (batch) => {
    if (batch.size === 0) return;
    oscHistory.appendBatch(batch);
    const stats = oscHistory.getStats();
    set({ historyStats: stats, historyVersion: stats.version });
  },
  resetHistory: (channels, sampleRate) => {
    const state = get();
    const nextChannels = channels ?? state.channels;
    const nextSampleRate = sampleRate ?? state.sampleRate;
    oscHistory.reset(
      nextChannels.map((channel) => channel.channelNo),
      nextSampleRate,
      state.retentionSeconds,
    );
    const stats = oscHistory.getStats();
    set({
      channels: nextChannels,
      sampleRate: nextSampleRate,
      historyStats: stats,
      historyVersion: stats.version,
      reviewEndSeconds: null,
    });
  },
  refreshHistoryStats: () => {
    const stats = oscHistory.getStats();
    set({ historyStats: stats, historyVersion: stats.version });
  },
  setViewWindowSeconds: (v) => set({ viewWindowSeconds: normalizeWindow(v) }),
  setRetentionSeconds: (v) => {
    const retentionSeconds = normalizeRetention(v);
    oscHistory.setRetentionSeconds(retentionSeconds);
    const stats = oscHistory.getStats();
    set({ retentionSeconds, historyStats: stats, historyVersion: stats.version });
  },
  setViewPaused: (v) => set({ viewPaused: v }),
  setReviewEndSeconds: (v) => set({ reviewEndSeconds: v }),
  setConfigRows: (rows) => set({ configRows: rows }),
  setNumChannels: (n) => set({ numChannels: n }),
  setCommRateLimit: (v) => set({ commRateLimit: v }),
}));
