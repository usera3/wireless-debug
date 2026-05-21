import { useRef, useState } from 'react';
import { useOscStore } from '../store/oscStore';
import { useConnectionStore } from '../store/connectionStore';
import { useModbusOscStore } from '../store/modbusOscStore';
import { OscChannelConfig, buildChannelConfigs } from './OscChannelConfig';
import { OscChart } from './OscChart';
import { useOscController } from '../hooks/useOscController';
import { exportCsv, importCsv } from '../lib/csvWave';

export function OscilloscoperPage() {
  const { running, sampleRate, frameLen, waveData, channels, configRows, numChannels, setChannels, batchPushSamples, clearWaveData, setSampleRate } = useOscStore();
  const connected = useConnectionStore((s) => s.connected);
  const modbusOscRunning = useModbusOscStore((s) => s.running);
  const { start, stop } = useOscController();

  const [csvError, setCsvError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  function handleStart() {
    const chs = buildChannelConfigs(configRows, numChannels);
    setChannels(chs);
    start(chs);
  }

  function handleExport() {
    if (waveData.size === 0) return;
    const chNos = Array.from(waveData.keys()).sort((a, b) => a - b);
    const labels = chNos.map((no) => {
      const ch = channels.find((c) => c.channelNo === no);
      return ch?.label ?? `CH${no}`;
    });
    const columns = chNos.map((no) => waveData.get(no) ?? []);
    const sampleIntervalSec = sampleRate > 0 ? 1 / sampleRate : 1;
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
    exportCsv(labels, columns, sampleIntervalSec, `osc_${stamp}.csv`);
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setCsvError(null);
    try {
      const { labels, columns, sampleIntervalSec } = await importCsv(file);
      clearWaveData();
      // 按列重建通道号（1-based）
      const batch = new Map<number, number[]>();
      labels.forEach((_, i) => batch.set(i + 1, columns[i]));
      batchPushSamples(batch);
      // 更新采样率（若能推断）
      if (sampleIntervalSec && sampleIntervalSec > 0) {
        setSampleRate(Math.round(1 / sampleIntervalSec));
      }
    } catch (err) {
      setCsvError((err as Error).message);
      setTimeout(() => setCsvError(null), 4000);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 h-full">
      {/* 通道配置区 */}
      <div className="bg-slate-800 rounded-lg p-3 border border-slate-700">
        <OscChannelConfig />
      </div>

      {/* 控制栏 */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={handleStart}
          disabled={!connected || running || modbusOscRunning}
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

        {/* 状态栏 */}
        <div className="ml-auto flex items-center gap-4 text-xs text-slate-400">
          {csvError && <span className="text-red-400">❌ {csvError}</span>}
          {modbusOscRunning && (
            <span className="text-amber-400">⚠️ 参数示波器运行中，请先停止</span>
          )}
          <span>
            状态:{' '}
            <span className={running ? 'text-green-400' : 'text-slate-500'}>
              {running ? '运行中' : '已停止'}
            </span>
          </span>
          <span>采样率: {sampleRate} Hz</span>
          <span>帧长: {frameLen} B</span>
        </div>
      </div>

      {/* 波形图区 */}
      <div className="flex-1 min-h-0">
        <OscChart
          channels={waveData}
          sampleInterval={sampleRate > 0 ? 1 / sampleRate : 1}
          running={running}
        />
      </div>
    </div>
  );
}