import { useEffect, useRef } from 'react';
import { SmoothieChart, TimeSeries } from 'smoothie';
import { oscLiveFeed } from '../lib/oscLiveFeed';

const CHANNEL_COLORS = [
  '#4ade80', '#60a5fa', '#f97316', '#e879f9',
  '#facc15', '#34d399', '#f87171', '#a78bfa',
  '#fb923c', '#38bdf8', '#4ade80', '#f472b6',
];
const MAX_FRAMES_PER_TICK = 2;

type LiveSeriesDef = { key: string | number; label: string };

interface OscLiveChartProps {
  channelNos: number[];
  series: LiveSeriesDef[];
  sampleRate: number;
  windowSeconds: number;
}

function formatTimestampLabel(date: Date): string {
  const seconds = date.getTime() / 1000;
  if (!Number.isFinite(seconds)) return '';
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

export function OscLiveChart({ channelNos, series, sampleRate, windowSeconds }: OscLiveChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<SmoothieChart | null>(null);
  const seriesMapRef = useRef<Map<number, TimeSeries>>(new Map());

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return undefined;
    oscLiveFeed.setEnabled(true);

    const chart = new SmoothieChart({
      nonRealtimeData: true,
      limitFPS: 30,
      millisPerPixel: 8,
      maxDataSetLength: Math.max(2_000, Math.ceil(sampleRate * Math.max(windowSeconds, 10))),
      interpolation: 'linear',
      grid: {
        fillStyle: '#020617',
        strokeStyle: '#334155',
        lineWidth: 1,
        millisPerLine: 1000,
        verticalSections: 4,
      },
      labels: {
        fillStyle: '#cbd5e1',
        fontSize: 12,
        precision: 0,
      },
      timestampFormatter: formatTimestampLabel,
      responsive: false,
    });
    chartRef.current = chart;

    const map = new Map<number, TimeSeries>();
    series.forEach((item, index) => {
      const channelNo = channelNos[index];
      if (channelNo == null) return;
      const ts = new TimeSeries({ resetBounds: true, resetBoundsInterval: 1000 });
      map.set(channelNo, ts);
      chart.addTimeSeries(ts, {
        strokeStyle: CHANNEL_COLORS[index % CHANNEL_COLORS.length],
        lineWidth: 2,
        interpolation: 'linear',
        tooltipLabel: item.label,
      });
    });
    seriesMapRef.current = map;

    const syncCanvasSize = () => {
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const width = Math.max(1, Math.floor(container.clientWidth));
      const height = Math.max(1, Math.floor(container.clientHeight));
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      chart.options.millisPerPixel = Math.max(1, (windowSeconds * 1000) / Math.max(width, 1));
      chart.options.maxDataSetLength = Math.max(2_000, Math.ceil(sampleRate * Math.max(windowSeconds, 10)));
    };

    const resize = () => {
      syncCanvasSize();
      chart.render(canvas);
    };

    syncCanvasSize();
    chart.streamTo(canvas, 0);
    chart.render(canvas);
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    let rafHandle = 0;
    const tick = () => {
      let processed = 0;
      let drained = oscLiveFeed.drainFrame();
      while (drained && processed < MAX_FRAMES_PER_TICK) {
        const { timestamps, batch } = drained;
        for (let index = 0; index < timestamps.length; index++) {
          const timestamp = timestamps[index];
          if (timestamp == null) continue;
          for (let seriesIndex = 0; seriesIndex < series.length; seriesIndex++) {
            const channelNo = channelNos[seriesIndex];
            if (channelNo == null) continue;
            const values = batch.get(channelNo);
            const value = values?.[index];
            if (typeof value !== 'number' || !Number.isFinite(value)) continue;
            seriesMapRef.current.get(channelNo)?.append(timestamp, value);
          }
        }
        processed++;
        drained = oscLiveFeed.drainFrame();
      }
      if (processed > 0) {
        chart.updateValueRange();
      }
      rafHandle = requestAnimationFrame(tick);
    };

    rafHandle = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafHandle);
      observer.disconnect();
      chart.stop();
      oscLiveFeed.setEnabled(false);
      seriesMapRef.current.forEach((timeSeries) => timeSeries.clear());
      seriesMapRef.current = new Map();
      chartRef.current = null;
    };
  }, [channelNos, sampleRate, series, windowSeconds]);

  return (
    <div className="border border-slate-700 rounded bg-slate-900 h-full relative overflow-hidden">
      <div className="absolute left-3 top-2 z-10 flex flex-wrap gap-2 text-xs text-slate-200">
        {series.map((item, index) => (
          <span key={String(item.key)} className="inline-flex items-center gap-1 rounded bg-slate-950/70 px-2 py-1 border border-slate-700">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: CHANNEL_COLORS[index % CHANNEL_COLORS.length] }}
            />
            {item.label}
          </span>
        ))}
      </div>
      <div ref={containerRef} className="absolute inset-0">
        <canvas ref={canvasRef} className="block h-full w-full" />
      </div>
    </div>
  );
}
