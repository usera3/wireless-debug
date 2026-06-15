/**
 * Bootloader 页面状态管理（Zustand）
 */

import { create } from 'zustand';
import { DEFAULT_GUI_CONFIG, normalizeGuiConfig } from '../lib/guiConfig';
import type { GuiConfig } from '../lib/guiConfig';
import type { FirmwareDocument } from '../lib/firmwareDocument';

export type LogType = 'info' | 'success' | 'error' | 'warning';

export interface LogEntry {
  id: number;
  msg: string;
  type: LogType;
  timestamp: string;
}

// ── 初始化 guiConfig ────────────────────────────────────────────────────────

function loadStoredGuiConfig(): GuiConfig {
  try {
    const stored = localStorage.getItem('bl_gui_config');
    if (stored) return normalizeGuiConfig(JSON.parse(stored));
  } catch {
    // ignore
  }
  return normalizeGuiConfig(DEFAULT_GUI_CONFIG);
}

// ── State & Actions ──────────────────────────────────────────────────────────

interface BootloaderState {
  // GUI 配置
  guiConfig: GuiConfig;

  // 固件配置
  slaveId: number;
  firmwareFormat: 'hex2' | 'legacy';
  activeTargetId: string;
  flashTargetIds: string[];
  chunkSize: number;
  hex2File: File | null;
  legacyFiles: Record<string, { low?: File; high?: File; single?: File }>;

  // 运行时
  isFlashing: boolean;
  statusText: string;
  progressPct: number;
  progressDetails: string;
  logs: LogEntry[];
  firmwareDocument: FirmwareDocument | null;

  // Actions
  loadGuiConfig: (file: File) => Promise<void>;
  exportGuiConfig: () => void;
  applyGuiConfigText: (text: string) => void;
  setSlaveId: (id: number) => void;
  setFirmwareFormat: (fmt: 'hex2' | 'legacy') => void;
  setHex2File: (file: File | null) => void;
  setLegacyFile: (targetId: string, role: 'low' | 'high' | 'single', file: File) => void;
  setActiveTargetId: (id: string) => void;
  toggleFlashTarget: (id: string) => void;
  setChunkSize: (n: number) => void;
  addLog: (msg: string, type?: LogType) => void;
  clearLogs: () => void;
  setStatus: (status: string, msg: string) => void;
  setProgress: (pct: number, details: string) => void;
  setFlashing: (v: boolean) => void;
  setFirmwareDocument: (doc: FirmwareDocument | null) => void;
}

let logIdCounter = 0;

const initConfig = loadStoredGuiConfig();

export const useBootloaderStore = create<BootloaderState>((set, get) => ({
  // ── Initial State ──────────────────────────────────────────────────────────

  guiConfig: initConfig,

  slaveId: 1,
  firmwareFormat: initConfig.defaultFirmwareFormat,
  activeTargetId: initConfig.defaultTarget,
  flashTargetIds: [initConfig.defaultTarget],
  chunkSize: 64,
  hex2File: null,
  legacyFiles: {},

  isFlashing: false,
  statusText: '就绪',
  progressPct: 0,
  progressDetails: '',
  logs: [],
  firmwareDocument: null,

  // ── Actions ────────────────────────────────────────────────────────────────

  loadGuiConfig: async (file: File) => {
    const text = await file.text();
    const parsed = normalizeGuiConfig(JSON.parse(text));
    try {
      localStorage.setItem('bl_gui_config', JSON.stringify(parsed));
    } catch {
      // ignore storage errors
    }
    set({
      guiConfig: parsed,
      activeTargetId: parsed.defaultTarget,
      flashTargetIds: [parsed.defaultTarget],
      firmwareFormat: parsed.defaultFirmwareFormat,
    });
  },

  exportGuiConfig: () => {
    const { guiConfig } = get();
    const blob = new Blob([JSON.stringify(guiConfig, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'gui-config.json';
    a.click();
    URL.revokeObjectURL(a.href);
  },

  applyGuiConfigText: (text: string) => {
    const parsed = normalizeGuiConfig(JSON.parse(text));
    try {
      localStorage.setItem('bl_gui_config', JSON.stringify(parsed));
    } catch {
      // ignore storage errors
    }
    set({
      guiConfig: parsed,
      activeTargetId: parsed.defaultTarget,
      flashTargetIds: [parsed.defaultTarget],
      firmwareFormat: parsed.defaultFirmwareFormat,
    });
  },

  setSlaveId: (id) => set({ slaveId: id }),

  setFirmwareFormat: (fmt) => set({ firmwareFormat: fmt }),

  setHex2File: (file) => set({ hex2File: file }),

  setLegacyFile: (targetId, role, file) => {
    const { legacyFiles } = get();
    set({
      legacyFiles: {
        ...legacyFiles,
        [targetId]: { ...legacyFiles[targetId], [role]: file },
      },
    });
  },

  setActiveTargetId: (id) => set({ activeTargetId: id }),

  toggleFlashTarget: (id) => {
    const { flashTargetIds } = get();
    const next = flashTargetIds.includes(id)
      ? flashTargetIds.filter((t) => t !== id)
      : [...flashTargetIds, id];
    set({ flashTargetIds: next });
  },

  setChunkSize: (n) => set({ chunkSize: n }),

  addLog: (msg, type = 'info') => {
    const entry: LogEntry = {
      id: ++logIdCounter,
      msg,
      type,
      timestamp: new Date().toLocaleTimeString(),
    };
    set((s) => ({ logs: [...s.logs, entry] }));
  },

  clearLogs: () => set({ logs: [] }),

  setStatus: (_status, msg) => set({ statusText: msg }),

  setProgress: (pct, details) => set({ progressPct: pct, progressDetails: details }),

  setFlashing: (v) => set({ isFlashing: v }),

  setFirmwareDocument: (doc) => set({ firmwareDocument: doc }),
}));