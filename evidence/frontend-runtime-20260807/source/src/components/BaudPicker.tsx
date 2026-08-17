import { useEffect, useState } from 'react';
import { apiJson, apiPostJson } from '../lib/apiClient';

interface Props {
  onClose: () => void;
}

type StatusCls = '' | 'ok' | 'err' | 'ing';

const BAUD_PRESETS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 2000000];
const BAUD_LS_KEY = 'esp32_uart_baud';

export function BaudPicker({ onClose }: Props) {
  const [currentBaud, setCurrentBaud] = useState<number | null>(() => {
    const cached = parseInt(localStorage.getItem(BAUD_LS_KEY) ?? '');
    return isNaN(cached) ? null : cached;
  });
  const [selectedBaud, setSelectedBaud] = useState<number | null>(null);
  const [customValue, setCustomValue] = useState('');
  const [status, setStatus] = useState<{ msg: string; cls: StatusCls }>({ msg: '', cls: '' });
  const [applying, setApplying] = useState(false);

  function st(msg: string, cls: StatusCls = '') {
    setStatus({ msg, cls });
  }

  /* 弹窗打开时向 ESP32 查询实时波特率 */
  useEffect(() => {
    apiJson<{ baud?: number }>('/api/uart/baud')
      .then((json: { baud?: number }) => {
        if (!json.baud) return;
        setCurrentBaud(json.baud);
        setSelectedBaud(json.baud);
        localStorage.setItem(BAUD_LS_KEY, String(json.baud));
      })
      .catch(() => {
        /* ESP32 不可达，沿用 localStorage 缓存，不报错 */
        if (currentBaud !== null) setSelectedBaud(currentBaud);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function applyBaud() {
    const baud = parseInt(customValue) || selectedBaud;
    if (!baud) { st('⚠️ 请选择或输入波特率', 'err'); return; }
    if (baud < 1200 || baud > 5000000) { st('⚠️ 超出范围，有效值：1200 ~ 5000000', 'err'); return; }

    setApplying(true);
    st(`正在设置 ${baud} bps...`, 'ing');
    try {
      const json = await apiPostJson<{ ok: boolean; baud?: number; msg?: string }>('/api/uart/baud', { baud });
      if (!json.ok) throw new Error(json.msg || '设置失败');

      const newBaud = json.baud ?? baud;
      setCurrentBaud(newBaud);
      setSelectedBaud(newBaud);
      setCustomValue('');
      localStorage.setItem(BAUD_LS_KEY, String(newBaud));
      st(`✅ 已设置为 ${newBaud} bps`, 'ok');
    } catch (e) {
      st(`❌ 设置失败：${(e as Error).message}`, 'err');
    } finally {
      setApplying(false);
    }
  }

  const customRangeErr =
    customValue !== '' &&
    (parseInt(customValue) < 1200 || parseInt(customValue) > 5000000);

  const statusColor =
    status.cls === 'ok' ? 'text-green-400' :
    status.cls === 'err' ? 'text-red-400' :
    status.cls === 'ing' ? 'text-blue-400' :
    'text-slate-400';

  return (
    <div
      className="fixed inset-0 bg-black/65 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-slate-800 border border-slate-600 rounded-2xl p-6 min-w-[340px] max-w-[92vw] shadow-2xl">
        <h3 className="text-base font-semibold text-slate-100 mb-4 pb-2.5 border-b border-slate-700">
          ⚙️ UART1 波特率设置
        </h3>

        <p className="text-xs text-slate-500 mb-3">
          当前波特率：
          <span className="text-blue-400 font-mono font-semibold">
            {currentBaud ?? '查询中...'}
          </span>{' '}
          bps
        </p>

        {/* 预设值网格 */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          {BAUD_PRESETS.map((b) => (
            <button
              key={b}
              onClick={() => { setSelectedBaud(b); setCustomValue(''); st(''); }}
              className={`rounded-lg py-2.5 text-xs font-mono text-center border transition-all
                ${selectedBaud === b && !customValue
                  ? 'bg-indigo-600 border-indigo-600 text-white'
                  : 'bg-slate-700 border-slate-500 text-slate-300 hover:bg-indigo-600 hover:border-indigo-600 hover:text-white'
                }`}
            >
              {b.toLocaleString()}
            </button>
          ))}
        </div>

        {/* 自定义输入 */}
        <div className="flex gap-2 mb-3">
          <input
            type="number"
            value={customValue}
            min={1200}
            max={5000000}
            placeholder="输入任意波特率（1200 ~ 5000000）"
            onChange={(e) => {
              setCustomValue(e.target.value);
              if (e.target.value) setSelectedBaud(null);
              st(
                e.target.value && (parseInt(e.target.value) < 1200 || parseInt(e.target.value) > 5000000)
                  ? '⚠️ 超出范围，有效值：1200 ~ 5000000'
                  : '',
                e.target.value && (parseInt(e.target.value) < 1200 || parseInt(e.target.value) > 5000000)
                  ? 'err'
                  : '',
              );
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') applyBaud(); }}
            className="flex-1 bg-slate-900 border border-slate-500 focus:border-indigo-500 rounded-md px-3 py-1.5
                       text-slate-100 text-sm font-mono outline-none"
          />
        </div>

        {/* 应用按钮 */}
        <button
          onClick={applyBaud}
          disabled={applying || customRangeErr}
          className="w-full bg-indigo-600 hover:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed
                     text-white rounded-lg py-2.5 text-sm transition-opacity"
        >
          ✅ 应用
        </button>

        {/* 底部：状态 + 关闭 */}
        <div className="flex items-center justify-between gap-2 mt-3">
          <span className={`text-xs break-all flex-1 min-h-[18px] ${statusColor}`}>{status.msg}</span>
          <button
            onClick={onClose}
            className="shrink-0 border border-slate-500 text-slate-400 hover:text-slate-100 rounded-md px-3.5 py-1.5 text-xs transition-colors"
          >
            ✕ 关闭
          </button>
        </div>
      </div>
    </div>
  );
}
