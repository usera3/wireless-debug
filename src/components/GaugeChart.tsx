interface GaugeChartProps {
  value: number;
  min: number;
  max: number;
  unit?: string;
  label?: string;
  size?: number;
}

export function GaugeChart({ value, min, max, unit = '', label = '', size = 200 }: GaugeChartProps) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.38;
  const strokeW = size * 0.07;

  // 仪表盘圆弧：从 -210° 到 30°，共 240°
  const startAngleDeg = -210;
  const endAngleDeg = 30;
  const totalDeg = endAngleDeg - startAngleDeg; // 240

  const isBidirectional = min < 0;

  function polarToCartesian(angleDeg: number) {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function arcPath(fromDeg: number, toDeg: number) {
    const start = polarToCartesian(fromDeg);
    const end = polarToCartesian(toDeg);
    const largeArc = toDeg - fromDeg > 180 ? 1 : 0;
    return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
  }

  const trackPath = arcPath(startAngleDeg, endAngleDeg);

  // --- 双向模式 ---
  // 0 点角度：按 min~max 映射，0 居中时角度在弧中间
  const clamped = Math.min(Math.max(value, min), max);

  let fillPathPositive = '';
  let fillPathNegative = '';
  let fillPath = '';   // 单向模式用

  if (isBidirectional) {
    const span = max - min; // e.g. -6000~6000 => 12000
    const zeroRatio = (0 - min) / span;           // 0 在 [min,max] 的比例位置
    const zeroAngle = startAngleDeg + zeroRatio * totalDeg;  // 0 对应的角度
    const valueRatio = (clamped - min) / span;
    const valueAngle = startAngleDeg + valueRatio * totalDeg;

    if (clamped > 0) {
      // 从 0 到 value，顺时针（正转，蓝色）
      if (valueAngle - zeroAngle > 0.5)
        fillPathPositive = arcPath(zeroAngle, valueAngle);
    } else if (clamped < 0) {
      // 从 value 到 0，顺时针（反转弧从左画到0，橙色）
      if (zeroAngle - valueAngle > 0.5)
        fillPathNegative = arcPath(valueAngle, zeroAngle);
    }
  } else {
    // 单向模式（原逻辑）
    const ratio = max === min ? 0 : (clamped - min) / (max - min);
    const fillDeg = ratio * totalDeg;
    if (fillDeg > 0.5) fillPath = arcPath(startAngleDeg, startAngleDeg + fillDeg);
  }

  // 刻度线
  const tickCount = isBidirectional ? 8 : 5;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const angle = startAngleDeg + (i / tickCount) * totalDeg;
    const inner = {
      x: cx + (r - strokeW * 0.7) * Math.cos((angle * Math.PI) / 180),
      y: cy + (r - strokeW * 0.7) * Math.sin((angle * Math.PI) / 180),
    };
    const outer = {
      x: cx + (r + strokeW * 0.15) * Math.cos((angle * Math.PI) / 180),
      y: cy + (r + strokeW * 0.15) * Math.sin((angle * Math.PI) / 180),
    };
    return { inner, outer };
  });

  const displayValue = Number.isFinite(value)
    ? Number.isInteger(value) ? value.toString() : value.toFixed(1)
    : '--';
  const fontSize = size * 0.16;
  const unitFontSize = size * 0.09;
  const labelFontSize = size * 0.08;

  // 双向模式：显示 min 和 max，中间刻度显示 0
  const zeroRatioForLabel = isBidirectional ? (0 - min) / (max - min) : null;
  const zeroAngleForLabel = zeroRatioForLabel !== null
    ? startAngleDeg + zeroRatioForLabel * totalDeg
    : null;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block">
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
          x1={t.inner.x} y1={t.inner.y}
          x2={t.outer.x} y2={t.outer.y}
          stroke="#475569" strokeWidth={1.5}
        />
      ))}

      {/* 双向模式：0 刻度标注 */}
      {zeroAngleForLabel !== null && (
        <text
          x={polarToCartesian(zeroAngleForLabel).x}
          y={polarToCartesian(zeroAngleForLabel).y - size * 0.06}
          textAnchor="middle"
          fontSize={size * 0.07}
          fill="#94a3b8"
        >
          0
        </text>
      )}

      {/* 中间数值 */}
      <text
        x={cx} y={cy - size * 0.02}
        textAnchor="middle" dominantBaseline="middle"
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
          x={cx} y={cy + fontSize * 0.62}
          textAnchor="middle" dominantBaseline="middle"
          fontSize={unitFontSize}
          fill="#94a3b8"
        >
          {unit}
        </text>
      )}

      {/* 标签 */}
      {label && (
        <text
          x={cx} y={size * 0.88}
          textAnchor="middle" dominantBaseline="middle"
          fontSize={labelFontSize}
          fill="#64748b"
        >
          {label}
        </text>
      )}

      {/* min / max 标注 */}
      <text
        x={polarToCartesian(startAngleDeg).x}
        y={polarToCartesian(startAngleDeg).y + size * 0.04}
        textAnchor="middle" fontSize={size * 0.07} fill="#475569"
      >
        {min}
      </text>
      <text
        x={polarToCartesian(endAngleDeg).x}
        y={polarToCartesian(endAngleDeg).y + size * 0.04}
        textAnchor="middle" fontSize={size * 0.07} fill="#475569"
      >
        {max}
      </text>
    </svg>
  );
}