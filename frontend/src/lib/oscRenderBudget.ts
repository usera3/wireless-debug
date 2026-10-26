const MAX_POINTS_PER_SERIES = 2400;
const MIN_POINTS_PER_SERIES = 512;
const TARGET_TOTAL_POINTS = 4800;

export function oscPlotPointBudget(seriesCount: number): number {
  const count = Number.isFinite(seriesCount) && seriesCount > 0
    ? Math.floor(seriesCount)
    : 1;
  return Math.max(
    MIN_POINTS_PER_SERIES,
    Math.min(MAX_POINTS_PER_SERIES, Math.floor(TARGET_TOTAL_POINTS / count)),
  );
}
