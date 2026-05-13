import { useEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

const CHANNEL_COLORS = [
  '#4ade80', '#60a5fa', '#f97316', '#e879f9',
  '#facc15', '#34d399', '#f87171', '#a78bfa',
  '#fb923c', '#38bdf8', '#4ade80', '#f472b6',
];

type AlignedSeries = number[] | (number | null)[];
type AlignedData = [number[], ...AlignedSeries[]];

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

function buildAlignedData(channelNos: number[], channels: Map<number, number[]>, sampleInterval: number): AlignedData {
  const maxLen = channelNos.reduce((max, chNo) => Math.max(max, channels.get(chNo)?.length ?? 0), 0);
  const xData = Array.from({ length: maxLen }, (_, i) => i * sampleInterval);
  const seriesData = channelNos.map((chNo) => {
    const values = channels.get(chNo) ?? [];
    const aligned = new Array<number | null>(maxLen).fill(null);
    for (let i = 0; i < values.length; i++) {
      aligned[i] = values[i];
    }
    return aligned;
  });

  return [xData, ...seriesData];
}

function getVisibleYRange(data: AlignedData, xMin: number, xMax: number): { min: number; max: number } | null {
  const xData = data[0];
  if (xData.length === 0) return null;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (let seriesIdx = 1; seriesIdx < data.length; seriesIdx++) {
    const series = data[seriesIdx];
    for (let i = 0; i < xData.length; i++) {
      const x = xData[i];
      if (x < xMin || x > xMax) continue;
      const value = series[i];
      if (value == null || Number.isNaN(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    return { min: min - pad, max: max + pad };
  }

  const pad = (max - min) * 0.1;
  return { min: min - pad, max: max + pad };
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
  const plotRef = useRef<uPlot | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const channelOrderRef = useRef<number[]>([]);
  const renderedCountsRef = useRef<Map<number, number>>(new Map());
  const alignedDataRef = useRef<AlignedData>([[]]);
  const followLatestRef = useRef(true);
  const yAutoRef = useRef(true);
  const syncingScalesRef = useRef(false);

  const demoData = useMemo(() => generateDemoData(), []);
  const effectiveChannels = channels.size > 0 ? channels : demoData;
  const currentKey = `${sampleInterval}:${Array.from(effectiveChannels.keys()).sort().join(',')}`;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || effectiveChannels.size === 0) return;

    const channelNos = Array.from(effectiveChannels.keys()).sort((a, b) => a - b);
    channelOrderRef.current = channelNos;
    renderedCountsRef.current = new Map(channelNos.map((chNo) => [chNo, effectiveChannels.get(chNo)?.length ?? 0]));
    alignedDataRef.current = buildAlignedData(channelNos, effectiveChannels, sampleInterval);
    followLatestRef.current = true;
    yAutoRef.current = true;

    plotRef.current?.destroy();
    resizeObserverRef.current?.disconnect();

    const initialWidth = Math.max(container.clientWidth, 320);
    const initialHeight = Math.max(container.clientHeight, 240);

    const plot = new uPlot(
      {
        width: initialWidth,
        height: initialHeight,
        padding: [8, 16, 8, 8],
        class: 'osc-uplot',
        cursor: {
          drag: {
            setScale: true,
            x: true,
            y: true,
          },
          bind: {
            dblclick: (self, _target, handler) => (event) => {
              event.preventDefault();
              handler(event);

              const xScale = self.scales.x;
              if (xScale.min == null || xScale.max == null) return null;

              const yRange = getVisibleYRange(alignedDataRef.current, xScale.min, xScale.max);
              if (yRange) {
                yAutoRef.current = true;
                syncingScalesRef.current = true;
                self.setScale('y', yRange);
                syncingScalesRef.current = false;
              }
              return null;
            },
          },
        },
        legend: {
          show: true,
          live: true,
        },
        scales: {
          x: {
            time: false,
          },
          y: {
            auto: false,
          },
        },
        axes: [
          {
            stroke: '#94a3b8',
            grid: { stroke: 'rgba(148, 163, 184, 0.12)' },
            ticks: { stroke: '#475569' },
            label: 'Time (s)',
          },
          {
            stroke: '#94a3b8',
            grid: { stroke: 'rgba(148, 163, 184, 0.12)' },
            ticks: { stroke: '#475569' },
          },
        ],
        series: [
          {
            label: 'Time',
            value: (_self, rawValue) => `${Number(rawValue).toFixed(6)} s`,
          },
          ...channelNos.map((chNo, i) => ({
            label: labels?.get(chNo) ?? `CH${chNo}`,
            stroke: CHANNEL_COLORS[i % CHANNEL_COLORS.length],
            width: 2,
            spanGaps: false,
            points: { show: false },
          })),
        ],
        hooks: {
          setScale: [
            (self, scaleKey) => {
              if (syncingScalesRef.current) return;

              if (scaleKey === 'x') {
                const xScale = self.scales.x;
                const maxX = alignedDataRef.current[0][alignedDataRef.current[0].length - 1] ?? 0;
                if (xScale.max != null) {
                  followLatestRef.current = maxX - xScale.max <= sampleInterval * 2;
                }
              }

              if (scaleKey === 'y') {
                yAutoRef.current = false;
              }
            },
          ],
          ready: [
            (self) => {
              const xData = alignedDataRef.current[0];
              if (xData.length === 0) return;
              const xMin = xData[0];
              const xMax = xData[xData.length - 1];
              const yRange = getVisibleYRange(alignedDataRef.current, xMin, xMax);

              syncingScalesRef.current = true;
              self.batch(() => {
                self.setScale('x', { min: xMin, max: xMax });
                if (yRange) {
                  self.setScale('y', yRange);
                }
              });
              syncingScalesRef.current = false;
            },
          ],
        },
      },
      alignedDataRef.current,
      container,
    );

    plotRef.current = plot;

    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current || !plotRef.current) return;
      plotRef.current.setSize({
        width: Math.max(containerRef.current.clientWidth, 320),
        height: Math.max(containerRef.current.clientHeight, 240),
      });
    });
    resizeObserver.observe(container);
    resizeObserverRef.current = resizeObserver;

    return () => {
      resizeObserver.disconnect();
      resizeObserverRef.current = null;
      plot.destroy();
      if (plotRef.current === plot) {
        plotRef.current = null;
      }
    };
  }, [currentKey, effectiveChannels, labels, sampleInterval]);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;

    const channelNos = channelOrderRef.current;
    const currentData = alignedDataRef.current;
    const xData = currentData[0];
    let needsFullRebuild = xData.length === 0 && channelNos.some((chNo) => (effectiveChannels.get(chNo)?.length ?? 0) > 0);

    for (const chNo of channelNos) {
      const values = effectiveChannels.get(chNo) ?? [];
      const renderedCount = renderedCountsRef.current.get(chNo) ?? 0;
      if (values.length < renderedCount) {
        needsFullRebuild = true;
        break;
      }
    }

    if (needsFullRebuild) {
      alignedDataRef.current = buildAlignedData(channelNos, effectiveChannels, sampleInterval);
      renderedCountsRef.current = new Map(channelNos.map((chNo) => [chNo, effectiveChannels.get(chNo)?.length ?? 0]));
    } else {
      let maxLen = xData.length;
      channelNos.forEach((chNo) => {
        const values = effectiveChannels.get(chNo) ?? [];
        const renderedCount = renderedCountsRef.current.get(chNo) ?? 0;
        if (values.length > maxLen) {
          maxLen = values.length;
        }
        if (values.length === renderedCount) return;

        const seriesIndex = channelNos.indexOf(chNo) + 1;
        const seriesData = alignedDataRef.current[seriesIndex] as (number | null)[];
        for (let i = renderedCount; i < values.length; i++) {
          seriesData[i] = values[i];
        }
        renderedCountsRef.current.set(chNo, values.length);
      });

      if (maxLen > xData.length) {
        for (let i = xData.length; i < maxLen; i++) {
          xData[i] = i * sampleInterval;
        }
      }

      channelNos.forEach((chNo, channelIdx) => {
        const values = effectiveChannels.get(chNo) ?? [];
        const seriesData = alignedDataRef.current[channelIdx + 1] as (number | null)[];
        if (seriesData.length < maxLen) {
          for (let i = seriesData.length; i < maxLen; i++) {
            seriesData[i] = i < values.length ? values[i] : null;
          }
        }
        for (let i = values.length; i < maxLen; i++) {
          if (seriesData[i] === undefined) {
            seriesData[i] = null;
          }
        }
      });
    }

    const nextData = alignedDataRef.current;
    const nextXData = nextData[0];
    const nextMaxX = nextXData[nextXData.length - 1] ?? 0;
    const currentXScale = plot.scales.x;
    const currentSpan = currentXScale.max != null && currentXScale.min != null
      ? currentXScale.max - currentXScale.min
      : nextMaxX - (nextXData[0] ?? 0);

    syncingScalesRef.current = true;
    plot.batch(() => {
      plot.setData(nextData, false);

      if (followLatestRef.current && nextXData.length > 0) {
        const span = currentSpan > 0 ? Math.min(currentSpan, nextMaxX - (nextXData[0] ?? 0)) : nextMaxX - (nextXData[0] ?? 0);
        plot.setScale('x', {
          min: Math.max((nextXData[0] ?? 0), nextMaxX - span),
          max: nextMaxX,
        });
      }

      if (yAutoRef.current) {
        const xScale = plot.scales.x;
        const yRange = getVisibleYRange(nextData, xScale.min ?? 0, xScale.max ?? nextMaxX);
        if (yRange) {
          plot.setScale('y', yRange);
        }
      }
    });
    syncingScalesRef.current = false;
  }, [effectiveChannels, sampleInterval]);

  return (
    <div className="border border-slate-700 rounded bg-slate-900 h-full relative overflow-hidden">
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}