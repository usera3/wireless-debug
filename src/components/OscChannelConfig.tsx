import { useState } from 'react';
import type { ChannelConfig } from '../store/oscStore';
import { useOscStore } from '../store/oscStore';
import { useParamStore } from '../store/paramStore';

const PARAM_TYPES = [
  { value: 0x00, label: '0x00 int16' },
  { value: 0x01, label: '0x01 uint16' },
  { value: 0x02, label: '0x02 int32' },
  { value: 0x03, label: '0x03 float32' },
  { value: 0x04, label: '0x04 float64' },
];

const BYTE_WIDTH_MAP: Record<number, number> = {
  0x00: 2, 0x01: 2, 0x02: 4, 0x03: 4, 0x04: 8,
};

const MAX_CHANNELS = 12;

interface RowState {
  varAddrHex: string;
  paramType: number;
  label: string;
}

function defaultRow(channelNo: number): RowState {
  return { varAddrHex: '0000', paramType: 0x00, label: `CH${channelNo}` };
}

interface OscChannelConfigProps {
  onApply: (channels: ChannelConfig[]) => void;
}

export function OscChannelConfig({ onApply }: OscChannelConfigProps) {
  const maxChannels = useOscStore((s) => s.maxChannels);
  const params = useParamStore((s) => s.params);
  const count = Math.min(maxChannels, MAX_CHANNELS);

  const [rows, setRows] = useState<RowState[]>(() =>
    Array.from({ length: 4 }, (_, i) => defaultRow(i + 1)),
  );
  const [numChannels, setNumChannels] = useState(4);

  function setRow(i: number, patch: Partial<RowState>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function handleAliasInput(i: number, alias: string) {
    const param = params.find((p) => p.alias === alias);
    if (param) {
      setRow(i, {
        varAddrHex: param.regAddr.toString(16).padStart(4, '0').toUpperCase(),
        label: alias,
      });
    } else {
      setRow(i, { label: alias });
    }
  }

  function handleApply() {
    const channels: ChannelConfig[] = rows.slice(0, numChannels).map((r, i) => ({
      channelNo: i + 1,
      varAddr: parseInt(r.varAddrHex, 16) || 0,
      paramType: r.paramType,
      label: r.label,
      byteWidth: BYTE_WIDTH_MAP[r.paramType] ?? 2,
    }));
    onApply(channels);
  }

  // 动态扩展/缩减行
  function handleNumChange(n: number) {
    setNumChannels(n);
    if (n > rows.length) {
      setRows((prev) => [
        ...prev,
        ...Array.from({ length: n - prev.length }, (_, i) =>
          defaultRow(prev.length + i + 1),
        ),
      ]);
    }
  }

  return (
    <div className="space-y-3">
      {/* 通道数选择 */}
      <div className="flex items-center gap-3 text-sm">
        <label className="text-slate-400">通道数</label>
        <select
          value={numChannels}
          onChange={(e) => handleNumChange(Number(e.target.value))}
          className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-100 text-sm"
        >
          {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </div>

      {/* 表头 */}
      <div className="grid grid-cols-[2rem_8rem_10rem_1fr] gap-2 text-xs text-slate-500 px-1">
        <span>CH</span>
        <span>变量地址 (hex)</span>
        <span>数据类型</span>
        <span>标签 / alias</span>
      </div>

      {/* 通道行 */}
      {rows.slice(0, numChannels).map((row, i) => (
        <div
          key={i}
          className="grid grid-cols-[2rem_8rem_10rem_1fr] gap-2 items-center text-sm"
        >
          <span className="text-slate-400 text-xs">{i + 1}</span>
          <input
            type="text"
            value={row.varAddrHex}
            onChange={(e) => setRow(i, { varAddrHex: e.target.value.toUpperCase() })}
            className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-100 font-mono text-xs w-full"
            placeholder="0000"
            maxLength={4}
          />
          <select
            value={row.paramType}
            onChange={(e) => setRow(i, { paramType: Number(e.target.value) })}
            className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-100 text-xs w-full"
          >
            {PARAM_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <input
            type="text"
            value={row.label}
            onChange={(e) => handleAliasInput(i, e.target.value)}
            className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-100 text-xs w-full"
            placeholder="alias 或自定义标签"
          />
        </div>
      ))}

      <button
        onClick={handleApply}
        className="mt-1 px-4 py-1.5 bg-slate-600 hover:bg-slate-500 text-white rounded text-sm"
      >
        应用配置
      </button>
    </div>
  );
}
