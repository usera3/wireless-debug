import { buildDashboardTrend, type DashboardPoint } from '../lib/dashboardDisplay';

export function DashboardTrend({ points, now, factor, unit }: {
  points: DashboardPoint[]; now: number; factor: number; unit: string;
}) {
  const { segments, min, max } = buildDashboardTrend(points, now, factor);
  return (
    <section className="wd-dashboard-trend" aria-label="转速趋势">
      <div className="wd-card-heading"><h2>转速趋势</h2><span>最近 60 秒</span></div>
      <div className="wd-trend-plot">
        <svg viewBox="0 0 680 256" role="img" aria-label="最近60秒实际转速趋势" data-testid="dashboard-trend">
          {[0, 1, 2, 3, 4].map(index => <g key={index}>
            <line x1="56" x2="656" y1={20 + index * 50} y2={20 + index * 50} className="wd-trend-grid" />
            {segments.length > 0 && <text x="46" y={24 + index * 50} textAnchor="end">{(max - (max - min) * index / 4).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}</text>}
          </g>)}
          {[60, 45, 30, 15, 0].map(seconds => <text key={seconds} x={656 - seconds * 10} y="248" textAnchor={seconds === 60 ? 'start' : seconds === 0 ? 'end' : 'middle'}>{seconds ? `−${seconds}s` : '现在'}</text>)}
          <text x="56" y="12">{unit}</text>
          {segments.map((segment, index) => <g key={index}>
            <path d={segment.map((point, pointIndex) => `${pointIndex ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')} className="wd-trend-line" />
            {segment.length === 1 && <circle cx={segment[0].x} cy={segment[0].y} r="2.5" fill="#117d99" />}
          </g>)}
        </svg>
        {segments.length === 0 && <span className="wd-trend-empty">暂无采样</span>}
      </div>
    </section>
  );
}
