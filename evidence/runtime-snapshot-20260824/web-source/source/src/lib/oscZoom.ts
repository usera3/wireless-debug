export interface PlotRectLike {
  left: number;
  top: number;
}

export interface PlotPosition {
  x: number;
  y: number;
}

/** Convert viewport coordinates to the coordinates expected by uPlot.posToVal(). */
export function getPlotRelativePosition(
  clientX: number,
  clientY: number,
  plotRect: PlotRectLike,
): PlotPosition {
  return {
    x: clientX - plotRect.left,
    y: clientY - plotRect.top,
  };
}

export function zoomRange(
  min: number,
  max: number,
  anchor: number,
  scaleFactor: number,
  minimumSpan: number,
): { min: number; max: number } {
  const span = Math.max(max - min, minimumSpan);
  const nextSpan = Math.max(span * scaleFactor, minimumSpan);
  const ratio = span === 0 ? 0.5 : (anchor - min) / span;
  return {
    min: anchor - nextSpan * ratio,
    max: anchor + nextSpan * (1 - ratio),
  };
}
