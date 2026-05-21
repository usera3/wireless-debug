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

function lowerBound(xData: number[], target: number): number {
  let lo = 0;
  let hi = xData.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xData[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function getVisibleYRange(data: AlignedData, xMin: number, xMax: number): { min: number; max: number } | null {
  const xData = data[0];
  if (xData.length === 0) return null;

  const startIdx = lowerBound(xData, xMin);
  const endIdx = lowerBound(xData, xMax);
  // endIdx 是第一个 > xMax 的位置，需包含 xMax 本身
  const inclusiveEnd = endIdx < xData.length && xData[endIdx] === xMax ? endIdx : endIdx - 1;

  if (startIdx > inclusiveEnd) return null;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (let seriesIdx = 1; seriesIdx < data.length; seriesIdx++) {
    const series = data[seriesIdx];
    for (let i = startIdx; i <= inclusiveEnd; i++) {
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
  const yModeRef = useRef<'auto' | 'manual'>('auto');
  const syncingScalesRef = useRef(false);
  const xSpanRef = useRef(1); // 当前显示窗口宽度（秒），默认1s
  const defaultYRangeRef = useRef({ min: -5000, max: 5000 });
  // 自动模式下已应用的 Y 范围（只增不减），null 表示从数据重新计算（无兜底）
  const autoYRangeRef = useRef<{ min: number; max: number } | null>(null);

  const demoData = useMemo(() => generateDemoData(), []);
  const effectiveChannels = channels.size > 0 ? channels : demoData;
  const currentKey = `${sampleInterval}:${Array.from(effectiveChannels.keys()).sort().join(',')}`;

  // 始终持有最新的 effectiveChannels，供 effect 内部读取而不触发重建
  const effectiveChannelsRef = useRef(effectiveChannels);
  effectiveChannelsRef.current = effectiveChannels;

  // 始终持有最新的 running，供事件 handler 闭包内读取
  const runningRef = useRef(running);
  runningRef.current = running;

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

  const applyAutoY = (plot: uPlot) => {
    const { min, max } = getXWindow(plot);
    const visibleRange = getVisibleYRange(alignedDataRef.current, min, max);

    const prev = autoYRangeRef.current;
    let nextRange: { min: number; max: number };
    if (!visibleRange) {
      if (!prev) return; // 既无历史也无数据，不改变 Y 轴
      nextRange = prev;
    } else if (!prev) {
      nextRange = visibleRange; // 双击后首次：纯数据，无兜底
    } else {
      // 只增不减
      nextRange = { min: Math.min(visibleRange.min, prev.min), max: Math.max(visibleRange.max, prev.max) };
    }

    autoYRangeRef.current = nextRange;
    plot.setScale('y', nextRange);
  };

  const moveToLatestView = (plot: uPlot) => {
    plot.setScale('x', computeXView());
  };

  const getAxisRegion = (plot: uPlot, clientX: number, clientY: number): 'x' | 'y' | null => {
    const rect = plot.root.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const plotLeft = plot.bbox.left / uPlot.pxRatio;
    const plotTop = plot.bbox.top / uPlot.pxRatio;
    const plotWidth = plot.bbox.width / uPlot.pxRatio;
    const plotHeight = plot.bbox.height / uPlot.pxRatio;
    const overPlotX = x >= plotLeft && x <= plotLeft + plotWidth;
    const overPlotY = y >= plotTop && y <= plotTop + plotHeight;
    const overPlotXOrY = overPlotX || overPlotY;

    if (x < plotLeft && overPlotY) return 'y';
    // 绘图区内部或 X 轴区域均触发 X 轴缩放
    if (overPlotXOrY && (overPlotY || y > plotTop + plotHeight)) return 'x';
    return null;
  };

  /** 严格坐标轴条带（不包含绘图区内部），用于平移拖拽 */
  const getAxisStripRegion = (plot: uPlot, clientX: number, clientY: number): 'x' | 'y' | null => {
    const rect = plot.root.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const plotLeft = plot.bbox.left / uPlot.pxRatio;
    const plotTop = plot.bbox.top / uPlot.pxRatio;
    const plotWidth = plot.bbox.width / uPlot.pxRatio;
    const plotHeight = plot.bbox.height / uPlot.pxRatio;
    const overPlotX = x >= plotLeft && x <= plotLeft + plotWidth;
    const overPlotY = y >= plotTop && y <= plotTop + plotHeight;

    // 仅 Y 轴左侧条带（不在绘图区内）
    if (x < plotLeft && overPlotY) return 'y';
    // 仅 X 轴下方条带（不在绘图区内）
    if (overPlotX && !overPlotY && y > plotTop + plotHeight) return 'x';
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

    const axis = getAxisRegion(plot, event.clientX, event.clientY);
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

        if (yModeRef.current === 'auto') {
          applyAutoY(plot);
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

  // 拖拽平移状态（不需要 ref，只在 handler 闭包内用）
  const panStateRef = useRef<{
    axis: 'x' | 'y';
    startClient: number;   // mousedown 时的 clientX 或 clientY
    startMin: number;
    startMax: number;
  } | null>(null);

  const handlePanStart = (event: MouseEvent) => {
    const plot = plotRef.current;
    if (!plot || event.button !== 0) return;

    const axis = getAxisStripRegion(plot, event.clientX, event.clientY);
    if (!axis) return;

    const scale = plot.scales[axis === 'x' ? 'x' : 'y'];
    if (scale.min == null || scale.max == null) return;

    panStateRef.current = {
      axis,
      startClient: axis === 'x' ? event.clientX : event.clientY,
      startMin: scale.min,
      startMax: scale.max,
    };
    event.preventDefault();
    // 阻止 uPlot 自身的 mousedown handler，避免在轴条带上触发框选
    event.stopPropagation();
  };

  const handlePanMove = (event: MouseEvent) => {
    const pan = panStateRef.current;
    const plot = plotRef.current;
    if (!pan || !plot) return;

    const { axis, startClient, startMin, startMax } = pan;
    const span = startMax - startMin;

    if (axis === 'x') {
      const plotWidth = plot.bbox.width / uPlot.pxRatio;
      if (plotWidth === 0) return;
      const deltaClient = event.clientX - startClient;
      const deltaVal = -(deltaClient / plotWidth) * span;
      xModeRef.current = 'manual';
      syncingScalesRef.current = true;
      plot.setScale('x', { min: startMin + deltaVal, max: startMax + deltaVal });
      syncingScalesRef.current = false;
    } else {
      const plotHeight = plot.bbox.height / uPlot.pxRatio;
      if (plotHeight === 0) return;
      const deltaClient = event.clientY - startClient;
      // Y 轴：向上拖（deltaClient 为负）应该增大值
      const deltaVal = (deltaClient / plotHeight) * span;
      yModeRef.current = 'manual';
      syncingScalesRef.current = true;
      plot.setScale('y', { min: startMin + deltaVal, max: startMax + deltaVal });
      syncingScalesRef.current = false;
    }
  };

  const handlePanEnd = () => {
    panStateRef.current = null;
  };

  // ─── Touch 手势状态 ────────────────────────────────────────────────────────
  const touchStateRef = useRef<{
    // 单指平移
    pan: {
      zone: 'plot' | 'x' | 'y';       // 触摸起始区域
      startX: number;                   // 起始 clientX（单指）
      startY: number;                   // 起始 clientY（单指）
      startXMin: number;
      startXMax: number;
      startYMin: number;
      startYMax: number;
    } | null;
    // 双指捏合
    pinch: {
      zone: 'plot' | 'x' | 'y';
      startDist: number;                // 两指初始距离
      startMidX: number;                // 两指中心 clientX
      startMidY: number;                // 两指中心 clientY
      startXMin: number;
      startXMax: number;
      startYMin: number;
      startYMax: number;
    } | null;
    // 双击检测
    lastTapTime: number;
    lastTapX: number;
    lastTapY: number;
  }>({
    pan: null,
    pinch: null,
    lastTapTime: 0,
    lastTapX: 0,
    lastTapY: 0,
  });

  /** 判断触摸点所在区域：plot 绘图区 / x 轴条带 / y 轴条带 */
  const getTouchZone = (plot: uPlot, clientX: number, clientY: number): 'plot' | 'x' | 'y' | null => {
    const rect = plot.root.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const plotLeft = plot.bbox.left / uPlot.pxRatio;
    const plotTop = plot.bbox.top / uPlot.pxRatio;
    const plotWidth = plot.bbox.width / uPlot.pxRatio;
    const plotHeight = plot.bbox.height / uPlot.pxRatio;
    const inPlotX = x >= plotLeft && x <= plotLeft + plotWidth;
    const inPlotY = y >= plotTop && y <= plotTop + plotHeight;

    if (inPlotX && inPlotY) return 'plot';
    if (x < plotLeft && inPlotY) return 'y';
    if (inPlotX && y > plotTop + plotHeight) return 'x';
    return null;
  };

  const handleTouchStart = (event: TouchEvent) => {
    const plot = plotRef.current;
    if (!plot) return;

    const ts = touchStateRef.current;

    if (event.touches.length === 1) {
      const t = event.touches[0];
      const zone = getTouchZone(plot, t.clientX, t.clientY);
      if (!zone) return;

      event.preventDefault();

      const xScale = plot.scales.x;
      const yScale = plot.scales.y;
      if (xScale.min == null || xScale.max == null || yScale.min == null || yScale.max == null) return;

      // 双击检测
      const now = Date.now();
      const DOUBLE_TAP_MS = 300;
      const DOUBLE_TAP_PX = 30;
      const dx = t.clientX - ts.lastTapX;
      const dy = t.clientY - ts.lastTapY;
      if (now - ts.lastTapTime < DOUBLE_TAP_MS && Math.sqrt(dx * dx + dy * dy) < DOUBLE_TAP_PX) {
        ts.lastTapTime = 0;
        if (!runningRef.current) return;
        // 触发双击复位
        syncingScalesRef.current = true;
        plot.batch(() => {
          if (xModeRef.current === 'manual') {
            xModeRef.current = 'following';
            yModeRef.current = 'auto';
            moveToLatestView(plot);
            applyAutoY(plot);
          } else {
            xModeRef.current = 'manual';
          }
        });
        syncingScalesRef.current = false;
        return;
      }
      ts.lastTapTime = now;
      ts.lastTapX = t.clientX;
      ts.lastTapY = t.clientY;

      ts.pinch = null;
      ts.pan = {
        zone,
        startX: t.clientX,
        startY: t.clientY,
        startXMin: xScale.min,
        startXMax: xScale.max,
        startYMin: yScale.min,
        startYMax: yScale.max,
      };
    } else if (event.touches.length === 2) {
      const t0 = event.touches[0];
      const t1 = event.touches[1];
      const midX = (t0.clientX + t1.clientX) / 2;
      const midY = (t0.clientY + t1.clientY) / 2;
      const zone = getTouchZone(plot, midX, midY) ?? 'plot';

      event.preventDefault();

      const xScale = plot.scales.x;
      const yScale = plot.scales.y;
      if (xScale.min == null || xScale.max == null || yScale.min == null || yScale.max == null) return;

      const dx = t1.clientX - t0.clientX;
      const dy = t1.clientY - t0.clientY;
      ts.pan = null;
      ts.pinch = {
        zone,
        startDist: Math.sqrt(dx * dx + dy * dy),
        startMidX: midX,
        startMidY: midY,
        startXMin: xScale.min,
        startXMax: xScale.max,
        startYMin: yScale.min,
        startYMax: yScale.max,
      };
    }
  };

  const handleTouchMove = (event: TouchEvent) => {
    const plot = plotRef.current;
    if (!plot) return;

    const ts = touchStateRef.current;

    if (event.touches.length === 1 && ts.pan) {
      event.preventDefault();
      const t = event.touches[0];
      const { zone, startX, startY, startXMin, startXMax, startYMin, startYMax } = ts.pan;
      const xSpan = startXMax - startXMin;
      const ySpan = startYMax - startYMin;
      const plotWidth = plot.bbox.width / uPlot.pxRatio;
      const plotHeight = plot.bbox.height / uPlot.pxRatio;

      syncingScalesRef.current = true;
      plot.batch(() => {
        if ((zone === 'plot' || zone === 'x') && plotWidth > 0) {
          const deltaX = -((t.clientX - startX) / plotWidth) * xSpan;
          xModeRef.current = 'manual';
          plot.setScale('x', { min: startXMin + deltaX, max: startXMax + deltaX });
        }
        if ((zone === 'plot' || zone === 'y') && plotHeight > 0) {
          const deltaY = ((t.clientY - startY) / plotHeight) * ySpan;
          yModeRef.current = 'manual';
          plot.setScale('y', { min: startYMin + deltaY, max: startYMax + deltaY });
        }
      });
      syncingScalesRef.current = false;
    } else if (event.touches.length === 2 && ts.pinch) {
      event.preventDefault();
      const t0 = event.touches[0];
      const t1 = event.touches[1];
      const { zone, startDist, startMidX, startMidY, startXMin, startXMax, startYMin, startYMax } = ts.pinch;

      const dx = t1.clientX - t0.clientX;
      const dy = t1.clientY - t0.clientY;
      const currentDist = Math.sqrt(dx * dx + dy * dy);
      if (startDist === 0) return;

      const scaleFactor = startDist / currentDist; // >1 缩小，<1 放大
      const plotLeft = plot.bbox.left / uPlot.pxRatio;
      const plotTop = plot.bbox.top / uPlot.pxRatio;
      const rect = plot.root.getBoundingClientRect();

      syncingScalesRef.current = true;
      plot.batch(() => {
        if (zone === 'plot' || zone === 'x') {
          const anchorX = plot.posToVal(startMidX - rect.left - plotLeft, 'x');
          const next = zoomRange(startXMin, startXMax, anchorX, scaleFactor);
          xSpanRef.current = Math.max(next.max - next.min, sampleInterval);
          xModeRef.current = 'manual';
          plot.setScale('x', next);
        }
        if (zone === 'plot' || zone === 'y') {
          const anchorY = plot.posToVal(startMidY - rect.top - plotTop, 'y');
          const next = zoomRange(startYMin, startYMax, anchorY, scaleFactor);
          yModeRef.current = 'manual';
          plot.setScale('y', next);
        }
      });
      syncingScalesRef.current = false;
    }
  };

  const handleTouchEnd = (event: TouchEvent) => {
    const ts = touchStateRef.current;
    if (event.touches.length === 0) {
      ts.pan = null;
      ts.pinch = null;
    } else if (event.touches.length === 1 && ts.pinch) {
      // 从双指切换回单指：重置为单指平移状态
      const plot = plotRef.current;
      ts.pinch = null;
      if (plot) {
        const t = event.touches[0];
        const xScale = plot.scales.x;
        const yScale = plot.scales.y;
        if (xScale.min != null && xScale.max != null && yScale.min != null && yScale.max != null) {
          const zone = getTouchZone(plot, t.clientX, t.clientY) ?? 'plot';
          ts.pan = {
            zone,
            startX: t.clientX,
            startY: t.clientY,
            startXMin: xScale.min,
            startXMax: xScale.max,
            startYMin: yScale.min,
            startYMax: yScale.max,
          };
        }
      }
    }
  };

  // ─── 注册/注销 touch 事件 ──────────────────────────────────────────────────
  // 将 handler 存入 ref，避免 effect 依赖变化导致重复注册
  const touchHandlersRef = useRef({ handleTouchStart, handleTouchMove, handleTouchEnd });
  touchHandlersRef.current = { handleTouchStart, handleTouchMove, handleTouchEnd };

  useEffect(() => {
    const container = containerRef.current;
    const effectiveChannels = effectiveChannelsRef.current;
    if (!container || effectiveChannels.size === 0) return;

    const channelNos = Array.from(effectiveChannels.keys()).sort((a, b) => a - b);
    channelOrderRef.current = channelNos;
    renderedCountsRef.current = new Map(channelNos.map((chNo) => [chNo, effectiveChannels.get(chNo)?.length ?? 0]));
    alignedDataRef.current = buildAlignedData(channelNos, effectiveChannels, sampleInterval);
    xModeRef.current = 'following';
    yModeRef.current = 'auto';
    autoYRangeRef.current = getDefaultYRange(); // 启动时以 ±5000 为初始累积基准

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
              void event;

              syncingScalesRef.current = true;
              self.batch(() => {
                if (xModeRef.current === 'manual') {
                  if (runningRef.current) xModeRef.current = 'following';
                  yModeRef.current = 'auto';
                  autoYRangeRef.current = null; // 清除历史，双击后纯数据范围，无 ±5000 兜底
                  moveToLatestView(self);
                  applyAutoY(self);
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
              self.root.addEventListener('mousedown', handlePanStart);
              window.addEventListener('mousemove', handlePanMove);
              window.addEventListener('mouseup', handlePanEnd);
              // 用稳定的 wrapper 代理到最新 handler，保证 remove 时引用一致
              const onTouchStart = (e: TouchEvent) => touchHandlersRef.current.handleTouchStart(e);
              const onTouchMove = (e: TouchEvent) => touchHandlersRef.current.handleTouchMove(e);
              const onTouchEnd = (e: TouchEvent) => touchHandlersRef.current.handleTouchEnd(e);
              self.root.addEventListener('touchstart', onTouchStart, { passive: false });
              self.root.addEventListener('touchmove', onTouchMove, { passive: false });
              self.root.addEventListener('touchend', onTouchEnd);
              // 将 wrapper 挂到 root 上，供 cleanup 取用
              (self.root as HTMLElement & { _touchHandlers?: { onTouchStart: (e: TouchEvent) => void; onTouchMove: (e: TouchEvent) => void; onTouchEnd: (e: TouchEvent) => void } })._touchHandlers = { onTouchStart, onTouchMove, onTouchEnd };
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
      plot.root.removeEventListener('mousedown', handlePanStart);
      window.removeEventListener('mousemove', handlePanMove);
      window.removeEventListener('mouseup', handlePanEnd);
      const th = (plot.root as HTMLElement & { _touchHandlers?: { onTouchStart: (e: TouchEvent) => void; onTouchMove: (e: TouchEvent) => void; onTouchEnd: (e: TouchEvent) => void } })._touchHandlers;
      if (th) {
        plot.root.removeEventListener('touchstart', th.onTouchStart);
        plot.root.removeEventListener('touchmove', th.onTouchMove);
        plot.root.removeEventListener('touchend', th.onTouchEnd);
      }
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

      if (yModeRef.current === 'auto' && xModeRef.current !== 'manual') {
        applyAutoY(plot);
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