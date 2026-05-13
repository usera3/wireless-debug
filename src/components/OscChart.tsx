import { useEffect, useRef, useMemo } from 'react';
import {
  lightningChart,
  AxisTickStrategies,
  emptyFill,
  SolidLine,
  SolidFill,
  ColorHEX,
  type ChartXY,
  type PointLineAreaSeries,
} from '@lightningchart/lcjs';

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

export function OscChart({ channels, sampleInterval, labels }: OscChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ChartXY | null>(null);
  const seriesRef = useRef<Map<number, PointLineAreaSeries>>(new Map());
  const channelOrderRef = useRef<number[]>([]);
  const initKeyRef = useRef<string>('');
  const prevTotalRef = useRef<number>(0);
  const userPannedRef = useRef<boolean>(false);
  const pausedRangeRef = useRef<{ start: number; end: number } | null>(null);
  const renderedCountsRef = useRef<Map<number, number>>(new Map());

  const demoData = useMemo(() => generateDemoData(), []);
  const effectiveChannels = channels.size > 0 ? channels : demoData;

  const currentKey = `${sampleInterval}:${Array.from(effectiveChannels.keys()).sort().join(',')}`;

  // ── chart initialization ──────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || effectiveChannels.size === 0) return;
    if (currentKey === initKeyRef.current) return;
    initKeyRef.current = currentKey;

    const container = containerRef.current;
    const channelNos = Array.from(effectiveChannels.keys()).sort((a, b) => a - b);
    channelOrderRef.current = channelNos;

    // Dispose previous chart
    if (chartRef.current) {
      chartRef.current.dispose();
      chartRef.current = null;
      seriesRef.current.clear();
      renderedCountsRef.current.clear();
    }

    const chart = lightningChart().ChartXY({
      container,
    })
      .setTitle('')
      .setBackgroundFillStyle(emptyFill)
      .setSeriesBackgroundFillStyle(emptyFill)
      .setPadding({ left: 8, right: 16, top: 8, bottom: 8 });

    // Configure axes for dark theme
    chart.getDefaultAxisX()
      .setTitle('Time (s)')
      .setTickStrategy(AxisTickStrategies.Numeric)
      .setStrokeStyle(new SolidLine({
        thickness: 1,
        fillStyle: new SolidFill({ color: ColorHEX('#64748b') }),
      }));

    chart.getDefaultAxisY()
      .setTitle('')
      .setTickStrategy(AxisTickStrategies.Numeric)
      .setStrokeStyle(new SolidLine({
        thickness: 1,
        fillStyle: new SolidFill({ color: ColorHEX('#64748b') }),
      }));

    // Create series for each channel
    channelNos.forEach((chNo, i) => {
      const values = effectiveChannels.get(chNo) ?? [];
      const series = chart.addLineSeries()
        .setName(labels?.get(chNo) ?? `CH${chNo}`)
        .setStrokeStyle(new SolidLine({
          thickness: 2,
          fillStyle: new SolidFill({ color: ColorHEX(CHANNEL_COLORS[i % CHANNEL_COLORS.length]) }),
        }));

      // Add data points
      if (values.length > 0) {
        series.appendSamples({
          xValues: values.map((_, j) => j * sampleInterval),
          yValues: values,
        });
      }

      renderedCountsRef.current.set(chNo, values.length);
      seriesRef.current.set(chNo, series);
    });

    chartRef.current = chart;
    prevTotalRef.current = effectiveChannels.get(channelNos[0])?.length ?? 0;
    userPannedRef.current = false;
    pausedRangeRef.current = null;

    // Auto-fit to show all data initially
    chart.getDefaultAxisX().fit(false);
    chart.getDefaultAxisY().fit(false);

    return () => {
      chart.dispose();
      chartRef.current = null;
      seriesRef.current.clear();
      renderedCountsRef.current.clear();
      initKeyRef.current = '';
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey]);

  // ── incremental data update ───────────────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const channelNos = channelOrderRef.current;

    // Check if user has panned away from the end
    const axisX = chart.getDefaultAxisX();
    const interval = axisX.getInterval();
    const firstCh = channelNos[0];
    const totalSamples = firstCh !== undefined ? (effectiveChannels.get(firstCh)?.length ?? 0) : 0;

    if (totalSamples > 0 && prevTotalRef.current > 0) {
      const maxX = totalSamples * sampleInterval;
      const viewEnd = interval.end;
      const wasPanned = userPannedRef.current;
      userPannedRef.current = maxX - viewEnd > sampleInterval * 2;

      if (userPannedRef.current) {
        pausedRangeRef.current = { start: interval.start, end: interval.end };
      } else if (wasPanned && !userPannedRef.current) {
        pausedRangeRef.current = null;
      }
    }

    // Update each series with new data
    channelNos.forEach((chNo) => {
      const series = seriesRef.current.get(chNo);
      if (!series) return;
      const values = effectiveChannels.get(chNo) ?? [];
      const renderedCount = renderedCountsRef.current.get(chNo) ?? 0;

      if (values.length < renderedCount) {
        series.clear();
        if (values.length > 0) {
          series.appendSamples({
            xValues: values.map((_, j) => j * sampleInterval),
            yValues: values,
          });
        }
        renderedCountsRef.current.set(chNo, values.length);
        return;
      }

      if (values.length === renderedCount) return;

      const appendedValues = values.slice(renderedCount);
      if (appendedValues.length > 0) {
        series.appendSamples({
          xValues: appendedValues.map((_, j) => (renderedCount + j) * sampleInterval),
          yValues: appendedValues,
        });
      }
      renderedCountsRef.current.set(chNo, values.length);
    });

    // Handle auto-scroll
    if (totalSamples > 0) {
      if (userPannedRef.current && pausedRangeRef.current) {
        axisX.setInterval({
          start: pausedRangeRef.current.start,
          end: pausedRangeRef.current.end,
        });
      } else if (!userPannedRef.current) {
        const maxX = totalSamples * sampleInterval;
        const windowSize = prevTotalRef.current > 0
          ? (prevTotalRef.current * sampleInterval)
          : maxX;
        const span = Math.min(windowSize, maxX);
        axisX.setInterval({ start: maxX - span, end: maxX });
      }
    }

    prevTotalRef.current = totalSamples;
  }, [effectiveChannels, sampleInterval]);

  // ── resize ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      // LightningChart handles container resize internally once attached.
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="border border-slate-700 rounded bg-slate-900 h-full relative">
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}