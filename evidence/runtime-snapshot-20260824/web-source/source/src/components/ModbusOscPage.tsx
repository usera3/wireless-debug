import { useEffect, useMemo, useRef, useState } from 'react';
import { useModbusOscStore, modbusOscHistory } from '../store/modbusOscStore';
import { useParamStore, type ParamDef } from '../store/paramStore';
import { useConnectionStore } from '../store/connectionStore';
import {
  OSC_HISTORY_RETENTION_OPTIONS,
  OSC_VIEW_WINDOW_OPTIONS,
  useOscStore,
} from '../store/oscStore';
import { useModbusOscController } from '../hooks/useModbusOscController';
import { OscChart } from './OscChart';
import { exportCsv, importCsv } from '../lib/csvWave';
import type { AlignedData } from '../lib/oscHistory';
import { oscPlotPointBudget } from '../lib/oscRenderBudget';
import { resolveConnectionTarget } from '../lib/connectionTarget';
import { shouldStopOscOnDisconnect } from '../lib/oscTransport';

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

function formatRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return '--';
  if (rate >= 10) return `${Math.round(rate)} Hz`;
  return `${rate.toFixed(1)} Hz`;
}

function formatAge(timestamp: number | null): string {
  if (!timestamp) return '--';
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  if (seconds < 10) return `${seconds.toFixed(1)}s 前`;
  if (seconds < 60) return `${Math.round(seconds)}s 前`;
  return `${Math.round(seconds / 60)}min 前`;
}

function emptyAlignedData(seriesCount: number): AlignedData {
  const data: AlignedData = [[]];
  for (let i = 0; i < seriesCount; i++) data.push([]);
  return data;
}

function estimateModbusBytesPerSecond(params: ParamDef[], readChunkSize: number, sampleRate: number): number {
  if (params.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return 0;

  const sorted = [...params].sort((a, b) => a.regAddr - b.regAddr);
  const chunkSize = readChunkSize > 0 ? readChunkSize : sorted.length;
  let bytesPerCycle = 0;

  for (let i = 0; i < sorted.length; i += chunkSize) {
    const chunk = sorted.slice(i, i + chunkSize);
    const addrs = chunk.map((param) => param.regAddr);
    const minAddr = Math.min(...addrs);
    const maxAddr = Math.max(...addrs);
    const registerCount = maxAddr - minAddr + 1;
    // Modbus RTU request: 8 B. Response: addr + fc + byteCount + data + crc.
    bytesPerCycle += 8 + 5 + registerCount * 2;
  }

  return bytesPerCycle * sampleRate;
}

function createMockParamColumns(): { labels: string[]; columns: number[][]; sampleRate: number } {
  const samples = 3_000;
  const sampleRate = 10;
  const columns = [[], [], [], []] as number[][];

  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const phase = Math.PI * 2 * t;
    columns[0].push(1500 + 260 * Math.sin(phase * 0.35));
    columns[1].push(48 + 5.5 * Math.sin(phase * 0.18 + 1.2));
    columns[2].push(22 + 3 * Math.cos(phase * 0.5));
    columns[3].push(0.8 + 0.3 * Math.sin(phase * 1.4));
  }

  return {
    labels: ['SIM_SPD', 'SIM_VBUS', 'SIM_TEMP', 'SIM_IQ'],
    columns,
    sampleRate,
  };
}

export function ModbusOscPage() {
  const {
    running,
    interval,
    selectedPage,
    readChunkSize,
    aliases,
    historyVersion,
    historyStats,
    viewWindowSeconds,
    retentionSeconds,
    viewPaused,
    reviewEndSeconds,
    ioStats,
    setInterval,
    setSelectedPage,
    setReadChunkSize,
    resetHistory,
    appendColumns,
    setViewWindowSeconds,
    setRetentionSeconds,
    setViewPaused,
    setReviewEndSeconds,
  } = useModbusOscStore();
  const pages = useParamStore((s) => s.pages);
  const params = useParamStore((s) => s.params);
  const connected = useConnectionStore((s) => s.connected);
  const connectionUrl = useConnectionStore((s) => s.url);
  const connectionKind = useMemo(
    () => resolveConnectionTarget(connectionUrl, window.location.origin).kind,
    [connectionUrl],
  );
  const oscRunning = useOscStore((s) => s.running);
  const { start, stop } = useModbusOscController();

  useEffect(() => {
    if (!connected && running && shouldStopOscOnDisconnect(connectionKind)) stop();
  }, [connected, running, stop, connectionKind]);

  const [csvError, setCsvError] = useState<string | null>(null);
  const [resetViewSignal, setResetViewSignal] = useState(0);
  const importRef = useRef<HTMLInputElement>(null);
  const [pendingPage, setPendingPage] = useState<string>(selectedPage);
  const [pendingInterval, setPendingInterval] = useState<number>(interval);

  useEffect(() => {
    if (pendingPage || pages.length === 0) return;
    setPendingPage(selectedPage && pages.includes(selectedPage) ? selectedPage : pages[0]);
  }, [pages, pendingPage, selectedPage]);

  useEffect(() => {
    setPendingInterval(interval);
  }, [interval]);

  const selectedPageParams = useMemo(
    () => params.filter((param) => param.page === selectedPage),
    [params, selectedPage],
  );
  const pendingPageParams = useMemo(
    () => params.filter((param) => param.page === pendingPage),
    [params, pendingPage],
  );
  const activeParamCount = selectedPage ? selectedPageParams.length : aliases.length;
  const canStart = connected && !oscRunning && pendingPageParams.length > 0 && !running;
  const effectiveSampleRate = historyStats.channelCount > 0
    ? historyStats.sampleRate
    : 1000 / Math.max(100, interval);
  const sampleIntervalSec = effectiveSampleRate > 0 ? 1 / effectiveSampleRate : 1;
  const hasHistory = historyStats.retainedSamples > 0 && aliases.length > 0;
  const latestSeconds = effectiveSampleRate > 0 ? historyStats.latestSampleIndex / effectiveSampleRate : 0;
  const firstSeconds = effectiveSampleRate > 0 ? historyStats.firstSampleIndex / effectiveSampleRate : 0;
  const selectedEndSeconds = viewPaused
    ? clamp(reviewEndSeconds ?? latestSeconds, firstSeconds, latestSeconds)
    : latestSeconds;
  const selectedStartSeconds = Math.max(firstSeconds, selectedEndSeconds - viewWindowSeconds);
  const channelNos = useMemo(() => aliases.map((_, index) => index + 1), [aliases]);
  const channelKey = aliases.join('\u001f');
  const chartSeries = useMemo(
    () => aliases.map((alias, index) => ({ key: alias || index + 1, label: alias || `P${index + 1}` })),
    [aliases],
  );
  const chartData = useMemo(() => {
    if (!hasHistory) return emptyAlignedData(aliases.length);
    return modbusOscHistory.buildAlignedData(
      channelNos,
      selectedStartSeconds,
      selectedEndSeconds,
      oscPlotPointBudget(channelNos.length),
    );
  }, [hasHistory, aliases.length, channelKey, historyVersion, selectedStartSeconds, selectedEndSeconds, channelNos]);
  const viewWindowOptions = useMemo(() => {
    if (OSC_VIEW_WINDOW_OPTIONS.includes(viewWindowSeconds)) return OSC_VIEW_WINDOW_OPTIONS;
    return [...OSC_VIEW_WINDOW_OPTIONS, viewWindowSeconds].sort((a, b) => a - b);
  }, [viewWindowSeconds]);
  const estimatedBytesPerSecond = useMemo(() => {
    if (running || pendingPageParams.length > 0) {
      const sourceParams = running && selectedPageParams.length > 0 ? selectedPageParams : pendingPageParams;
      return estimateModbusBytesPerSecond(sourceParams, readChunkSize, effectiveSampleRate);
    }
    return aliases.length * Float64Array.BYTES_PER_ELEMENT * effectiveSampleRate;
  }, [running, selectedPageParams, pendingPageParams, readChunkSize, effectiveSampleRate, aliases.length]);

  function handleStart() {
    setInterval(pendingInterval);
    setSelectedPage(pendingPage);
    setViewPaused(false);
    setReviewEndSeconds(null);
    start(pendingPage);
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

  function handleExport() {
    if (!hasHistory) return;
    const { columns, startSampleIndex } = modbusOscHistory.exportColumns(channelNos);
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
    exportCsv(aliases, columns, sampleIntervalSec, `param_osc_${stamp}.csv`, startSampleIndex * sampleIntervalSec);
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setCsvError(null);
    try {
      const { labels, columns, sampleIntervalSec: importedInterval } = await importCsv(file);
      const importedSampleRate = importedInterval && importedInterval > 0
        ? 1 / importedInterval
        : effectiveSampleRate;
      const importedIntervalMs = Math.max(100, Math.round(1000 / importedSampleRate));
      setSelectedPage('');
      setInterval(importedIntervalMs);
      resetHistory(labels, importedSampleRate);
      appendColumns(columns);
      setViewPaused(true);
      setReviewEndSeconds(columns.reduce((max, column) => Math.max(max, column.length), 0) / importedSampleRate);
      setCsvError(null);
    } catch (err) {
      setCsvError((err as Error).message);
      setTimeout(() => setCsvError(null), 4000);
    }
  }

  function handleMockWave() {
    const mock = createMockParamColumns();
    const mockIntervalMs = Math.round(1000 / mock.sampleRate);
    setSelectedPage('');
    setInterval(mockIntervalMs);
    resetHistory(mock.labels, mock.sampleRate);
    appendColumns(mock.columns);
    setViewPaused(true);
    setReviewEndSeconds(mock.columns.reduce((max, column) => Math.max(max, column.length), 0) / mock.sampleRate);
    setCsvError(null);
  }

  return (
    <div className="flex flex-col gap-4 p-4 h-full">
      <div className="bg-slate-800 rounded-lg p-3 border border-slate-700 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400 whitespace-nowrap">参数页</label>
          {pages.length === 0 ? (
            <span className="text-xs text-slate-500 italic">请先在「参数编辑」页加载参数表</span>
          ) : (
            <select
              value={pendingPage}
              onChange={(e) => setPendingPage(e.target.value)}
              disabled={running}
              className="min-w-40 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-slate-100 text-xs disabled:opacity-50"
            >
              <option value="">-- 选择页 --</option>
              {pages.map((page) => (
                <option key={page} value={page}>
                  {page}
                </option>
              ))}
            </select>
          )}
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-400">
          间隔 (ms)
          <input
            type="number"
            min={100}
            step={100}
            value={pendingInterval}
            onChange={(e) => setPendingInterval(Number(e.target.value))}
            disabled={running}
            className="w-20 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-slate-100 text-xs disabled:opacity-50"
          />
        </label>

        <label className="flex items-center gap-2 text-xs text-slate-400">
          分组大小
          <input
            type="number"
            min={0}
            step={1}
            value={readChunkSize}
            onChange={(e) => setReadChunkSize(Number(e.target.value))}
            disabled={running}
            className="w-16 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-slate-100 text-xs disabled:opacity-50"
            placeholder="0"
          />
        </label>

        <div className="ml-auto flex items-center gap-3 text-xs text-slate-400 flex-wrap justify-end">
          {selectedPage ? (
            <span>{selectedPage} · {activeParamCount} 个参数</span>
          ) : aliases.length > 0 ? (
            <span>离线数据 · {aliases.length} 条曲线</span>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={handleStart}
          disabled={!canStart}
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
          {oscRunning && (
            <span className="text-amber-400">⚠️ 地址示波器运行中，请先停止</span>
          )}
          <span>
            状态:{' '}
            <span className={running ? 'text-green-400' : 'text-slate-500'}>
              {running ? '运行中' : '已停止'}
            </span>
          </span>
          <span>采样率: {formatRate(effectiveSampleRate)}</span>
          <span>间隔: {Math.max(100, interval)} ms</span>
          <span>带宽: {formatDataRate(estimatedBytesPerSecond)}</span>
          <span>缓存: {formatDuration(historyStats.retainedSeconds)} / {formatMemory(historyStats.estimatedBytes)}</span>
          <span>请求/响应: {ioStats.requests}/{ioStats.responses}</span>
          <span>样本: {ioStats.samples}</span>
          <span>最近采样: {formatAge(ioStats.lastSampleAt)}</span>
          <span
            className={`inline-block w-28 shrink-0 truncate text-left ${ioStats.lastError ? 'text-red-400' : 'text-slate-400'}`}
            title={ioStats.lastError || ioStats.lastMessage}
          >
            {ioStats.lastError || ioStats.lastMessage}
          </span>
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
