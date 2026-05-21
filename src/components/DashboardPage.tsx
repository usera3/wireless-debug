import { useRef, useState } from 'react';
import { useParamStore } from '../store/paramStore';
import { GaugeChart } from './GaugeChart';
import { useDashboardPoller } from '../hooks/useDashboardPoller';
import { EspFilePicker } from './EspFilePicker';
import { parseParameterTable } from '../lib/paramParser';

// 数码管风格的只读显示块
function DigitDisplay({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="flex flex-col items-center bg-slate-800 rounded-lg px-3 py-2 gap-1 min-w-0">
      <span className="text-xs text-slate-500 truncate w-full text-center">{label}</span>
      <span className="font-mono text-lg font-bold text-green-400 tabular-nums leading-tight">
        {value}
      </span>
      {unit && <span className="text-xs text-slate-500">{unit}</span>}
    </div>
  );
}

export function DashboardPage() {
  const params = useParamStore((s) => s.params);
  const values = useParamStore((s) => s.values);
  const loadParams = useParamStore((s) => s.loadParams);
  const setActivePage = useParamStore((s) => s.setActivePage);

  const fileRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [showEspPicker, setShowEspPicker] = useState(false);
  const enabled = useParamStore((s) => s.dashboardEnabled);
  const setDashboardEnabled = useParamStore((s) => s.setDashboardEnabled);

  const { writeParam } = useDashboardPoller(enabled);

  async function loadFile(file: File) {
    setLoading(true);
    try {
      const { params: p, pages: pg } = await parseParameterTable(file);
      loadParams(p, pg);
      setActivePage(pg[0] ?? '');
    } catch (err) {
      console.error('parse failed', err);
    } finally {
      setLoading(false);
    }
  }

  // 从 paramStore 找 ParamDef
  function defOf(alias: string) {
    return params.find((p) => p.alias === alias);
  }

  const cmdSpd = defOf('CmdSpd');
  const cmdTorq = defOf('CmdTorq');

  // 滑动条本地状态（拖动中不写入，松手才写）
  const [spdLocal, setSpdLocal] = useState<number | null>(null);
  const [torqLocal, setTorqLocal] = useState<number | null>(null);
  // 转向开关：1 = 正转，-1 = 反转
  const [direction, setDirection] = useState<1 | -1>(1);

  const spdStore = values['CmdSpd'] ?? cmdSpd?.defaultVal ?? 0;
  const torqStore = values['CmdTorq'] ?? cmdTorq?.defaultVal ?? 0;
  const spdValue = spdLocal !== null ? spdLocal : spdStore;
  const torqValue = torqLocal !== null ? torqLocal : torqStore;

  // CmdMode：1=转速 2=转矩
  const cmdModeRaw = values['CmdMode'];
  const modeValue = cmdModeRaw === 2 ? 2 : 1; // 默认转速

  const motorSpd = values['MotorSpd'];
  // 使用 CmdSpd 的 min/max 作为仪表盘范围，双向时 min 可能为负
  const gaugeMax = cmdSpd?.max ?? 6000;
  const gaugeMin = cmdSpd?.min != null ? -(cmdSpd.min === 0 ? gaugeMax : Math.abs(cmdSpd.min)) : -gaugeMax;

  function formatVal(alias: string): string {
    const v = values[alias];
    if (v === undefined) return '--';
    return String(v);
  }

  function unitOf(alias: string): string | undefined {
    const u = defOf(alias)?.unit;
    return u || undefined;
  }

  return (
    <div className="flex flex-col gap-4 p-4 max-w-md mx-auto">
      {/* 使能开关 */}
      <div className="flex items-center justify-between bg-slate-800 rounded-lg px-4 py-3">
        <span className="text-sm text-slate-300 font-medium">仪表盘使能</span>
        <button
          onClick={() => setDashboardEnabled(!enabled)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            enabled ? 'bg-blue-600' : 'bg-slate-600'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
              enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* 未加载参数表时的提示横幅 */}
      {params.length === 0 && (
        <div className="flex flex-col gap-2 bg-yellow-950/60 border border-yellow-700/60 rounded-lg px-4 py-3">
          <span className="text-sm text-yellow-300 font-medium">⚠️ 参数表未加载，仪表盘功能受限</span>
          <div className="flex gap-2">
            <button
              onClick={() => fileRef.current?.click()}
              disabled={loading}
              className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm transition-colors disabled:opacity-50"
            >
              📂 加载参数表
            </button>
            <button
              onClick={() => setShowEspPicker(true)}
              disabled={loading}
              className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm transition-colors disabled:opacity-50"
            >
              📡 远程加载
            </button>
          </div>
          {loading && <span className="text-xs text-yellow-400">解析中…</span>}
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); }}
      />

      {/* 控制区（使能后才可交互） */}
      <div className={`flex flex-col gap-4${!enabled ? ' pointer-events-none opacity-40 select-none' : ''}`}>

        {/* 控制模式按钮组 */}
      <div className="flex gap-2">
        <button
          className={`flex-1 py-3 rounded-lg text-sm font-semibold transition-colors ${
            modeValue === 1
              ? 'bg-blue-600 text-white'
              : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
          }`}
          onClick={() => writeParam('CmdMode', 1)}
        >
          转速模式
        </button>
        <button
          className={`flex-1 py-3 rounded-lg text-sm font-semibold transition-colors ${
            modeValue === 2
              ? 'bg-blue-600 text-white'
              : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
          }`}
          onClick={() => writeParam('CmdMode', 2)}
        >
          转矩模式
        </button>
      </div>

      {/* 圆形转速仪表盘（双向，0居中） */}
      <div className="flex justify-center">
        <GaugeChart
          value={motorSpd ?? 0}
          min={gaugeMin}
          max={gaugeMax}
          unit="rpm"
          label="MotorSpd"
          size={220}
        />
      </div>

      {/* 速度设定：转向开关 + 滑动条（仅转速模式） */}
      {modeValue === 1 && (
      <div className="flex flex-col gap-2">
        {/* 转向开关 */}
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-400 shrink-0">转向</span>
          <div className="flex flex-1 gap-1">
            <button
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${
                direction === 1
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
              }`}
              onClick={() => setDirection(1)}
            >
              ▶ 正转
            </button>
            <button
              className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${
                direction === -1
                  ? 'bg-orange-500 text-white'
                  : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
              }`}
              onClick={() => setDirection(-1)}
            >
              ◀ 反转
            </button>
          </div>
        </div>

        {/* 速度滑条 */}
        <div className="flex flex-col gap-1">
          <div className="flex justify-between text-xs text-slate-400">
            <span>速度设定 CmdSpd</span>
            <span className={`font-mono ${direction === -1 ? 'text-orange-400' : 'text-slate-200'}`}>
              {direction === -1 ? '-' : '+'}{spdValue.toFixed(cmdSpd?.decimals === 0 ? 0 : 1)} rpm
            </span>
          </div>
          <input
            type="range"
            className="w-full h-2"
            style={{ accentColor: direction === -1 ? '#f97316' : '#3b82f6' }}
            min={Math.max(0, cmdSpd?.min ?? 0)}
            max={cmdSpd?.max ?? 6000}
            step={cmdSpd ? 1 / Math.pow(10, cmdSpd.decimals) : 1}
            value={spdValue}
            onChange={(e) => setSpdLocal(Number(e.target.value))}
            onMouseUp={(e) => {
              const v = Number((e.target as HTMLInputElement).value);
              setSpdLocal(null);
              writeParam('CmdSpd', v * direction);
            }}
            onTouchEnd={(e) => {
              const v = Number((e.target as HTMLInputElement).value);
              setSpdLocal(null);
              writeParam('CmdSpd', v * direction);
            }}
          />
          <div className="flex justify-between text-xs text-slate-600">
            <span>{Math.max(0, cmdSpd?.min ?? 0)}</span>
            <span>{cmdSpd?.max ?? 6000}</span>
          </div>
        </div>
      </div>
      )}

      {/* 转矩设定滑动条（仅转矩模式） */}
      {modeValue === 2 && (
      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-xs text-slate-400">
          <span>转矩设定 CmdTorq</span>
          <span className="font-mono text-slate-200">
            {torqValue.toFixed(cmdTorq?.decimals ?? 2)} A
          </span>
        </div>
        <input
          type="range"
          className="w-full accent-blue-500 h-2"
          min={Math.max(0, cmdTorq?.min ?? 0)}
          max={cmdTorq?.max ?? 100}
          step={cmdTorq ? 1 / Math.pow(10, cmdTorq.decimals) : 0.01}
          value={torqValue}
          onChange={(e) => setTorqLocal(Number(e.target.value))}
          onMouseUp={(e) => {
            const v = Number((e.target as HTMLInputElement).value);
            setTorqLocal(null);
            writeParam('CmdTorq', v);
          }}
          onTouchEnd={(e) => {
            const v = Number((e.target as HTMLInputElement).value);
            setTorqLocal(null);
            writeParam('CmdTorq', v);
          }}
        />
        <div className="flex justify-between text-xs text-slate-600">
          <span>{Math.max(0, cmdTorq?.min ?? 0)}</span>
          <span>{cmdTorq?.max ?? 100}</span>
        </div>
      </div>
      )}

      {/* 只读数码管区 */}
      <div className="grid grid-cols-4 gap-2">
        <DigitDisplay label="母线电压" value={formatVal('Vdc')} unit={unitOf('Vdc')} />
        <DigitDisplay label="功率" value={formatVal('MotorPower')} unit={unitOf('MotorPower')} />
        <DigitDisplay label="PCB温度" value={formatVal('PcbTemp')} unit={unitOf('PcbTemp')} />
        <DigitDisplay label="电机电流" value={formatVal('MotorIq')} unit={unitOf('MotorIq')} />
      </div>

      {/* 故障码（全宽） */}
      <div className="bg-slate-800 rounded-lg px-4 py-3 flex items-center justify-between">
        <span className="text-xs text-slate-500">故障码 AlmCode</span>
        <span className="font-mono text-lg font-bold text-red-400 tabular-nums">
          {values['AlmCode'] !== undefined ? values['AlmCode'] : '--'}
        </span>
      </div>

      </div>{/* /控制区 */}

      {/* ESP32 文件选择弹窗 */}
      {showEspPicker && (
        <EspFilePicker
          onFileReady={(file) => loadFile(file)}
          onClose={() => setShowEspPicker(false)}
        />
      )}
    </div>
  );
}