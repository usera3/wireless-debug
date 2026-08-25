import { useState } from 'react';
import type { ParamDef } from '../store/paramStore';
import { useParamStore } from '../store/paramStore';
import { useModbusOps } from '../hooks/useModbusOps';

interface ParamRowProps {
  param: ParamDef;
}

export function ParamRow({ param }: ParamRowProps) {
  const currentVal = useParamStore((s) => s.values[param.alias]);
  const flashSeq = useParamStore((s) => s.flashSeq[param.alias] ?? 0);
  const setValue = useParamStore((s) => s.setValue);
  const { readRegister, writeRegister } = useModbusOps();
  const [inputVal, setInputVal] = useState('');
  const [status, setStatus] = useState<'idle' | 'reading' | 'writing' | 'error'>('idle');
  const [errMsg, setErrMsg] = useState('');

  const displayVal =
    currentVal != null
      ? param.isFloat
        ? currentVal.toFixed(4)
        : currentVal.toFixed(param.decimals)
      : '--';

  async function handleRead() {
    setStatus('reading');
    setErrMsg('');
    try {
      const v = await readRegister(param);
      setInputVal(
        param.isFloat ? v.toFixed(4) : v.toFixed(param.decimals),
      );
      setStatus('idle');
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'error');
      setStatus('error');
    }
  }

  async function handleWrite() {
    const v = parseFloat(inputVal);
    if (isNaN(v)) return;
    setStatus('writing');
    setErrMsg('');
    try {
      await writeRegister(param, v);
      setValue(param.alias, v);
      setStatus('idle');
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'error');
      setStatus('error');
    }
  }

  return (
    <tr className="border-b border-slate-700 hover:bg-slate-800/50 text-sm">
      <td className="px-3 py-1.5 font-mono text-xs text-slate-500">{param.id}</td>
      <td className="px-3 py-1.5 font-mono text-xs text-blue-400">{param.alias}</td>
      <td className="px-3 py-1.5 text-slate-500 text-xs">{param.unit}</td>
      <td key={flashSeq} className="px-3 py-1.5 font-mono text-green-400 value-flash">{displayVal}</td>
      <td className="px-3 py-1.5">
        <input
          type="text"
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !param.readOnly && handleWrite()}
          disabled={param.readOnly}
          placeholder={displayVal}
          className="w-20 bg-slate-700 border border-slate-600 rounded px-2 py-0.5 text-slate-100
                     text-xs font-mono disabled:opacity-40 disabled:cursor-not-allowed
                     focus:outline-none focus:border-blue-500"
        />
      </td>
      <td className="px-3 py-1.5">
        <div className="flex items-center gap-1">
          <button
            onClick={handleRead}
            disabled={status === 'reading' || status === 'writing'}
            className="px-3 py-1.5 sm:px-2 sm:py-0.5 bg-slate-600 hover:bg-slate-500 disabled:opacity-40
                       text-white rounded text-xs transition-colors"
          >
            读
          </button>
          {!param.readOnly && (
            <button
              onClick={handleWrite}
              disabled={status === 'reading' || status === 'writing' || inputVal === ''}
              className="px-3 py-1.5 sm:px-2 sm:py-0.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40
                         text-white rounded text-xs transition-colors"
            >
              写
            </button>
          )}
          <span className="inline-block w-14 text-xs">
            {status === 'reading' && <span className="text-yellow-400">读取中…</span>}
            {status === 'writing' && <span className="text-yellow-400">写入中…</span>}
            {status === 'error' && <span className="text-red-400 truncate">{errMsg}</span>}
          </span>
        </div>
      </td>
    </tr>
  );
}