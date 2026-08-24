import { useEffect, useMemo, useRef, useState } from 'react';
import {
  OSC_HISTORY_RETENTION_OPTIONS,
  OSC_VIEW_WINDOW_OPTIONS,
  useOscStore,
} from '../store/oscStore';
import { oscHistory } from '../lib/oscHistory';
import { useConnectionStore } from '../store/connectionStore';
import { useModbusOscStore } from '../store/modbusOscStore';
import { OscChannelConfig, buildChannelConfigs } from './OscChannelConfig';
import { OscChart } from './OscChart';
import { useOscController } from '../hooks/useOscController';
import { exportCsv, importCsv } from '../lib/csvWave';
import { resolveConnectionTarget } from '../lib/connectionTarget';
import { describeOscTransport, shouldStopOscOnDisconnect } from '../lib/oscTransport';
import { oscPlotPointBudget } from '../lib/oscRenderBudget';
import { getOscChannelType } from '../lib/oscChannelTypes';

function createMockOscData(): Map<number, number[]> {
  const samples = 30_000;
  const sampleRate = 1000;
  const columns = [[], [], [], []] as number[][];
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const phase = Math.PI * 2 * t;
    columns[0].push(12000 + 9000 * Math.sin(phase * 1.2) + 2500 * Math.sin(phase * 4.1));
    columns[1].push(120 + 75 * Math.sin(phase * 2.3));
    columns[2].push(18 * Math.sin(phase * 5.5) + 6 * Math.cos(phase * 1.7));
    columns[3].push(4 + 2 * Math.sin(phase * 9.2));
  }
  return new Map(columns.map((column, index) => [index + 1, column]));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatDataRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '--';
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(2)} MB/s`;
  return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
}

function formatMemory(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  if (seconds < 1) return `${(seconds * 1000).toFixed(seconds < 0.1 ? 1 : 0)}ms`;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  return `${(seconds / 60).toFixed(seconds < 600 ? 1 : 0)}min`;
}

export function OscilloscoperPage() {
  const {
    running,
    startError,
    sampleRate,
    frameLen,
    channels,
    historyVersion,
    historyStats,
    viewWindowSeconds,
    retentionSeconds,
    viewPaused,
    reviewEndSeconds,
    configRows,
    numChannels,
    setChannels,
    appendSamples,
    resetHistory,
    setSampleRate,
    setViewWindowSeconds,
    setRetentionSeconds,
    setViewPaused,
    setReviewEndSeconds,
  } = useOscStore();
  const connected = useConnectionStore((s) => s.connected);
  const url = useConnectionStore((s) => s.url);
  const modbusOscRunning = useModbusOscStore((s) => s.running);
  const { start, stop } = useOscController();
  const connectionTarget = useMemo(
    () => resolveConnectionTarget(url, window.location.origin),
    [url],
  );
  const transport = useMemo(
    () => describeOscTransport(connectionTarget),
    [connectionTarget],
  );

  const [csvError, setCsvError] = useState<string | null>(null);
  const [resetViewSignal, setResetViewSignal] = useState(0);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!connected && running && shouldStopOscOnDisconnect(connectionTarget.kind)) stop();
  }, [connected, running, stop, connectionTarget.kind]);

  const configuredChannels = useMemo(() => buildChannelConfigs(configRows, numChannels), [configRows, numChannels]);
  const activeChannels = channels.length > 0 ? channels : configuredChannels;
  const channelNos = useMemo(() => channels.map((channel) => channel.channelNo), [channels]);
  const channelKey = channelNos.join(',');
  const sampleIntervalSec = sampleRate > 0 ? 1 / sampleRate : 1;
  const hasHistory = historyStats.retainedSamples > 0 && channelNos.length > 0;
  const latestSeconds = sampleRate > 0 ? historyStats.latestSampleIndex / sampleRate : 0;
  const firstSeconds = sampleRate > 0 ? historyStats.firstSampleIndex / sampleRate : 0;
  const selectedEndSeconds = viewPaused
    ? clamp(reviewEndSeconds ?? latestSeconds, firstSeconds, latestSeconds)
    : latestSeconds;
  const selectedStartSeconds = Math.max(firstSeconds, selectedEndSeconds - viewWindowSeconds);

  const estimatedBytesPerSecond = useMemo(() => {
    const sampleBytes = activeChannels.reduce(
      (sum, channel) => sum + getOscChannelType(channel.typeKey).byteWidth,
      0,
    );
    return sampleBytes * Math.max(sampleRate, 0);
  }, [activeChannels, sampleRate]);

  const chartSeries = useMemo(
    () => channels.map((channel) => ({
      key: channel.channelNo,
      label: channel.label || `CH${channel.channelNo}`,
    })),
    [channels],
  );
  const viewWindowOptions = useMemo(() => {
    if (OSC_VIEW_WINDOW_OPTIONS.includes(viewWindowSeconds)) return OSC_VIEW_WINDOW_OPTIONS;
    return [...OSC_VIEW_WINDOW_OPTIONS, viewWindowSeconds].sort((a, b) => a - b);
  }, [viewWindowSeconds]);

  const chartData = useMemo(() => {
    if (!hasHistory) return [[]] as [number[]];
    return oscHistory.buildAlignedData(
      channelNos,
      selectedStartSeconds,
      selectedEndSeconds,
      oscPlotPointBudget(channelNos.length),
    );
  }, [hasHistory, channelKey, historyVersion, selectedStartSeconds, selectedEndSeconds]);

  function handleStart() {
    const chs = configuredChannels;
    setChannels(chs);
    setViewPaused(false);
    setReviewEndSeconds(null);
    start(chs);
  }

  function handlePauseDisplay() {
    if (viewPaused) {
      handleJumpLatest();
    } else {
      setReviewEndSeconds(latestSeconds);
      setViewPaused(true);
    }
  }

  function handleJumpLatest() {
    setReviewEndSeconds(null);
    setViewPaused(false);
    setResetViewSignal((value) => value + 1);
  }

  function updateReviewEnd(value: number) {
    setViewPaused(true);
    setReviewEndSeconds(clamp(value, firstSeconds, latestSeconds));
  }

  function updateReviewRange(min: number, max: number) {
    const availableSpan = Math.max(sampleIntervalSec, latestSeconds - firstSeconds);
    const nextWindow = clamp(max - min, sampleIntervalSec, availableSpan);
    const nextEnd = clamp(max, firstSeconds + nextWindow, latestSeconds);
    setViewPaused(true);
    setViewWindowSeconds(nextWindow);
    setReviewEndSeconds(nextEnd);
  }

  function handleMockWave() {
    const mock = createMockOscData();
    const mockSampleRate = 1000;
    const mockChannels = Array.from({ length: 4 }, (_, index) => ({
      channelNo: index + 1,
      varAddr: 0,
      typeKey: 'float32' as const,
      label: `SIM${index + 1}`,
    }));
    setChannels(mockChannels);
    setSampleRate(mockSampleRate);
    resetHistory(mockChannels, mockSampleRate);
    appendSamples(mock);
    setViewPaused(true);
    setReviewEndSeconds(30);
    setCsvError(null);
  }

  function handleExport() {
    if (!hasHistory) return;
    const labels = channels.map((channel) => channel.label || `CH${channel.channelNo}`);
    const { columns, startSampleIndex } = oscHistory.exportColumns(channelNos);
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
    exportCsv(labels, columns, sampleIntervalSec, `osc_${stamp}.csv`, startSampleIndex * sampleIntervalSec);
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setCsvError(null);
    try {
      const { labels, columns, sampleIntervalSec: importedInterval } = await importCsv(file);
      const importedSampleRate = importedInterval && importedInterval > 0
        ? Math.round(1 / importedInterval)
        : sampleRate;
      const importedChannels = labels.map((label, index) => ({
        channelNo: index + 1,
        varAddr: 0,
        typeKey: 'float32' as const,
        label: label || `CH${index + 1}`,
      }));
      const batch = new Map<number, number[]>();
      columns.forEach((column, index) => batch.set(index + 1, column));
      setChannels(importedChannels);
      setSampleRate(importedSampleRate);
      resetHistory(importedChannels, importedSampleRate);
      appendSamples(batch);
      setViewPaused(true);
      setReviewEndSeconds(columns.reduce((max, column) => Math.max(max, column.length), 0) / importedSampleRate);
    } catch (err) {
      setCsvError((err as Error).message);
      setTimeout(() => setCsvError(null), 4000);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 h-full">
      <div
        className={`flex items-center justify-between gap-3 border px-3 py-2 text-sm rounded-lg ${
          transport.tone === 'fast'
            ? 'border-emerald-700/70 bg-emerald-950/35 text-emerald-200'
            : transport.tone === 'cloud'
              ? 'border-cyan-700/70 bg-cyan-950/30 text-cyan-200'
              : 'border-red-800/70 bg-red-950/30 text-red-200'
        }`}
      >
        <div className="min-w-0">
          <div className="font-medium">{transport.title}</div>
          <div className="mt-0.5 text-xs opacity-75">{transport.detail}</div>
        </div>
        <span className="shrink-0 text-xs tabular-nums opacity-70">
          {transport.mode === 'local' ? '低延迟' : transport.mode === 'cloud' ? '公网链路' : '未连接'}
        </span>
      </div>

      <div className="bg-slate-800 rounded-lg p-3 border border-slate-700">
        <OscChannelConfig />
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={handleStart}
          disabled={!connected || running || modbusOscRunning}
          className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed
                     text-white rounded text-sm font-medium transition-colors"
        >
          ▶ 开始
        </button>
        <button
          onClick={stop}
          disabled={!running}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed
                     text-white rounded text-sm font-medium transition-colors"
        >
          ■ 停止
        </button>
        <button
          onClick={handlePauseDisplay}
          disabled={!hasHistory}
          className="px-4 py-2 bg-slate-600 hover:bg-slate-500 disabled:opacity-40 disabled:cursor-not-allowed
                     text-white rounded text-sm font-medium transition-colors"
        >
          {viewPaused ? '跟随最新' : '暂停显示'}
        </button>
        <button
          onClick={handleJumpLatest}
          disabled={!hasHistory}
          className="px-4 py-2 bg-slate-600 hover:bg-slate-500 disabled:opacity-40 disabled:cursor-not-allowed
                     text-white rounded text-sm font-medium transition-colors"
        >
          跳到最新
        </button>

        <label className="flex items-center gap-2 text-xs text-slate-400">
          窗口
          <select
            value={viewWindowSeconds}
            onChange={(e) => setViewWindowSeconds(Number(e.target.value))}
            className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-slate-100 text-xs"
          >
            {viewWindowOptions.map((seconds) => (
              <option key={seconds} value={seconds}>{formatDuration(seconds)}</option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs text-slate-400">
          历史
          <select
            value={retentionSeconds}
            onChange={(e) => setRetentionSeconds(Number(e.target.value))}
            disabled={running}
            className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-slate-100 text-xs disabled:opacity-50"
          >
            {OSC_HISTORY_RETENTION_OPTIONS.map((seconds) => (
              <option key={seconds} value={seconds}>{formatDuration(seconds)}</option>
            ))}
          </select>
        </label>

        <button
          onClick={handleExport}
          disabled={!hasHistory}
          className="px-4 py-2 bg-slate-600 hover:bg-slate-500 disabled:opacity-40 disabled:cursor-not-allowed
                     text-white rounded text-sm font-medium transition-colors"
        >
          ⬇ 导出
        </button>

        <button
          onClick={() => importRef.current?.click()}
          disabled={running}
          className="px-4 py-2 bg-slate-600 hover:bg-slate-500 disabled:opacity-40 disabled:cursor-not-allowed
                     text-white rounded text-sm font-medium transition-colors"
        >
          ⬆ 导入
        </button>
        <button
          onClick={handleMockWave}
          disabled={running}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed
                     text-white rounded text-sm font-medium transition-colors"
        >
          模拟波形
        </button>
        <input ref={importRef} type="file" accept=".csv" className="hidden" onChange={handleImport} />

        <div className="ml-auto flex items-center gap-4 text-xs text-slate-400 flex-wrap justify-end">
          {csvError && <span className="text-red-400">❌ {csvError}</span>}
          {startError && <span className="text-red-400">启动失败: {startError}</span>}
          {modbusOscRunning && (
            <span className="text-amber-400">⚠️ 参数示波器运行中，请先停止</span>
          )}
          <span>
            状态:{' '}
            <span className={running ? 'text-green-400' : 'text-slate-500'}>
              {running ? '运行中' : '已停止'}
            </span>
          </span>
          <span>采样率: {sampleRate} Hz</span>
          <span>帧长: {frameLen} B</span>
          <span>带宽: {formatDataRate(estimatedBytesPerSecond)}</span>
          <span>缓存: {formatDuration(historyStats.retainedSeconds)} / {formatMemory(historyStats.estimatedBytes)}</span>
        </div>
      </div>

      {hasHistory && (
        <div className="flex items-center gap-3 text-xs text-slate-400">
          <span className="w-20 text-right">{formatDuration(selectedStartSeconds)}</span>
          <input
            type="range"
            min={firstSeconds}
            max={Math.max(firstSeconds, latestSeconds)}
            step={Math.max(sampleIntervalSec, 0.01)}
            value={selectedEndSeconds}
            onInput={(e) => updateReviewEnd(Number(e.currentTarget.value))}
            onChange={(e) => updateReviewEnd(Number(e.currentTarget.value))}
            className="flex-1 accent-blue-500"
          />
          <span className="w-20">{formatDuration(selectedEndSeconds)}</span>
        </div>
      )}

      <div className="flex-1 min-h-0">
        <OscChart
          alignedData={chartData}
          series={chartSeries}
          sampleInterval={sampleIntervalSec}
          running={running && !viewPaused}
          windowSeconds={viewWindowSeconds}
          xRange={{ min: selectedStartSeconds, max: selectedEndSeconds }}
          onXRangeChange={({ min, max }) => updateReviewRange(min, max)}
          resetViewSignal={resetViewSignal}
        />
      </div>
    </div>
  );
}
