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
  /** 当前示波是否仍在运行，用于同步跟随状态 */
  running?: boolean;
  /** 可选：通道号 -> 显示标签（如 alias），未提供时默认 CH{n} */
  labels?: Map<number, string>;
}

export function OscChart({ channels, sampleInterval, running = true, labels }: OscChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const channelOrderRef = useRef<number[]>([]);
  const renderedCountsRef = useRef<Map<number, number>>(new Map());
  const alignedDataRef = useRef<AlignedData>([[]]);
  const xModeRef = useRef<'following' | 'manual'>('following');
  const yModeRef = useRef<'default' | 'manual'>('default');
  const syncingScalesRef = useRef(false);
  const xSpanRef = useRef(1); // 当前显示窗口宽度（秒），默认1s
  const defaultYRangeRef = useRef({ min: -5000, max: 5000 });

  const demoData = useMemo(() => generateDemoData(), []);
  const effectiveChannels = channels.size > 0 ? channels : demoData;
  const currentKey = `${sampleInterval}:${Array.from(effectiveChannels.keys()).sort().join(',')}`;

  // 始终持有最新的 effectiveChannels，供 effect 内部读取而不触发重建
  const effectiveChannelsRef = useRef(effectiveChannels);
  effectiveChannelsRef.current = effectiveChannels;

  const getLatestX = () => alignedDataRef.current[0][alignedDataRef.current[0].length - 1] ?? 0;

  const getDefaultYRange = () => defaultYRangeRef.current;

  const getXWindow = (plot: uPlot) => {
    const { min, max } = plot.scales.x;
    if (min == null || max == null) {
      return { min: 0, max: xSpanRef.current, span: xSpanRef.current };
    }
    return { min, max, span: Math.max(max - min, sampleInterval) };
  };

  // 根据当前数据量和 xSpan 计算应显示的视口范围
  const computeXView = () => {
    const latestX = getLatestX();
    const span = xSpanRef.current;
    if (latestX < span) {
      // 数据未填满窗口：左对齐，显示 0 ~ span
      return { min: 0, max: span };
    }
    // 数据超过窗口：右对齐，显示最新数据
    return { min: latestX - span, max: latestX };
  };

  const applyDefaultYForCurrentX = (plot: uPlot) => {
    const { min, max } = getXWindow(plot);
    const defaultRange = getDefaultYRange();
    const visibleRange = getVisibleYRange(alignedDataRef.current, min, max);

    if (!visibleRange) {
      plot.setScale('y', defaultRange);
      return;
    }

    if (visibleRange.min >= defaultRange.min && visibleRange.max <= defaultRange.max) {
      plot.setScale('y', defaultRange);
      return;
    }

    plot.setScale('y', visibleRange);
  };

  const moveToLatestView = (plot: uPlot) => {
    plot.setScale('x', computeXView());
  };

  const getAxisRegion = (plot: uPlot, event: WheelEvent): 'x' | 'y' | null => {
    const rect = plot.root.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const plotLeft = plot.bbox.left / uPlot.pxRatio;
    const plotTop = plot.bbox.top / uPlot.pxRatio;
    const plotWidth = plot.bbox.width / uPlot.pxRatio;
    const plotHeight = plot.bbox.height / uPlot.pxRatio;
    const overPlotX = x >= plotLeft && x <= plotLeft + plotWidth;
    const overPlotY = y >= plotTop && y <= plotTop + plotHeight;

    if (x < plotLeft && overPlotY) return 'y';
    // 绘图区内部或 X 轴区域均触发 X 轴缩放
    if (overPlotX && (overPlotY || y > plotTop + plotHeight)) return 'x';
    return null;
  };

  const zoomRange = (min: number, max: number, anchor: number, scaleFactor: number) => {
    const span = Math.max(max - min, sampleInterval);
    const nextSpan = Math.max(span * scaleFactor, sampleInterval);
    const ratio = span === 0 ? 0.5 : (anchor - min) / span;

    return {
      min: anchor - nextSpan * ratio,
      max: anchor + nextSpan * (1 - ratio),
    };
  };

  const handleWheelZoom = (event: WheelEvent) => {
    const plot = plotRef.current;
    if (!plot) return;

    const axis = getAxisRegion(plot, event);
    if (!axis) return;

    event.preventDefault();

    const scaleFactor = event.deltaY < 0 ? 0.85 : 1 / 0.85;

    syncingScalesRef.current = true;
    plot.batch(() => {
      if (axis === 'x') {
        xSpanRef.current = Math.max(xSpanRef.current * scaleFactor, sampleInterval);
        if (xModeRef.current === 'following') {
          moveToLatestView(plot);
        } else {
          // manual 模式：以鼠标在 X 轴的位置为锚点缩放当前视口
          const { min, max } = plot.scales.x;
          if (min != null && max != null) {
            const plotLeft = plot.bbox.left / uPlot.pxRatio;
            const anchor = plot.posToVal(event.clientX - plot.rect.left - plotLeft, 'x');
            plot.setScale('x', zoomRange(min, max, anchor, scaleFactor));
          }
        }

        if (yModeRef.current === 'default') {
          applyDefaultYForCurrentX(plot);
        }
      }

      if (axis === 'y') {
        const { min, max } = plot.scales.y;
        if (min == null || max == null) return;

        const plotTop = plot.bbox.top / uPlot.pxRatio;
        const anchor = plot.posToVal(event.clientY - plot.rect.top - plotTop, 'y');
        const next = zoomRange(min, max, anchor, scaleFactor);
        plot.setScale('y', next);
        yModeRef.current = 'manual';
      }
    });
    syncingScalesRef.current = false;
  };

  useEffect(() => {
    const container = containerRef.current;
    const effectiveChannels = effectiveChannelsRef.current;
    if (!container || effectiveChannels.size === 0) return;

    const channelNos = Array.from(effectiveChannels.keys()).sort((a, b) => a - b);
    channelOrderRef.current = channelNos;
    renderedCountsRef.current = new Map(channelNos.map((chNo) => [chNo, effectiveChannels.get(chNo)?.length ?? 0]));
    alignedDataRef.current = buildAlignedData(channelNos, effectiveChannels, sampleInterval);
    xModeRef.current = 'following';
    yModeRef.current = 'default';

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
            dblclick: (self, _target) => (event) => {
              event.preventDefault();

              syncingScalesRef.current = true;
              self.batch(() => {
                if (xModeRef.current === 'manual') {
                  xModeRef.current = 'following';
                  yModeRef.current = 'default';
                  moveToLatestView(self);
                  applyDefaultYForCurrentX(self);
                } else {
                  xModeRef.current = 'manual';
                }
              });
              syncingScalesRef.current = false;
              return null;
            },
            mousedown: (_self, _target, handler) => (event) => {
              if (xModeRef.current !== 'manual') {
                return null;
              }
              return handler(event);
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
            (_self, scaleKey) => {
              if (syncingScalesRef.current) return;
              if (scaleKey === 'y') {
                yModeRef.current = 'manual';
              }
            },
          ],
          ready: [
            (self) => {
              self.setScale('x', { min: 0, max: xSpanRef.current });
              self.setScale('y', getDefaultYRange());
              self.root.addEventListener('wheel', handleWheelZoom, { passive: false });
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
      plot.root.removeEventListener('wheel', handleWheelZoom);
      resizeObserver.disconnect();
      resizeObserverRef.current = null;
      plot.destroy();
      if (plotRef.current === plot) {
        plotRef.current = null;
      }
    };
  }, [currentKey, labels, sampleInterval]);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;

    if (!running) {
      xModeRef.current = 'manual';
      return;
    }

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
      channelNos.forEach((chNo, channelIdx) => {
        const values = effectiveChannels.get(chNo) ?? [];
        const renderedCount = renderedCountsRef.current.get(chNo) ?? 0;
        if (values.length > maxLen) {
          maxLen = values.length;
        }
        if (values.length === renderedCount) return;

        const seriesData = alignedDataRef.current[channelIdx + 1] as (number | null)[];
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

    syncingScalesRef.current = true;
    plot.batch(() => {
      plot.setData(nextData, false);

      if (nextXData.length > 0 && xModeRef.current !== 'manual') {
        moveToLatestView(plot);
      }

      if (yModeRef.current === 'default' && xModeRef.current !== 'manual') {
        applyDefaultYForCurrentX(plot);
      }
    });
    syncingScalesRef.current = false;
  }, [effectiveChannels, running, sampleInterval]);

  return (
    <div className="border border-slate-700 rounded bg-slate-900 h-full relative overflow-hidden">
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}