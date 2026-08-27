import { create } from 'zustand';
import {
  OscHistory,
  OscHistoryStats,
} from '../lib/oscHistory';
import {
  OSC_DEFAULT_RETENTION_SECONDS,
  OSC_DEFAULT_VIEW_WINDOW_SECONDS,
} from './oscStore';

export const modbusOscHistory = new OscHistory();

export interface ModbusOscIoStats {
  requests: number;
  responses: number;
  samples: number;
  errors: number;
  lastMessage: string;
  lastError: string;
  lastResponseBytes: number;
  lastSampleAt: number | null;
}

interface ModbusOscState {
  running: boolean;
  interval: number;       // ms, minimum 100
  selectedPage: string;
  readChunkSize: number;  // 每次读取的最大参数数，0 表示不分组
  aliases: string[];
  historyVersion: number;
  historyStats: OscHistoryStats;
  viewWindowSeconds: number;
  retentionSeconds: number;
  viewPaused: boolean;
  reviewEndSeconds: number | null;
  ioStats: ModbusOscIoStats;
  /** alias -> 采样值数组（实际值） */
  waveData: Map<string, number[]>;
  setRunning: (v: boolean) => void;
  setInterval: (v: number) => void;
  setSelectedPage: (page: string) => void;
  setReadChunkSize: (v: number) => void;
  resetHistory: (aliases: string[], sampleRate?: number) => void;
  pushSamples: (samples: Record<string, number>) => void;
  appendColumns: (columns: number[][]) => void;
  refreshHistoryStats: () => void;
  setViewWindowSeconds: (v: number) => void;
  setRetentionSeconds: (v: number) => void;
  setViewPaused: (v: boolean) => void;
  setReviewEndSeconds: (v: number | null) => void;
  resetIoStats: () => void;
  recordIoRequest: () => void;
  recordIoResponse: (bytes: number) => void;
  recordIoSamples: (count: number) => void;
  recordIoError: (message: string) => void;
  clearWaveData: () => void;
}

function normalizeIntervalMs(value: number): number {
  return Math.max(100, Number.isFinite(value) ? value : 500);
}

function sampleRateFromInterval(intervalMs: number): number {
  return 1000 / normalizeIntervalMs(intervalMs);
}

function channelNosForAliases(aliases: string[]): number[] {
  return aliases.map((_, index) => index + 1);
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

function waveDataFromColumns(aliases: string[], columns: number[][]): Map<string, number[]> {
  return new Map(aliases.map((alias, index) => [alias, columns[index] ?? []]));
}

function createIoStats(): ModbusOscIoStats {
  return {
    requests: 0,
    responses: 0,
    samples: 0,
    errors: 0,
    lastMessage: '等待启动',
    lastError: '',
    lastResponseBytes: 0,
    lastSampleAt: null,
  };
}

export const useModbusOscStore = create<ModbusOscState>((set) => ({
  running: false,
  interval: 500,
  selectedPage: '',
  readChunkSize: 0,
  aliases: [],
  historyVersion: modbusOscHistory.getStats().version,
  historyStats: modbusOscHistory.getStats(),
  viewWindowSeconds: OSC_DEFAULT_VIEW_WINDOW_SECONDS,
  retentionSeconds: OSC_DEFAULT_RETENTION_SECONDS,
  viewPaused: false,
  reviewEndSeconds: null,
  ioStats: createIoStats(),
  waveData: new Map(),
  setRunning: (v) => set({ running: v }),
  setInterval: (v) => {
    const interval = normalizeIntervalMs(v);
    modbusOscHistory.setSampleRate(sampleRateFromInterval(interval));
    const stats = modbusOscHistory.getStats();
    set({ interval, historyStats: stats, historyVersion: stats.version });
  },
  setSelectedPage: (page) => set({ selectedPage: page }),
  setReadChunkSize: (v) => set({ readChunkSize: Math.max(0, v) }),
  resetHistory: (aliases, sampleRate) => {
    const nextAliases = aliases.filter(Boolean);
    modbusOscHistory.reset(
      channelNosForAliases(nextAliases),
      sampleRate ?? sampleRateFromInterval(useModbusOscStore.getState().interval),
      useModbusOscStore.getState().retentionSeconds,
    );
    const stats = modbusOscHistory.getStats();
    set({
      aliases: nextAliases,
      waveData: new Map(nextAliases.map((alias) => [alias, []])),
      historyStats: stats,
      historyVersion: stats.version,
      reviewEndSeconds: null,
      ioStats: createIoStats(),
    });
  },
  pushSamples: (samples) =>
    set((s) => {
      const aliases = s.aliases.length > 0 ? s.aliases : Object.keys(samples);
      if (s.aliases.length === 0 && aliases.length > 0) {
        modbusOscHistory.reset(
          channelNosForAliases(aliases),
          sampleRateFromInterval(s.interval),
          s.retentionSeconds,
        );
      }

      const batch = new Map<number, number[]>();
      const map = new Map(s.waveData);
      aliases.forEach((alias, index) => {
        const val = samples[alias];
        const existing = map.get(alias) ?? [];
        map.set(alias, [...existing, val]);
        batch.set(index + 1, [val ?? Number.NaN]);
      });

      modbusOscHistory.appendBatch(batch);
      const stats = modbusOscHistory.getStats();
      return {
        aliases,
        waveData: map,
        historyStats: stats,
        historyVersion: stats.version,
      };
    }),
  appendColumns: (columns) =>
    set((s) => {
      const aliases = s.aliases;
      const batch = new Map<number, number[]>();
      aliases.forEach((_, index) => batch.set(index + 1, columns[index] ?? []));
      modbusOscHistory.appendBatch(batch);
      const stats = modbusOscHistory.getStats();
      return {
        waveData: waveDataFromColumns(aliases, columns),
        historyStats: stats,
        historyVersion: stats.version,
      };
    }),
  refreshHistoryStats: () => {
    const stats = modbusOscHistory.getStats();
    set({ historyStats: stats, historyVersion: stats.version });
  },
  setViewWindowSeconds: (v) => set({ viewWindowSeconds: normalizeWindow(v) }),
  setRetentionSeconds: (v) => {
    const retentionSeconds = normalizeRetention(v);
    modbusOscHistory.setRetentionSeconds(retentionSeconds);
    const stats = modbusOscHistory.getStats();
    set({ retentionSeconds, historyStats: stats, historyVersion: stats.version });
  },
  setViewPaused: (v) => set({ viewPaused: v }),
  setReviewEndSeconds: (v) => set({ reviewEndSeconds: v }),
  resetIoStats: () => set({ ioStats: createIoStats() }),
  recordIoRequest: () =>
    set((s) => ({
      ioStats: {
        ...s.ioStats,
        requests: s.ioStats.requests + 1,
        lastMessage: '已发送读请求',
        lastError: '',
      },
    })),
  recordIoResponse: (bytes) =>
    set((s) => ({
      ioStats: {
        ...s.ioStats,
        responses: s.ioStats.responses + 1,
        lastResponseBytes: bytes,
        lastMessage: `收到响应 ${bytes} B`,
        lastError: '',
      },
    })),
  recordIoSamples: (count) =>
    set((s) => ({
      ioStats: {
        ...s.ioStats,
        samples: s.ioStats.samples + 1,
        lastSampleAt: Date.now(),
        lastMessage: `采样成功 ${count} 项`,
        lastError: '',
      },
    })),
  recordIoError: (message) =>
    set((s) => ({
      ioStats: {
        ...s.ioStats,
        errors: s.ioStats.errors + 1,
        lastMessage: message,
        lastError: message,
      },
    })),
  clearWaveData: () => {
    modbusOscHistory.reset([], sampleRateFromInterval(useModbusOscStore.getState().interval));
    const stats = modbusOscHistory.getStats();
    set({
      aliases: [],
      historyStats: stats,
      historyVersion: stats.version,
      waveData: new Map(),
      reviewEndSeconds: null,
      ioStats: createIoStats(),
    });
  },
}));
