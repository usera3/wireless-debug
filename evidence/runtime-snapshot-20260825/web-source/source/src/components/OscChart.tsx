import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { getPlotRelativePosition, zoomRange } from '../lib/oscZoom';
import { formatOscAxisValue, formatOscHoverTime, formatOscValue } from '../lib/oscDisplay';

const CHANNEL_COLORS = [
  '#4ade80', '#60a5fa', '#f97316', '#e879f9',
  '#facc15', '#34d399', '#f87171', '#a78bfa',
  '#fb923c', '#38bdf8', '#4ade80', '#f472b6',
];

type AlignedSeries = number[] | (number | null)[];
type AlignedData = [number[], ...AlignedSeries[]];
type ChartSeriesDef = { key: string | number; label: string };

const MAX_PLOT_POINTS = 2400;
const EMPTY_CHANNELS = new Map<number, number[]>();

function emptyAlignedData(seriesCount: number, xData: number[] = []): AlignedData {
  const data: AlignedData = [xData];
  for (let i = 0; i < seriesCount; i++) {
    data.push(xData.length > 0 ? new Array<number | null>(xData.length).fill(null) : []);
  }
  return data;
}

function normalizeAlignedDataForSeries(data: AlignedData, seriesCount: number): AlignedData {
  const xData = data[0] ?? [];
  const normalized: AlignedData = [xData];

  for (let i = 0; i < seriesCount; i++) {
    const source = data[i + 1];
    if (!source) {
      normalized.push(xData.length > 0 ? new Array<number | null>(xData.length).fill(null) : []);
      continue;
    }

    if (source.length === xData.length) {
      normalized.push(source);
      continue;
    }

    const aligned = new Array<number | null>(xData.length).fill(null);
    const copyLength = Math.min(source.length, xData.length);
    for (let j = 0; j < copyLength; j++) {
      const value = source[j];
      aligned[j] = value == null || !Number.isFinite(value) ? null : value;
    }
    normalized.push(aligned);
  }

  return normalized;
}

function getDataSpan(
  channelNos: number[],
  channels: Map<number, number[]>,
  sampleOffsets?: Map<number, number>,
): { start: number; end: number; length: number } | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;

  channelNos.forEach((chNo) => {
    const values = channels.get(chNo) ?? [];
    if (values.length === 0) return;
    const offset = sampleOffsets?.get(chNo) ?? 0;
    start = Math.min(start, offset);
    end = Math.max(end, offset + values.length);
  });

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end, length: end - start };
}

function buildFullAlignedData(
  channelNos: number[],
  channels: Map<number, number[]>,
  sampleInterval: number,
  sampleOffsets?: Map<number, number>,
): AlignedData {
  const span = getDataSpan(channelNos, channels, sampleOffsets);
  if (!span) return emptyAlignedData(channelNos.length);

  const xData = Array.from({ length: span.length }, (_, i) => (span.start + i) * sampleInterval);
  const seriesData = channelNos.map((chNo) => {
    const values = channels.get(chNo) ?? [];
    const aligned = new Array<number | null>(span.length).fill(null);
    const start = (sampleOffsets?.get(chNo) ?? 0) - span.start;
    for (let i = 0; i < values.length; i++) {
      const alignedIndex = start + i;
      if (alignedIndex >= 0 && alignedIndex < aligned.length) {
        aligned[alignedIndex] = values[i];
      }
    }
    return aligned;
  });

  return [xData, ...seriesData];
}

function buildAlignedData(
  channelNos: number[],
  channels: Map<number, number[]>,
  sampleInterval: number,
  sampleOffsets?: Map<number, number>,
): AlignedData {
  const span = getDataSpan(channelNos, channels, sampleOffsets);
  if (!span) return emptyAlignedData(channelNos.length);

  if (span.length <= MAX_PLOT_POINTS) {
    return buildFullAlignedData(channelNos, channels, sampleInterval, sampleOffsets);
  }

  const bucketSize = Math.max(1, Math.ceil(span.length / Math.floor(MAX_PLOT_POINTS / 2)));
  const xData: number[] = [];
  const seriesData = channelNos.map(() => [] as (number | null)[]);

  for (let start = 0; start < span.length; start += bucketSize) {
    const end = Math.min(span.length - 1, start + bucketSize - 1);
    const pointOffset = xData.length;
    xData.push((span.start + start) * sampleInterval);
    if (end !== start) xData.push((span.start + end) * sampleInterval);

    channelNos.forEach((chNo, channelIdx) => {
      const values = channels.get(chNo) ?? [];
      const channelStart = (sampleOffsets?.get(chNo) ?? 0) - span.start;
      const valueStart = Math.max(start, channelStart);
      const valueEnd = Math.min(end, channelStart + values.length - 1);
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (let i = valueStart; i <= valueEnd; i++) {
        const value = values[i - channelStart];
        if (value == null || !Number.isFinite(value)) continue;
        if (value < min) min = value;
        if (value > max) max = value;
      }

      const series = seriesData[channelIdx];
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        series[pointOffset] = null;
        if (end !== start) series[pointOffset + 1] = null;
      } else {
        series[pointOffset] = min;
        if (end !== start) series[pointOffset + 1] = max;
      }
    });
  }

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

function getVisibleYRange(
  data: AlignedData,
  xMin: number,
  xMax: number,
  visibleSeries?: boolean[],
): { min: number; max: number } | null {
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
    if (visibleSeries && visibleSeries[seriesIdx] === false) continue;
    const series = data[seriesIdx];
    for (let i = startIdx; i <= inclusiveEnd; i++) {
      const value = series[i];
      if (value == null || !Number.isFinite(value)) continue;
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
  channels?: Map<number, number[]>;
  /** 已经按当前视口预处理/降采样过的数据。传入后不会再从 channels 构建。 */
  alignedData?: AlignedData;
  series?: ChartSeriesDef[];
  /** 采样间隔（秒），用于 x 轴时间计算 */
  sampleInterval: number;
  /** 当前示波是否仍在运行，用于同步跟随状态 */
  running?: boolean;
  /** 跟随模式下默认显示的时间窗口（秒） */
  windowSeconds?: number;
  /** 外部数据源指定的 X 轴视口。 */
  xRange?: { min: number; max: number };
  /** 用户在图表内拖动/缩放 X 轴后回传新视口。 */
  onXRangeChange?: (range: { min: number; max: number }) => void;
  /** 外部触发完整视图复位：X 回到指定窗口，Y 回到自动范围。 */
  resetViewSignal?: number;
  /** 每个通道开头已丢弃的样本数，用于滚动窗口保持绝对时间轴 */
  sampleOffsets?: Map<number, number>;
  /** 可选：通道号 -> 显示标签（如 alias），未提供时默认 CH{n} */
  labels?: Map<number, string>;
}

export function OscChart({
  channels = EMPTY_CHANNELS,
  alignedData,
  series,
  sampleInterval,
  running = true,
  windowSeconds,
  xRange,
  onXRangeChange,
  resetViewSignal,
  sampleOffsets,
  labels,
}: OscChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hoverTooltipRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const channelOrderRef = useRef<number[]>([]);
  const renderedCountsRef = useRef<Map<number, number>>(new Map());
  const alignedDataRef = useRef<AlignedData>([[]]);
  const xModeRef = useRef<'following' | 'manual'>('following');
  const yModeRef = useRef<'auto' | 'manual'>('auto');
  const syncingScalesRef = useRef(false);
  const xSpanRef = useRef(1); // 未提供窗口时的回退值，实际下限由采样间隔决定
  const windowSecondsRef = useRef(windowSeconds);
  const defaultYRangeRef = useRef({ min: -5000, max: 5000 });
  // 自动模式下已应用的 Y 范围。图例隐藏/恢复后要按当前可见曲线重新计算。
  const autoYRangeRef = useRef<{ min: number; max: number } | null>(null);
  const seriesVisibilityRef = useRef<Map<string, boolean>>(new Map());
  windowSecondsRef.current = windowSeconds;

  const currentKey = alignedData && series
    ? `${sampleInterval}:${series.map((item) => `${item.key}:${item.label}`).join(',')}`
    : `${sampleInterval}:${Array.from(channels.keys()).sort().join(',')}`;

  // 始终持有最新的 effectiveChannels，供 effect 内部读取而不触发重建
  const effectiveChannelsRef = useRef(channels);
  effectiveChannelsRef.current = channels;

  const alignedInputRef = useRef(alignedData);
  alignedInputRef.current = alignedData;

  const seriesInputRef = useRef(series);
  seriesInputRef.current = series;

  const xRangeRef = useRef(xRange);
  xRangeRef.current = xRange;

  const onXRangeChangeRef = useRef(onXRangeChange);
  onXRangeChangeRef.current = onXRangeChange;

  const sampleOffsetsRef = useRef(sampleOffsets);
  sampleOffsetsRef.current = sampleOffsets;

  // 始终持有最新的 running，供事件 handler 闭包内读取
  const runningRef = useRef(running);
  runningRef.current = running;

  // 始终持有最新的 labels，供图表构建时读取，避免 labels 引用变化触发图表重建
  const labelsRef = useRef(labels);
  labelsRef.current = labels;

  const updateHoverTooltip = (plot: uPlot) => {
    const tooltip = hoverTooltipRef.current;
    const container = containerRef.current;
    if (!tooltip || !container) return;

    const idx = plot.cursor.idx;
    const xValue = idx == null ? null : plot.data[0]?.[idx];
    if (idx == null || typeof xValue !== 'number' || !Number.isFinite(xValue)) {
      tooltip.hidden = true;
      return;
    }

    const rows: HTMLDivElement[] = [];
    for (let seriesIdx = 1; seriesIdx < plot.series.length; seriesIdx++) {
      if (plot.series[seriesIdx].show === false) continue;
      const dataIdx = plot.cursor.idxs?.[seriesIdx] ?? idx;
      if (dataIdx == null) continue;
      const rawValue = plot.data[seriesIdx]?.[dataIdx];
      if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) continue;

      const row = document.createElement('div');
      row.className = 'flex items-center gap-2 whitespace-nowrap';

      const marker = document.createElement('span');
      marker.className = 'inline-block h-2 w-2 shrink-0 rounded-full';
      marker.style.backgroundColor = CHANNEL_COLORS[(seriesIdx - 1) % CHANNEL_COLORS.length];

      const label = document.createElement('span');
      label.className = 'text-slate-300';
      label.textContent = `${String(plot.series[seriesIdx].label ?? `CH${seriesIdx}`)}:`;

      const value = document.createElement('span');
      value.className = 'font-semibold text-white';
      value.textContent = formatOscValue(rawValue);

      row.append(marker, label, value);
      rows.push(row);
    }

    if (rows.length === 0) {
      tooltip.hidden = true;
      return;
    }

    const header = document.createElement('div');
    header.className = 'mb-1 border-b border-slate-700 pb-1 font-semibold text-slate-100';
    header.textContent = `Time: ${formatOscHoverTime(xValue, sampleInterval)}`;
    tooltip.replaceChildren(header, ...rows);
    tooltip.hidden = false;

    const plotLeft = plot.bbox.left / uPlot.pxRatio;
    const plotTop = plot.bbox.top / uPlot.pxRatio;
    const cursorLeft = plot.cursor.left ?? -1;
    const cursorTop = plot.cursor.top ?? -1;
    const preferredLeft = plotLeft + cursorLeft + 12;
    const preferredTop = plotTop + cursorTop + 12;
    const maxLeft = Math.max(8, container.clientWidth - tooltip.offsetWidth - 8);
    const maxTop = Math.max(8, container.clientHeight - tooltip.offsetHeight - 8);
    tooltip.style.left = `${Math.max(8, Math.min(preferredLeft, maxLeft))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(preferredTop, maxTop))}px`;
  };

  const getLatestX = () => alignedDataRef.current[0][alignedDataRef.current[0].length - 1] ?? 0;

  const getDefaultYRange = () => defaultYRangeRef.current;

  const getRenderedSeriesKey = (seriesIndex: number): string | null => {
    if (seriesIndex <= 0) return null;
    const externalSeries = seriesInputRef.current;
    const fallbackChannelNo = channelOrderRef.current[seriesIndex - 1];
    const key = externalSeries?.[seriesIndex - 1]?.key ?? fallbackChannelNo ?? seriesIndex;
    return String(key);
  };

  const recordSeriesVisibility = (plot: uPlot, seriesIndex: number | null, show: boolean) => {
    const updateOne = (index: number) => {
      const key = getRenderedSeriesKey(index);
      if (key) seriesVisibilityRef.current.set(key, show);
    };

    if (seriesIndex == null) {
      for (let index = 1; index < plot.series.length; index++) updateOne(index);
    } else {
      updateOne(seriesIndex);
    }
  };

  const applyStoredSeriesVisibility = (plot: uPlot) => {
    for (let index = 1; index < plot.series.length; index++) {
      const key = getRenderedSeriesKey(index);
      const expectedVisible = key ? seriesVisibilityRef.current.get(key) ?? true : true;
      const currentVisible = plot.series[index].show !== false;
      if (currentVisible !== expectedVisible) {
        plot.setSeries(index, { show: expectedVisible }, false);
      }
    }
  };

  const isCurrentAutoYScale = (plot: uPlot) => {
    const autoRange = autoYRangeRef.current;
    const { min, max } = plot.scales.y;
    if (!autoRange || min == null || max == null) return false;

    const span = Math.max(Math.abs(autoRange.max - autoRange.min), 1);
    const epsilon = span * 1e-9;
    return Math.abs(min - autoRange.min) <= epsilon && Math.abs(max - autoRange.max) <= epsilon;
  };

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
    const visibleRange = getVisibleYRange(
      alignedDataRef.current,
      min,
      max,
      plot.series.map((series) => series.show !== false),
    );
    const nextRange = visibleRange ? { min: visibleRange.min, max: visibleRange.max } : getDefaultYRange();
    autoYRangeRef.current = nextRange;
    yModeRef.current = 'auto';
    plot.setScale('y', nextRange);
    yModeRef.current = 'auto';
  };

  const moveToLatestView = (plot: uPlot) => {
    plot.setScale('x', computeXView());
  };

  const emitXRangeChange = (plot: uPlot) => {
    const { min, max } = plot.scales.x;
    if (min == null || max == null || max <= min) return;
    onXRangeChangeRef.current?.({ min, max });
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

  /** 判断指针所在区域：plot 绘图区 / x 轴条带 / y 轴条带 */
  const getPanZone = (plot: uPlot, clientX: number, clientY: number): 'plot' | 'x' | 'y' | null => {
    const rect = plot.root.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const plotLeft = plot.bbox.left / uPlot.pxRatio;
    const plotTop = plot.bbox.top / uPlot.pxRatio;
    const plotWidth = plot.bbox.width / uPlot.pxRatio;
    const plotHeight = plot.bbox.height / uPlot.pxRatio;
    const overPlotX = x >= plotLeft && x <= plotLeft + plotWidth;
    const overPlotY = y >= plotTop && y <= plotTop + plotHeight;

    if (overPlotX && overPlotY) return 'plot';
    if (x < plotLeft && overPlotY) return 'y';
    if (overPlotX && !overPlotY && y > plotTop + plotHeight) return 'x';
    return null;
  };

  const handleWheelZoom = (event: WheelEvent) => {
    const plot = plotRef.current;
    if (!plot) return;

    const axis = getAxisRegion(plot, event.clientX, event.clientY);
    if (!axis) return;

    event.preventDefault();

    const scaleFactor = event.deltaY < 0 ? 0.85 : 1 / 0.85;
    let nextXRange: { min: number; max: number } | null = null;

    syncingScalesRef.current = true;
    plot.batch(() => {
      applyStoredSeriesVisibility(plot);

      if (axis === 'x') {
        const { min, max } = plot.scales.x;
        if (min != null && max != null) {
          // plot.rect 是 uPlot 绘图区 overlay 的矩形，posToVal() 需要其内部坐标。
          const position = getPlotRelativePosition(event.clientX, event.clientY, plot.rect);
          const anchor = plot.posToVal(position.x, 'x');
          nextXRange = zoomRange(min, max, anchor, scaleFactor, sampleInterval);
          xSpanRef.current = Math.max(nextXRange.max - nextXRange.min, sampleInterval);
          xModeRef.current = 'manual';
          plot.setScale('x', nextXRange);
        }

        if (yModeRef.current === 'auto') {
          applyAutoY(plot);
        }
      }

      if (axis === 'y') {
        const { min, max } = plot.scales.y;
        if (min == null || max == null) return;

        const position = getPlotRelativePosition(event.clientX, event.clientY, plot.rect);
        const anchor = plot.posToVal(position.y, 'y');
        const next = zoomRange(min, max, anchor, scaleFactor, sampleInterval);
        plot.setScale('y', next);
        yModeRef.current = 'manual';
      }
    });
    syncingScalesRef.current = false;
    if (nextXRange) {
      onXRangeChangeRef.current?.(nextXRange);
    }
  };

  // 拖拽平移状态（不需要 ref，只在 handler 闭包内用）
  const panStateRef = useRef<{
    zone: 'plot' | 'x' | 'y';
    startX: number;
    startY: number;
    startXMin: number;
    startXMax: number;
    startYMin: number;
    startYMax: number;
  } | null>(null);

  const handlePanStart = (event: MouseEvent) => {
    const plot = plotRef.current;
    if (!plot || event.button !== 0) return;

    const zone = getPanZone(plot, event.clientX, event.clientY);
    if (!zone) return;

    const xScale = plot.scales.x;
    const yScale = plot.scales.y;
    if (xScale.min == null || xScale.max == null || yScale.min == null || yScale.max == null) return;

    panStateRef.current = {
      zone,
      startX: event.clientX,
      startY: event.clientY,
      startXMin: xScale.min,
      startXMax: xScale.max,
      startYMin: yScale.min,
      startYMax: yScale.max,
    };
    event.preventDefault();
    // 阻止 uPlot 自身的 mousedown handler，避免拖拽时触发框选
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  const handlePanMove = (event: MouseEvent) => {
    const pan = panStateRef.current;
    const plot = plotRef.current;
    if (!pan || !plot) return;

    event.preventDefault();

    const { zone, startX, startY, startXMin, startXMax, startYMin, startYMax } = pan;
    const xSpan = startXMax - startXMin;
    const ySpan = startYMax - startYMin;
    const plotWidth = plot.bbox.width / uPlot.pxRatio;
    const plotHeight = plot.bbox.height / uPlot.pxRatio;

    syncingScalesRef.current = true;
    plot.batch(() => {
      if ((zone === 'plot' || zone === 'x') && plotWidth > 0) {
        const deltaX = -((event.clientX - startX) / plotWidth) * xSpan;
        xModeRef.current = 'manual';
        plot.setScale('x', { min: startXMin + deltaX, max: startXMax + deltaX });
      }
      if ((zone === 'plot' || zone === 'y') && plotHeight > 0) {
        const deltaY = ((event.clientY - startY) / plotHeight) * ySpan;
        yModeRef.current = 'manual';
        plot.setScale('y', { min: startYMin + deltaY, max: startYMax + deltaY });
      }
    });
    syncingScalesRef.current = false;
    if (zone === 'plot' || zone === 'x') {
      emitXRangeChange(plot);
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

  const handleTouchStart = (event: TouchEvent) => {
    const plot = plotRef.current;
    if (!plot) return;

    const ts = touchStateRef.current;

    if (event.touches.length === 1) {
      const t = event.touches[0];
      const zone = getPanZone(plot, t.clientX, t.clientY);
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
      const zone = getPanZone(plot, midX, midY) ?? 'plot';

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
      if (zone === 'plot' || zone === 'x') {
        emitXRangeChange(plot);
      }
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
      const plotRect = plot.rect;

      syncingScalesRef.current = true;
      plot.batch(() => {
        if (zone === 'plot' || zone === 'x') {
          const startPosition = getPlotRelativePosition(startMidX, startMidY, plotRect);
          const anchorX = plot.posToVal(startPosition.x, 'x');
          const next = zoomRange(startXMin, startXMax, anchorX, scaleFactor, sampleInterval);
          xSpanRef.current = Math.max(next.max - next.min, sampleInterval);
          xModeRef.current = 'manual';
          plot.setScale('x', next);
        }
        if (zone === 'plot' || zone === 'y') {
          const startPosition = getPlotRelativePosition(startMidX, startMidY, plotRect);
          const anchorY = plot.posToVal(startPosition.y, 'y');
          const next = zoomRange(startYMin, startYMax, anchorY, scaleFactor, sampleInterval);
          yModeRef.current = 'manual';
          plot.setScale('y', next);
        }
      });
      syncingScalesRef.current = false;
      if (zone === 'plot' || zone === 'x') {
        emitXRangeChange(plot);
      }
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
          const zone = getPanZone(plot, t.clientX, t.clientY) ?? 'plot';
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
    const hoverTooltip = hoverTooltipRef.current;
    const effectiveChannels = effectiveChannelsRef.current;
    const externalData = alignedInputRef.current;
    const externalSeries = seriesInputRef.current;
    const usingExternalData = externalData != null && externalSeries != null;
    if (!container) return;

    const channelNos = usingExternalData
      ? externalSeries.map((_, index) => index + 1)
      : Array.from(effectiveChannels.keys()).sort((a, b) => a - b);
    if (channelNos.length === 0) return;

    channelOrderRef.current = channelNos;
    renderedCountsRef.current = new Map(channelNos.map((chNo) => [chNo, effectiveChannels.get(chNo)?.length ?? 0]));
    const initialWindowSeconds = windowSecondsRef.current;
    if (initialWindowSeconds != null) {
      xSpanRef.current = Math.max(initialWindowSeconds, sampleInterval);
    }
    alignedDataRef.current = usingExternalData
      ? normalizeAlignedDataForSeries(externalData, externalSeries.length)
      : buildAlignedData(channelNos, effectiveChannels, sampleInterval, sampleOffsetsRef.current);
    xModeRef.current = 'following';
    yModeRef.current = 'auto';
    autoYRangeRef.current = getDefaultYRange();

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
            dblclick: (self, target) => {
              void target;
              return (event) => {
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
              };
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
            values: (_self, splits, _axisIdx, _foundSpace, foundIncr) => (
              splits.map((value) => formatOscAxisValue(value, foundIncr))
            ),
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
            label: usingExternalData
              ? externalSeries[i]?.label ?? `CH${chNo}`
              : labelsRef.current?.get(chNo) ?? `CH${chNo}`,
            show: seriesVisibilityRef.current.get(String(usingExternalData ? externalSeries[i]?.key ?? chNo : chNo)) ?? true,
            stroke: CHANNEL_COLORS[i % CHANNEL_COLORS.length],
            width: 2,
            spanGaps: true,
            points: { show: false },
          })),
        ],
        hooks: {
          setScale: [
            (self, scaleKey) => {
              if (syncingScalesRef.current) return;
              if (scaleKey === 'x') {
                emitXRangeChange(self);
              }
              if (scaleKey === 'y') {
                if (isCurrentAutoYScale(self)) return;
                yModeRef.current = 'manual';
              }
            },
          ],
          setSeries: [
            (self, seriesIdx, opts) => {
              if (opts.show != null) {
                recordSeriesVisibility(self, seriesIdx, opts.show);
              }
              if (yModeRef.current !== 'auto') return;
              requestAnimationFrame(() => {
                if (plotRef.current !== self || yModeRef.current !== 'auto') return;
                syncingScalesRef.current = true;
                self.batch(() => applyAutoY(self));
                syncingScalesRef.current = false;
              });
            },
          ],
          setCursor: [
            (self) => updateHoverTooltip(self),
          ],
          ready: [
            (self) => {
              syncingScalesRef.current = true;
              self.batch(() => {
                applyStoredSeriesVisibility(self);
                self.setScale('x', xRangeRef.current ?? { min: 0, max: xSpanRef.current });
                applyAutoY(self);
              });
              syncingScalesRef.current = false;
              self.root.addEventListener('wheel', handleWheelZoom, { passive: false });
              self.root.addEventListener('mousedown', handlePanStart, true);
              window.addEventListener('mousemove', handlePanMove);
              window.addEventListener('mouseup', handlePanEnd);
              // 用稳定的 wrapper 代理到最新 handler，保证 remove 时引用一致
              const onTouchStart = (e: TouchEvent) => touchHandlersRef.current.handleTouchStart(e);
              const onTouchMove = (e: TouchEvent) => touchHandlersRef.current.handleTouchMove(e);
              const onTouchEnd = (e: TouchEvent) => touchHandlersRef.current.handleTouchEnd(e);
              const onLegendClick = (e: MouseEvent) => {
                const target = e.target;
                if (!(target instanceof HTMLElement) || !target.closest('.u-legend')) return;

                const refreshVisibleSeries = () => {
                  if (plotRef.current !== self) return;
                  yModeRef.current = 'auto';
                  syncingScalesRef.current = true;
                  self.batch(() => {
                    applyAutoY(self);
                    self.redraw();
                  });
                  syncingScalesRef.current = false;
                };

                requestAnimationFrame(refreshVisibleSeries);
                window.setTimeout(refreshVisibleSeries, 50);
              };
              self.root.addEventListener('touchstart', onTouchStart, { passive: false });
              self.root.addEventListener('touchmove', onTouchMove, { passive: false });
              self.root.addEventListener('touchend', onTouchEnd);
              self.root.addEventListener('click', onLegendClick, true);
              // 将 wrapper 挂到 root 上，供 cleanup 取用
              (self.root as HTMLElement & { _touchHandlers?: { onTouchStart: (e: TouchEvent) => void; onTouchMove: (e: TouchEvent) => void; onTouchEnd: (e: TouchEvent) => void } })._touchHandlers = { onTouchStart, onTouchMove, onTouchEnd };
              (self.root as HTMLElement & { _legendClickHandler?: (e: MouseEvent) => void })._legendClickHandler = onLegendClick;
              if (hoverTooltip) hoverTooltip.hidden = true;
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
      plot.root.removeEventListener('mousedown', handlePanStart, true);
      window.removeEventListener('mousemove', handlePanMove);
      window.removeEventListener('mouseup', handlePanEnd);
      const th = (plot.root as HTMLElement & { _touchHandlers?: { onTouchStart: (e: TouchEvent) => void; onTouchMove: (e: TouchEvent) => void; onTouchEnd: (e: TouchEvent) => void } })._touchHandlers;
      if (th) {
        plot.root.removeEventListener('touchstart', th.onTouchStart);
        plot.root.removeEventListener('touchmove', th.onTouchMove);
        plot.root.removeEventListener('touchend', th.onTouchEnd);
      }
      const legendClickHandler = (plot.root as HTMLElement & { _legendClickHandler?: (e: MouseEvent) => void })._legendClickHandler;
      if (legendClickHandler) {
        plot.root.removeEventListener('click', legendClickHandler, true);
      }
      resizeObserver.disconnect();
      resizeObserverRef.current = null;
      if (hoverTooltip) hoverTooltip.hidden = true;
      plot.destroy();
      if (plotRef.current === plot) {
        plotRef.current = null;
      }
    };
  }, [currentKey, sampleInterval]);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;

    if (!running) {
      xModeRef.current = 'manual';
    }

    const effectiveChannels = effectiveChannelsRef.current;
    const channelNos = channelOrderRef.current;
    const externalData = alignedInputRef.current;
    const externalSeries = seriesInputRef.current;
    if (windowSeconds != null) {
      xSpanRef.current = Math.max(windowSeconds, sampleInterval);
    }
    if (externalData != null && externalSeries != null) {
      alignedDataRef.current = normalizeAlignedDataForSeries(externalData, externalSeries.length);
    } else {
      alignedDataRef.current = buildAlignedData(channelNos, effectiveChannels, sampleInterval, sampleOffsetsRef.current);
      renderedCountsRef.current = new Map(channelNos.map((chNo) => [chNo, effectiveChannels.get(chNo)?.length ?? 0]));
    }

    const nextData = alignedDataRef.current;
    const nextXData = nextData[0];

    syncingScalesRef.current = true;
    plot.batch(() => {
      plot.setData(nextData, false);
      applyStoredSeriesVisibility(plot);

      if (externalData != null && xRangeRef.current) {
        plot.setScale('x', xRangeRef.current);
      } else if (nextXData.length > 0 && xModeRef.current !== 'manual') {
        moveToLatestView(plot);
      }

      if (yModeRef.current === 'auto') {
        applyAutoY(plot);
      }
    });
    syncingScalesRef.current = false;
  }, [channels, alignedData, running, sampleInterval, sampleOffsets, windowSeconds, xRange]);

  useEffect(() => {
    if (resetViewSignal == null || resetViewSignal <= 0) return;
    const plot = plotRef.current;
    if (!plot) return;

    xModeRef.current = 'following';
    yModeRef.current = 'auto';
    autoYRangeRef.current = null;

    syncingScalesRef.current = true;
    plot.batch(() => {
      if (xRangeRef.current) {
        plot.setScale('x', xRangeRef.current);
      } else {
        moveToLatestView(plot);
      }
      applyAutoY(plot);
    });
    syncingScalesRef.current = false;
  }, [resetViewSignal]);

  return (
    <div className="border border-slate-700 rounded bg-slate-900 h-full relative overflow-hidden">
      <div ref={containerRef} className="relative w-full h-full">
        <div
          ref={hoverTooltipRef}
          data-testid="osc-hover-tooltip"
          hidden
          className="pointer-events-none absolute z-20 min-w-[150px] rounded border border-slate-600 bg-slate-950/95 px-2.5 py-2 text-xs shadow-lg"
        />
      </div>
    </div>
  );
}
