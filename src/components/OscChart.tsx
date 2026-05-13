// ⚠️ ChartGPU 集成暂缓，待库 API 确认后实现
// 当前版本：显示各通道最新采样值 + 累计帧数计数

import { useEffect, useRef, useMemo, useState } from 'react';
import { createChart } from 'chartgpu';
import type { ChartGPUInstance, ChartGPUOptions } from 'chartgpu';

const CHANNEL_COLORS = [
  '#4ade80', '#60a5fa', '#f97316', '#e879f9',
  '#facc15', '#34d399', '#f87171', '#a78bfa',
  '#fb923c', '#38bdf8', '#4ade80', '#f472b6',
];

function generateDemoData(): Map<number, number[]> {
  const map = new Map<number, number[]>();
  const N = 5000;
  const ch1: number[] = [];
  const ch2: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / 100;
    ch1.push(Math.sin(t * 2 * Math.PI));
    ch2.push(Math.cos(t * 2 * Math.PI) * 0.5);
  }
  map.set(1, ch1);
  map.set(2, ch2);
  return map;
}

interface OscChartProps {
  channels: Map<number, number[]>;
  /** 采样间隔（秒），用于 x 轴时间计算 */
  sampleInterval: number;
  /** 可选：通道号 -> 显示标签（如 alias），未提供时默认 CH{n} */
  labels?: Map<number, string>;
}

// Build a Float32Array [x0,y0, x1,y1, ...] for a single channel
function buildSeriesData(values: number[], sampleInterval: number): Float32Array {
  const buf = new Float32Array(values.length * 2);
  for (let i = 0; i < values.length; i++) {
    buf[i * 2]     = i * sampleInterval;
    buf[i * 2 + 1] = values[i];
  }
  return buf;
}

export function OscChart({ channels, sampleInterval, labels }: OscChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ChartGPUInstance | null>(null);
  const channelOrderRef = useRef<number[]>([]);
  const optionsRef = useRef<ChartGPUOptions | null>(null);
  const initKeyRef = useRef<string>('');
  const windowSamplesRef = useRef<number>(0);
  const prevTotalRef = useRef<number>(0);
  const userPannedRef = useRef<boolean>(false);
  const pausedRangeRef = useRef<[number, number] | null>(null);

  const [gpuError, setGpuError] = useState<string | null>(null);
  const [yRange, setYRange] = useState<{ min: number; max: number } | null>(null);
  const yRangeRef = useRef<{ min: number; max: number } | null>(null);

  const demoData = useMemo(() => generateDemoData(), []);
  const effectiveChannels = channels.size > 0 ? channels : demoData;

  const currentKey = Array.from(effectiveChannels.keys()).sort().join(',');

  // ── chart initialization ──────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || effectiveChannels.size === 0) return;
    if (currentKey === initKeyRef.current) return;
    initKeyRef.current = currentKey;
    setGpuError(null);

    const container = containerRef.current;
    const channelNos = Array.from(effectiveChannels.keys()).sort((a, b) => a - b);
    channelOrderRef.current = channelNos;

    let cancelled = false;

    (async () => {
      try {
        if (chartRef.current) {
          chartRef.current.dispose();
          chartRef.current = null;
          optionsRef.current = null;
        }

        const initialOptions: ChartGPUOptions = {
          theme: 'dark' as const,
          animation: false,
          autoScroll: false,
          xAxis: { type: 'value' as const, name: 'Time (s)' },
          yAxis: { type: 'value' as const },
          dataZoom: [{ type: 'inside' as const }, { type: 'slider' as const }],
          legend: { show: true },
          series: channelNos.map((chNo, i) => ({
            type: 'line' as const,
            name: labels?.get(chNo) ?? `CH${chNo}`,
            color: CHANNEL_COLORS[i % CHANNEL_COLORS.length],
            data: buildSeriesData(effectiveChannels.get(chNo) ?? [], sampleInterval),
            lineStyle: { width: 3 },
            sampling: 'none' as const,
          })),
        };

        const chart = await createChart(container, initialOptions);

        if (cancelled) {
          chart.dispose();
          return;
        }

        chartRef.current = chart;
        optionsRef.current = initialOptions;

        const firstValues = effectiveChannels.get(channelNos[0]) ?? [];
        windowSamplesRef.current = firstValues.length;
        prevTotalRef.current = firstValues.length;
        userPannedRef.current = false;
        pausedRangeRef.current = null;
        chart.setZoomRange(0, 100);
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setGpuError(msg);
      }
    })();

    return () => {
      cancelled = true;
      chartRef.current?.dispose();
      chartRef.current = null;
      optionsRef.current = null;
      initKeyRef.current = '';
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey]);

  // ── full data update + manual autoScroll ──────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    const opts  = optionsRef.current;
    if (!chart || !opts) return;

    const channelNos = channelOrderRef.current;

    const zoomRange = chart.getZoomRange();
    if (zoomRange && prevTotalRef.current > 0) {
      const prev = prevTotalRef.current;
      windowSamplesRef.current = Math.round(((zoomRange.end - zoomRange.start) / 100) * prev);

      const samplesFromEnd = Math.round(((100 - zoomRange.end) / 100) * prev);
      const wasPanned = userPannedRef.current;
      userPannedRef.current = samplesFromEnd > 1;

      if (userPannedRef.current) {
        pausedRangeRef.current = [
          Math.round((zoomRange.start / 100) * prev),
          Math.round((zoomRange.end   / 100) * prev),
        ];
      } else if (wasPanned && !userPannedRef.current) {
        pausedRangeRef.current = null;
      }
    }

    const newSeries = (opts.series ?? []).map((s: NonNullable<ChartGPUOptions['series']>[number], i: number) => {
      const chNo = channelNos[i];
      const values = chNo !== undefined ? (effectiveChannels.get(chNo) ?? []) : [];
      return { ...s, data: buildSeriesData(values, sampleInterval) };
    }) as ChartGPUOptions['series'];

    const newOptions: ChartGPUOptions = { ...opts, series: newSeries };
    optionsRef.current = newOptions;
    chart.setOption(newOptions);

    const firstCh = channelNos[0];
    const totalSamples = firstCh !== undefined ? (effectiveChannels.get(firstCh) ?? []).length : 0;
    if (totalSamples > 0 && windowSamplesRef.current > 0) {
      if (userPannedRef.current && pausedRangeRef.current) {
        const [s, e] = pausedRangeRef.current;
        chart.setZoomRange((s / totalSamples) * 100, (e / totalSamples) * 100);
      } else if (!userPannedRef.current) {
        const spanPct = Math.min((windowSamplesRef.current / totalSamples) * 100, 100);
        chart.setZoomRange(100 - spanPct, 100);
      }
    }

    prevTotalRef.current = totalSamples;
  }, [effectiveChannels]);

  // ── resize ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => chartRef.current?.resize());
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // ── y-axis zoom helpers ───────────────────────────────────────────────────
  function applyYRange(range: { min: number; max: number } | null) {
    const chart = chartRef.current;
    const opts = optionsRef.current;
    if (!chart || !opts) return;
    yRangeRef.current = range;
    setYRange(range);
    const yAxis: ChartGPUOptions['yAxis'] = range
      ? { type: 'value' as const, min: range.min, max: range.max }
      : { type: 'value' as const };
    const newOpts: ChartGPUOptions = { ...opts, yAxis };
    optionsRef.current = newOpts;
    chart.setOption(newOpts);
  }

  function getCurrentYRange(): { min: number; max: number } {
    // 如果已手动设置，直接用
    if (yRangeRef.current) return yRangeRef.current;
    // 否则从当前所有通道数据中推算
    const channelNos = channelOrderRef.current;
    let globalMin = Infinity;
    let globalMax = -Infinity;
    for (const chNo of channelNos) {
      for (const v of effectiveChannels.get(chNo) ?? []) {
        if (v < globalMin) globalMin = v;
        if (v > globalMax) globalMax = v;
      }
    }
    if (!isFinite(globalMin) || !isFinite(globalMax)) return { min: -1, max: 1 };
    const pad = (globalMax - globalMin) * 0.1 || 0.5;
    return { min: globalMin - pad, max: globalMax + pad };
  }

  function handleYZoomIn() {
    const { min, max } = getCurrentYRange();
    const center = (min + max) / 2;
    const half = (max - min) / 2 / 1.5;
    applyYRange({ min: center - half, max: center + half });
  }

  function handleYZoomOut() {
    const { min, max } = getCurrentYRange();
    const center = (min + max) / 2;
    const half = (max - min) / 2 * 1.5;
    applyYRange({ min: center - half, max: center + half });
  }

  function handleYReset() {
    applyYRange(null);
  }

  return (
    <div className="border border-slate-700 rounded bg-slate-900 h-full relative">
      <div ref={containerRef} className="w-full h-full" />

      {/* Y 轴缩放按钮 */}
      <div className="absolute top-2 right-2 z-10 flex flex-col gap-1">
        <button
          onClick={handleYZoomIn}
          title="Y轴放大"
          className="w-7 h-7 flex items-center justify-center bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm rounded border border-slate-600 leading-none"
        >
          Y+
        </button>
        <button
          onClick={handleYZoomOut}
          title="Y轴缩小"
          className="w-7 h-7 flex items-center justify-center bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm rounded border border-slate-600 leading-none"
        >
          Y-
        </button>
        {yRange && (
          <button
            onClick={handleYReset}
            title="重置Y轴"
            className="w-7 h-7 flex items-center justify-center bg-slate-700 hover:bg-slate-600 text-amber-400 text-xs rounded border border-slate-600 leading-none"
          >
            ↺
          </button>
        )}
      </div>

      {gpuError && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-900/90 rounded z-20">
          <div className="text-center px-6 py-4 max-w-md">
            <div className="text-amber-400 text-lg font-semibold mb-2">⚠️ WebGPU 不可用</div>
            <div className="text-slate-400 text-sm leading-relaxed break-all">
              {gpuError}
            </div>
            <div className="text-slate-500 text-xs mt-3">
              请使用 Chrome 113+ 或 Edge 113+，并确保 GPU 驱动正常。
              <br />
              当前环境可能为虚拟机或无 GPU 环境。
            </div>
          </div>
        </div>
      )}
    </div>
  );
}