import { useOscStore } from '../store/oscStore';
import { useConnectionStore } from '../store/connectionStore';
import { OscChannelConfig, buildChannelConfigs } from './OscChannelConfig';
import { OscChart } from './OscChart';
import { useOscController } from '../hooks/useOscController';

export function OscilloscoperPage() {
  const { running, sampleRate, frameLen, waveData, configRows, numChannels, setChannels } = useOscStore();
  const connected = useConnectionStore((s) => s.connected);
  const { start, stop } = useOscController();

  function handleStart() {
    const channels = buildChannelConfigs(configRows, numChannels);
    setChannels(channels);
    start();
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
          disabled={!connected || running}
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

        {/* 状态栏 */}
        <div className="ml-auto flex items-center gap-4 text-xs text-slate-400">
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
        <OscChart channels={waveData} sampleRate={sampleRate} />
      </div>
    </div>
  );
}