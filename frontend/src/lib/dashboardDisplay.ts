export interface DashboardPoint { receivedAt: number; value: number | null }

/** Unit prefixes are additional to the register's decimal scale. */
export function dashboardScale(unit?: string, decimals = 0) {
  const precision = Number.isFinite(decimals) ? Math.min(10, Math.max(0, Math.trunc(decimals))) : 0;
  const trimmed = unit?.trim() || '';
  const match = trimmed.match(/^([+]?(?:\d+(?:\.\d+)?|\.\d+))(.*)$/);
  const factor = match ? Number(match[1]) : 1;
  if (!match || !Number.isFinite(factor) || factor <= 0) {
    return { factor: 1, decimals: precision, unit: trimmed };
  }
  return {
    factor,
    decimals: Math.min(10, precision + (match[1].split('.')[1]?.length || 0)),
    unit: match[2].trim(),
  };
}

/** Geometry uses browser receive timestamps; nulls are explicit acquisition gaps. */
export function buildDashboardTrend(points: DashboardPoint[], now: number, factor: number) {
  const visible = points.filter(point => point.receivedAt >= now - 60_000 && point.receivedAt <= now);
  const values = visible.filter(point => point.value !== null && Number.isFinite(point.value)).map(point => point.value! * factor);
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 1;
  const padding = Math.max((high - low) * .15, Math.abs(high) * .02, 1);
  const min = low - padding;
  const max = high + padding;
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let segment: Array<{ x: number; y: number }> | null = null;
  for (const point of visible) {
    if (point.value === null || !Number.isFinite(point.value)) { segment = null; continue; }
    if (!segment) { segment = []; segments.push(segment); }
    segment.push({ x: 56 + (point.receivedAt - (now - 60_000)) / 100, y: 220 - (point.value * factor - min) / (max - min) * 200 });
  }
  return { segments, min, max };
}
