import { useState, useRef } from 'react';
import { useConnectionStore } from '../store/connectionStore';
import { BaudPicker } from './BaudPicker';
import { useBootloaderStore } from '../store/bootloaderStore';

export function ConnectionPanel() {
  const { url, connected, connecting, setUrl, connect, disconnect } = useConnectionStore();
  const [showBaudPicker, setShowBaudPicker] = useState(false);
  const { guiConfig, loadGuiConfig, exportGuiConfig } = useBootloaderStore();
  const configInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="p-6 max-w-lg">
      <h2 className="text-lg font-semibold text-slate-100 mb-4">连接设置</h2>

      <div className="space-y-4">
        {/* URL 输入 */}
        <div>
          <label className="block text-sm text-slate-400 mb-1">WebSocket 地址</label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={connected}
            className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-slate-100
                       text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            placeholder="ws://192.168.4.1/ws"
          />
        </div>

        {/* 状态 + 按钮 */}
        <div className="flex items-center gap-4">
          {/* 状态徽标 */}
          <div className="flex items-center gap-2">
            <span
              className={`inline-block w-2.5 h-2.5 rounded-full ${
                connected ? 'bg-green-400' : connecting ? 'bg-yellow-400 animate-pulse' : 'bg-red-500'
              }`}
            />
            <span className="text-sm text-slate-300">
              {connected ? '已连接' : connecting ? '连接中...' : '未连接'}
            </span>
          </div>

          {/* 连接/断开按钮 */}
          <button
            onClick={connected ? disconnect : connect}
            disabled={connecting}
            className={`px-4 py-2 rounded text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              connected
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-blue-600 hover:bg-blue-700 text-white'
            }`}
          >
            {connected ? '断开' : connecting ? '连接中...' : '连接'}
          </button>

          {/* 波特率设置 */}
          <button
            onClick={() => setShowBaudPicker(true)}
            className="px-4 py-2 rounded text-sm font-medium transition-colors bg-slate-600 hover:bg-slate-500 text-white"
          >
            ⚙️ 波特率
          </button>
        </div>

        {/* 说明 */}
        <p className="text-xs text-slate-500">
          ESP32 默认地址：ws://192.168.4.1/ws
        </p>

        {/* 烧录配置 */}
        <div>
          <h3 className="text-sm font-semibold text-slate-300 mb-2">烧录配置</h3>
          <p className="text-xs text-slate-500 mb-2">
            当前目标：{guiConfig.targets.map((t) => t.displayName).join(' / ')}
          </p>
          <div className="flex gap-2">
            <input
              type="file"
              accept=".json"
              className="hidden"
              ref={configInputRef}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) loadGuiConfig(f);
                e.target.value = '';
              }}
            />
            <button
              onClick={() => configInputRef.current?.click()}
              className="px-3 py-1.5 rounded text-xs font-medium bg-slate-600 hover:bg-slate-500 text-white transition-colors"
            >
              导入 gui-config.json
            </button>
            <button
              onClick={exportGuiConfig}
              className="px-3 py-1.5 rounded text-xs font-medium bg-slate-600 hover:bg-slate-500 text-white transition-colors"
            >
              导出
            </button>
          </div>
        </div>
      </div>

      {showBaudPicker && <BaudPicker onClose={() => setShowBaudPicker(false)} />}
    </div>
  );
}