const MAX_AXIS_DECIMALS = 12;

export function oscAxisPrecision(increment: number): number {
  const step = Math.abs(increment);
  if (!Number.isFinite(step) || step <= 0) return 6;

  const exponent = Math.floor(Math.log10(step));
  return Math.min(MAX_AXIS_DECIMALS, Math.max(0, -exponent));
}

export function formatOscAxisValue(value: number, increment: number): string {
  if (!Number.isFinite(value)) return '';
  return value.toFixed(oscAxisPrecision(increment));
}

export function formatOscHoverTime(value: number, sampleInterval: number): string {
  if (!Number.isFinite(value)) return '--';
  const precision = Math.max(6, oscAxisPrecision(sampleInterval));
  return `${value.toFixed(Math.min(MAX_AXIS_DECIMALS, precision))} s`;
}

export function formatOscValue(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '--';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value);
}
