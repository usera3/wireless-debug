interface GaugeChartProps {
  value: number;
  min: number;
  max: number;
  unit?: string;
  label?: string;
  size?: number;
  targetValue?: number;
  showTargetMarker?: boolean;
}

export function GaugeChart({
  value,
  min,
  max,
  unit = '',
  label = '',
  size = 200,
  targetValue,
  showTargetMarker = false,
}: GaugeChartProps) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.36;
  const strokeW = size * 0.07;
  const tickInnerR = r - strokeW * 0.9;
  const tickOuterR = r + strokeW * 0.28;
  const labelR = r + strokeW * 0.9;
  const markerTipR = r + strokeW * 0.42;
  const markerBaseR = r + strokeW * 0.78;

  // 仪表盘圆弧：从 -210° 到 30°，共 240°
  const startAngleDeg = -210;
  const endAngleDeg = 30;
  const totalDeg = endAngleDeg - startAngleDeg;

  const isBidirectional = min < 0;
  const span = max - min;

  function clamp(val: number) {
    return Math.min(Math.max(val, min), max);
  }

  function valueToAngle(val: number) {
    if (span === 0) return startAngleDeg;
    return startAngleDeg + ((clamp(val) - min) / span) * totalDeg;
  }

  function polarToCartesian(angleDeg: number, radius = r) {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
  }

  function arcPath(fromDeg: number, toDeg: number) {
    const start = polarToCartesian(fromDeg);
    const end = polarToCartesian(toDeg);
    const largeArc = toDeg - fromDeg > 180 ? 1 : 0;
    return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
  }

  function trianglePath(angleDeg: number) {
    const tip = polarToCartesian(angleDeg, markerTipR);
    const left = polarToCartesian(angleDeg - 4, markerBaseR);
    const right = polarToCartesian(angleDeg + 4, markerBaseR);
    return `M ${tip.x} ${tip.y} L ${left.x} ${left.y} L ${right.x} ${right.y} Z`;
  }

  const trackPath = arcPath(startAngleDeg, endAngleDeg);

  const clamped = clamp(value);

  let fillPathPositive = '';
  let fillPathNegative = '';
  let fillPath = '';

  if (isBidirectional) {
    const zeroAngle = valueToAngle(0);
    const valueAngle = valueToAngle(clamped);

    if (clamped > 0) {
      if (valueAngle - zeroAngle > 0.5) fillPathPositive = arcPath(zeroAngle, valueAngle);
    } else if (clamped < 0) {
      if (zeroAngle - valueAngle > 0.5) fillPathNegative = arcPath(valueAngle, zeroAngle);
    }
  } else {
    const valueAngle = valueToAngle(clamped);
    if (valueAngle - startAngleDeg > 0.5) fillPath = arcPath(startAngleDeg, valueAngle);
  }

  const tickCount = isBidirectional ? 8 : 5;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const angle = startAngleDeg + (i / tickCount) * totalDeg;
    return {
      inner: polarToCartesian(angle, tickInnerR),
      outer: polarToCartesian(angle, tickOuterR),
    };
  });

  const displayValue = Number.isFinite(value)
    ? Number.isInteger(value) ? value.toString() : value.toFixed(1)
    : '--';
  const fontSize = size * 0.16;
  const unitFontSize = size * 0.09;
  const labelFontSize = size * 0.08;

  const zeroAngleForLabel = isBidirectional ? valueToAngle(0) : null;
  const startLabelPos = polarToCartesian(startAngleDeg, labelR);
  const endLabelPos = polarToCartesian(endAngleDeg, labelR);
  const zeroLabelPos = zeroAngleForLabel !== null ? polarToCartesian(zeroAngleForLabel, labelR) : null;
  const targetAngle = showTargetMarker && targetValue !== undefined ? valueToAngle(targetValue) : null;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block overflow-visible">
      {/* 背景轨道 */}
      <path d={trackPath} fill="none" stroke="#1e293b" strokeWidth={strokeW} strokeLinecap="round" />

      {/* 单向填充 */}
      {fillPath && (
        <path d={fillPath} fill="none" stroke="#3b82f6" strokeWidth={strokeW} strokeLinecap="round" />
      )}

      {/* 双向：正转（蓝色） */}
      {fillPathPositive && (
        <path d={fillPathPositive} fill="none" stroke="#3b82f6" strokeWidth={strokeW} strokeLinecap="round" />
      )}
      {/* 双向：反转（橙色） */}
      {fillPathNegative && (
        <path d={fillPathNegative} fill="none" stroke="#f97316" strokeWidth={strokeW} strokeLinecap="round" />
      )}

      {/* 刻度线 */}
      {ticks.map((t, i) => (
        <line
          key={i}
          x1={t.inner.x}
          y1={t.inner.y}
          x2={t.outer.x}
          y2={t.outer.y}
          stroke="#475569"
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      ))}

      {/* 设定值游标 */}
      {targetAngle !== null && <path d={trianglePath(targetAngle)} fill="#fbbf24" stroke="#0f172a" strokeWidth={1} />}

      {/* 双向模式：0 刻度标注 */}
      {zeroLabelPos && (
        <text
          x={zeroLabelPos.x}
          y={zeroLabelPos.y}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={size * 0.07}
          fill="#94a3b8"
        >
          0
        </text>
      )}

      {/* 中间数值 */}
      <text
        x={cx}
        y={cy - size * 0.02}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={fontSize}
        fontWeight="700"
        fill={isBidirectional && clamped < 0 ? '#fb923c' : '#f1f5f9'}
        fontFamily="ui-monospace, monospace"
      >
        {displayValue}
      </text>

      {/* 单位 */}
      {unit && (
        <text
          x={cx}
          y={cy + fontSize * 0.62}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={unitFontSize}
          fill="#94a3b8"
        >
          {unit}
        </text>
      )}

      {/* 标签 */}
      {label && (
        <text
          x={cx}
          y={size * 0.88}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={labelFontSize}
          fill="#64748b"
        >
          {label}
        </text>
      )}

      {/* min / max 标注 */}
      <text x={startLabelPos.x} y={startLabelPos.y} textAnchor="middle" dominantBaseline="middle" fontSize={size * 0.07} fill="#475569">
        {min}
      </text>
      <text x={endLabelPos.x} y={endLabelPos.y} textAnchor="middle" dominantBaseline="middle" fontSize={size * 0.07} fill="#475569">
        {max}
      </text>
    </svg>
  );
}