// ⚠️ ChartGPU 集成暂缓，待库 API 确认后实现
// 当前版本：显示各通道最新采样值 + 累计帧数计数

import { useEffect, useRef } from 'react';
import { createChart } from 'chartgpu';
import type { ChartGPUInstance } from 'chartgpu';

const CHANNEL_COLORS = [
  '#4ade80', '#60a5fa', '#f97316', '#e879f9',
  '#facc15', '#34d399', '#f87171', '#a78bfa',
  '#fb923c', '#38bdf8', '#4ade80', '#f472b6',
];

interface OscChartProps {
  channels: Map<number, number[]>;
  sampleRate: number;
}

export function OscChart({ channels, sampleRate }: OscChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ChartGPUInstance | null>(null);
  // stable ordered list of channelNos established at init time
  const channelOrderRef = useRef<number[]>([]);
  // how many points have already been appended to the chart per channelNo
  const pushedRef = useRef<Map<number, number>>(new Map());
  // key snapshot that triggered the current chart instance
  const initKeyRef = useRef<string>('');

  const currentKey = Array.from(channels.keys()).sort().join(',');

  // ── chart initialization ────────────────────────────────────────────────────
  // Runs when the set of channel keys changes (i.e. a new start() cycle).
  useEffect(() => {
    if (!containerRef.current || channels.size === 0) return;
    if (currentKey === initKeyRef.current) return; // already initialised for this key
    initKeyRef.current = currentKey;

    const container = containerRef.current;
    const channelNos = Array.from(channels.keys()).sort((a, b) => a - b);
    channelOrderRef.current = channelNos;
    pushedRef.current = new Map();

    let cancelled = false;

    (async () => {
      // dispose previous instance synchronously before awaiting
      if (chartRef.current) {
        chartRef.current.dispose();
        chartRef.current = null;
      }

      const chart = await createChart(container, {
        theme: 'dark',
        animation: false,
        autoScroll: true,
        xAxis: { type: 'value', name: 'Sample' },
        yAxis: { type: 'value' },
        dataZoom: [{ type: 'inside' }, { type: 'slider' }],
        legend: { show: true },
        series: channelNos.map((chNo, i) => ({
          type: 'line' as const,
          name: `CH${chNo}`,
          color: CHANNEL_COLORS[i % CHANNEL_COLORS.length],
          data: [],
          lineStyle: { width: 1 },
          sampling: 'lttb',
        })),
      });

      if (cancelled) {
        chart.dispose();
        return;
      }

      chartRef.current = chart;

      // flush any data that arrived while we were awaiting createChart
      flushPending(chart, channelNos, channels, pushedRef.current);
    })();

    return () => {
      cancelled = true;
      // Don't dispose here — the async block checks cancelled and disposes itself.
      // We only null the ref so subsequent data effects skip gracefully.
      chartRef.current = null;
      initKeyRef.current = '';
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey]);

  // ── streaming data append ───────────────────────────────────────────────────
  // Runs on every waveData update. If chart is ready, append immediately.
  // If not yet ready (createChart still in flight), the init effect will flush
  // via flushPending once the chart resolves.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    flushPending(chart, channelOrderRef.current, channels, pushedRef.current);
  }, [channels]);

  // ── resize ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => chartRef.current?.resize());
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  if (channels.size === 0) {
    return (
      <div className="border border-slate-700 rounded p-4 bg-slate-900 text-slate-500 text-sm text-center h-full flex items-center justify-center">
        暂无波形数据，请先配置通道并开始采样
      </div>
    );
  }

  return (
    <div className="border border-slate-700 rounded bg-slate-900 h-full relative">
      <div className="absolute top-2 right-3 text-xs text-slate-500 z-10">
        采样率 {sampleRate} Hz
      </div>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function flushPending(
  chart: ChartGPUInstance,
  channelNos: number[],
  channels: Map<number, number[]>,
  pushed: Map<number, number>,
) {
  channelNos.forEach((chNo, seriesIndex) => {
    const data = channels.get(chNo);
    if (!data) return;

    const alreadyPushed = pushed.get(chNo) ?? 0;
    if (data.length <= alreadyPushed) return;

    const newSamples = data.slice(alreadyPushed);
    const buf = new Float32Array(newSamples.length * 2);
    for (let i = 0; i < newSamples.length; i++) {
      buf[i * 2]     = alreadyPushed + i; // x = absolute sample index
      buf[i * 2 + 1] = newSamples[i];     // y = value
    }
    chart.appendData(seriesIndex, buf);
    pushed.set(chNo, data.length);
  });
}