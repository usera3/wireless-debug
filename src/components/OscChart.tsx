// ⚠️ ChartGPU 集成暂缓，待库 API 确认后实现
// 当前版本：显示各通道最新采样值 + 累计帧数计数

interface OscChartProps {
  channels: Map<number, number[]>;
  sampleRate: number;
}

export function OscChart({ channels, sampleRate }: OscChartProps) {
  if (channels.size === 0) {
    return (
      <div className="border border-slate-700 rounded p-4 bg-slate-900 text-slate-500 text-sm text-center">
        暂无波形数据，请先配置通道并开始采样
      </div>
    );
  }

  return (
    <div className="border border-slate-700 rounded p-4 bg-slate-900 font-mono text-sm space-y-1">
      <p className="text-slate-500 mb-2 text-xs">
        ⚠ 波形渲染占位（ChartGPU 待集成） · 采样率 {sampleRate} Hz
      </p>
      {Array.from(channels.entries()).map(([ch, data]) => {
        const latest = data[data.length - 1];
        const min = data.length ? Math.min(...data.slice(-200)) : 0;
        const max = data.length ? Math.max(...data.slice(-200)) : 0;
        return (
          <div key={ch} className="flex items-center gap-4 text-green-400">
            <span className="w-12 text-slate-400">CH{ch}</span>
            <span className="w-32">{data.length} 点</span>
            <span className="w-28">最新: {latest?.toFixed(2) ?? '--'}</span>
            <span className="text-slate-500 text-xs">
              [{min.toFixed(2)}, {max.toFixed(2)}]
            </span>
          </div>
        );
      })}
    </div>
  );
}
