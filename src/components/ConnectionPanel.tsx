import { useState, useRef } from 'react';
import { useConnectionStore } from '../store/connectionStore';
import { BaudPicker } from './BaudPicker';
import { useBootloaderStore } from '../store/bootloaderStore';

export function ConnectionPanel() {
  const { url, connected, connecting, setUrl, connect, disconnect } = useConnectionStore();
  const [showBaudPicker, setShowBaudPicker] = useState(false);
  const { guiConfig, loadGuiConfig, exportGuiConfig, applyGuiConfigText } = useBootloaderStore();
  const configInputRef = useRef<HTMLInputElement>(null);

  const [editingJson, setEditingJson] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  function openJsonEditor() {
    setJsonText(JSON.stringify(guiConfig, null, 2));
    setJsonError(null);
    setEditingJson(true);
  }

  function applyJson() {
    try {
      applyGuiConfigText(jsonText);
      setEditingJson(false);
      setJsonError(null);
    } catch (e) {
      setJsonError((e as Error).message);
    }
  }

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

        <div>
          <h3 className="text-sm font-semibold text-slate-300 mb-2">WiFi 配网</h3>
          <a
            href="/wifi.html"
            className="inline-flex items-center px-3 py-2 rounded text-sm font-medium bg-slate-600 hover:bg-slate-500 text-white transition-colors"
          >
            打开网页配网
          </a>
        </div>

        {/* 烧录配置 */}
        <div>
          <h3 className="text-sm font-semibold text-slate-300 mb-2">烧录配置</h3>
          <p className="text-xs text-slate-500 mb-2">
            当前目标：{guiConfig.targets.map((t) => t.displayName).join(' / ')}
          </p>
          <div className="flex gap-2 flex-wrap">
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
            <button
              onClick={editingJson ? () => setEditingJson(false) : openJsonEditor}
              className="px-3 py-1.5 rounded text-xs font-medium bg-slate-600 hover:bg-slate-500 text-white transition-colors"
            >
              {editingJson ? '收起' : '编辑 JSON'}
            </button>
          </div>

          {/* JSON 编辑区 */}
          {editingJson && (
            <div className="mt-3 space-y-2">
              <textarea
                value={jsonText}
                onChange={(e) => { setJsonText(e.target.value); setJsonError(null); }}
                className="w-full h-72 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-slate-200
                           text-xs font-mono resize-y focus:outline-none focus:border-blue-500"
                spellCheck={false}
              />
              {jsonError && (
                <p className="text-xs text-red-400">❌ {jsonError}</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={applyJson}
                  className="px-3 py-1.5 rounded text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                >
                  应用
                </button>
                <button
                  onClick={() => setEditingJson(false)}
                  className="px-3 py-1.5 rounded text-xs font-medium bg-slate-600 hover:bg-slate-500 text-white transition-colors"
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {showBaudPicker && <BaudPicker onClose={() => setShowBaudPicker(false)} />}
    </div>
  );
}
