import { useEffect, useRef } from 'react';
import { useDebugStore } from '../store/debugStore';

export function DebugPage() {
  const { entries, paused, clear, setPaused } = useDebugStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部（暂停时不滚）
  useEffect(() => {
    if (!paused) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [entries, paused]);

  return (
    <div className="flex flex-col h-full p-4 gap-3">
      {/* 工具栏 */}
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-sm font-semibold text-slate-300">WS 收发日志</span>
        <span className="text-xs text-slate-500">{entries.length} 条</span>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => setPaused(!paused)}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              paused
                ? 'bg-yellow-600 hover:bg-yellow-500 text-white'
                : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
            }`}
          >
            {paused ? '▶ 继续' : '⏸ 暂停'}
          </button>
          <button
            onClick={clear}
            className="px-3 py-1.5 rounded text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
          >
            🗑 清空
          </button>
        </div>
      </div>

      {/* 日志列表 */}
      <div className="flex-1 overflow-y-auto font-mono text-xs bg-slate-950 rounded border border-slate-700 p-2 space-y-0.5">
        {entries.length === 0 && (
          <div className="text-slate-600 text-center py-8">暂无数据，等待 WS 通信…</div>
        )}
        {entries.map((e) => (
          <div
            key={e.id}
            className={`flex gap-3 items-baseline px-1 py-0.5 rounded ${
              e.dir === 'tx'
                ? 'text-blue-300 hover:bg-blue-950/40'
                : 'text-green-300 hover:bg-green-950/40'
            }`}
          >
            {/* 时间戳 */}
            <span className="shrink-0 text-slate-600 w-20 text-right">
              {new Date(e.ts).toLocaleTimeString('zh', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              .{String(e.ts % 1000).padStart(3, '0')}
            </span>
            {/* 方向 */}
            <span className={`shrink-0 font-bold w-5 ${e.dir === 'tx' ? 'text-blue-400' : 'text-green-400'}`}>
              {e.dir === 'tx' ? '→' : '←'}
            </span>
            {/* 可读描述 */}
            <span className="shrink-0 w-64 truncate" title={e.desc}>{e.desc}</span>
            {/* hex */}
            <span className="text-slate-500 truncate" title={e.hex}>{e.hex}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
