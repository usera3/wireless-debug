import { useRef, useState } from 'react';
import { useModbusOscStore } from '../store/modbusOscStore';
import { useParamStore } from '../store/paramStore';
import { useConnectionStore } from '../store/connectionStore';
import { useOscStore } from '../store/oscStore';
import { useModbusOscController } from '../hooks/useModbusOscController';
import { OscChart } from './OscChart';
import { useMemo } from 'react';
import { exportCsv, importCsv } from '../lib/csvWave';

export function ModbusOscPage() {
  const { running, interval, selectedPage, readChunkSize, waveData, setInterval, setSelectedPage, setReadChunkSize, pushSamples, clearWaveData } =
    useModbusOscStore();
  const pages = useParamStore((s) => s.pages);
  const params = useParamStore((s) => s.params);
  const connected = useConnectionStore((s) => s.connected);
  const oscRunning = useOscStore((s) => s.running);
  const { start, stop } = useModbusOscController();

  const [csvError, setCsvError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const pageParams = params.filter((p) => p.page === selectedPage);

  // 将 alias->[] 的 Map 转换为 OscChart 所需的 Map<number, number[]>
  // 用参数在页内的顺序作为通道号 key（1-based）
  const { chartChannels, chartLabels } = useMemo(() => {
    const channels = new Map<number, number[]>();
    const labels = new Map<number, string>();
    pageParams.forEach((p, i) => {
      const chNo = i + 1;
      channels.set(chNo, waveData.get(p.alias) ?? []);
      labels.set(chNo, p.alias);
    });
    return { chartChannels: channels, chartLabels: labels };
  }, [pageParams, waveData]);

  const canStart = connected && !oscRunning && selectedPage !== '' && !running;

  function handleExport() {
    if (waveData.size === 0) return;
    const aliases = Array.from(waveData.keys());
    const columns = aliases.map((a) => waveData.get(a) ?? []);
    const sampleIntervalSec = interval > 0 ? interval / 1000 : 1;
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
    exportCsv(aliases, columns, sampleIntervalSec, `modbus_osc_${stamp}.csv`);
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setCsvError(null);
    try {
      const { labels, columns } = await importCsv(file);
      clearWaveData();
      // 逐列用 alias 写入 store
      const batch: Record<string, number> = {};
      const maxLen = columns.reduce((m, c) => Math.max(m, c.length), 0);
      for (let i = 0; i < maxLen; i++) {
        const row: Record<string, number> = {};
        labels.forEach((alias, ci) => {
          if (i < columns[ci].length) row[alias] = columns[ci][i];
        });
        pushSamples(row);
      }
    } catch (err) {
      setCsvError((err as Error).message);
      setTimeout(() => setCsvError(null), 4000);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 h-full">
      {/* 控制栏 */}
      <div className="bg-slate-800 rounded-lg p-3 border border-slate-700 flex flex-wrap items-center gap-3">
        {/* 参数页选择 */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400 whitespace-nowrap">参数页</label>
          {pages.length === 0 ? (
            <span className="text-xs text-slate-500 italic">请先在「参数编辑」页加载参数表</span>
          ) : (
            <select
              value={selectedPage}
              onChange={(e) => setSelectedPage(e.target.value)}
              disabled={running}
              className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-slate-100 text-xs disabled:opacity-50"
            >
              <option value="">-- 选择页 --</option>
              {pages.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* 轮询间隔 */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400 whitespace-nowrap">间隔 (ms)</label>
          <input
            type="number"
            min={100}
            step={100}
            value={interval}
            onChange={(e) => setInterval(Number(e.target.value))}
            disabled={running}
            className="w-20 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-slate-100 text-xs disabled:opacity-50"
          />
        </div>

        {/* 分组大小 */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400 whitespace-nowrap">分组大小</label>
          <input
            type="number"
            min={0}
            step={1}
            value={readChunkSize}
            onChange={(e) => setReadChunkSize(Number(e.target.value))}
            disabled={running}
            className="w-16 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-slate-100 text-xs disabled:opacity-50"
            placeholder="0"
          />
        </div>

        {/* 开始 / 停止 */}
        <button
          onClick={start}
          disabled={!canStart}
          className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed
                     text-white rounded text-sm font-medium transition-colors"
        >
          ▶ 开始
        </button>
        <button
          onClick={stop}
          disabled={!running}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed
                     text-white rounded text-sm font-medium transition-colors"
        >
          ■ 停止
        </button>

        {/* 导出 CSV */}
        <button
          onClick={handleExport}
          disabled={running || waveData.size === 0}
          className="px-4 py-2 bg-slate-600 hover:bg-slate-500 disabled:opacity-40 disabled:cursor-not-allowed
                     text-white rounded text-sm font-medium transition-colors"
        >
          ⬇ 导出 CSV
        </button>

        {/* 导入 CSV */}
        <button
          onClick={() => importRef.current?.click()}
          disabled={running}
          className="px-4 py-2 bg-slate-600 hover:bg-slate-500 disabled:opacity-40 disabled:cursor-not-allowed
                     text-white rounded text-sm font-medium transition-colors"
        >
          ⬆ 导入 CSV
        </button>
        <input ref={importRef} type="file" accept=".csv" className="hidden" onChange={handleImport} />

        {/* 状态 */}
        <div className="ml-auto flex items-center gap-4 text-xs text-slate-400">
          {csvError && <span className="text-red-400">❌ {csvError}</span>}
          {oscRunning && (
            <span className="text-amber-400">⚠️ 地址示波器运行中，请先停止</span>
          )}
          <span>
            状态:{' '}
            <span className={running ? 'text-green-400' : 'text-slate-500'}>
              {running ? '运行中' : '已停止'}
            </span>
          </span>
          {selectedPage && (
            <span>
              {selectedPage} · {pageParams.length} 个参数
            </span>
          )}
        </div>
      </div>

      {/* 波形图区 */}
      <div className="flex-1 min-h-0">
        <OscChart
          channels={chartChannels}
          sampleInterval={interval > 0 ? interval / 1000 : 1}
          running={running}
          labels={chartLabels}
        />
      </div>
    </div>
  );
}