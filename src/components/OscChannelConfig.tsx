import type { ChannelConfig, ChannelRowState } from '../store/oscStore';
import { useOscStore, defaultRow } from '../store/oscStore';
import { useParamStore } from '../store/paramStore';

const PARAM_TYPES = [
  { value: 0x00, label: '0x00 int16' },
  { value: 0x01, label: '0x01 uint16' },
  { value: 0x02, label: '0x02 int32' },
  { value: 0x03, label: '0x03 float32' },
  { value: 0x04, label: '0x04 float64' },
  { value: 0x05, label: '0x05 float→Q14' },
  { value: 0x06, label: '0x06 float×1000' },
  { value: 0x07, label: '0x07 double→float' },
  { value: 0x08, label: '0x08 double→Q14' },
  { value: 0x09, label: '0x09 double×1000' },
];

const BYTE_WIDTH_MAP: Record<number, number> = {
  0x00: 2, 0x01: 2, 0x02: 4, 0x03: 4, 0x04: 8,
  0x05: 2, 0x06: 2, 0x07: 4, 0x08: 2, 0x09: 2,
};

const MAX_CHANNELS = 12;

const COMM_RATE_OPTIONS = [
  { value: 0,         label: '不限制' },
  { value: 10_000,    label: '10 kbps' },
  { value: 20_000,    label: '20 kbps' },
  { value: 50_000,    label: '50 kbps' },
  { value: 100_000,   label: '100 kbps' },
  { value: 200_000,   label: '200 kbps' },
  { value: 500_000,   label: '500 kbps' },
  { value: 1_000_000, label: '1 Mbps' },
  { value: 2_000_000, label: '2 Mbps' },
];

export function buildChannelConfigs(rows: ChannelRowState[], numChannels: number): ChannelConfig[] {
  return rows.slice(0, numChannels).map((r, i) => ({
    channelNo: i + 1,
    varAddr: parseInt(r.varAddrHex, 16) || 0,
    paramType: r.paramType,
    label: r.label,
    byteWidth: BYTE_WIDTH_MAP[r.paramType] ?? 2,
  }));
}

export function OscChannelConfig() {
  const { maxChannels, configRows, numChannels, setConfigRows, setNumChannels, commRateLimit, setCommRateLimit } = useOscStore();
  const params = useParamStore((s) => s.params);
  const count = Math.min(maxChannels, MAX_CHANNELS);

  function setRow(i: number, patch: Partial<ChannelRowState>) {
    const next = configRows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    setConfigRows(next);
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

  function handleNumChange(n: number) {
    setNumChannels(n);
    if (n > configRows.length) {
      setConfigRows([
        ...configRows,
        ...Array.from({ length: n - configRows.length }, (_, i) =>
          defaultRow(configRows.length + i + 1),
        ),
      ]);
    }
  }

  const activeRows = configRows.slice(0, numChannels);

  return (
    <div className="space-y-2">
      {/* 标题 + 通道数同行 */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs font-semibold text-slate-400">通道配置</span>
        <label className="text-slate-500 text-xs">通道数</label>
        <select
          value={numChannels}
          onChange={(e) => handleNumChange(Number(e.target.value))}
          className="bg-slate-700 border border-slate-600 rounded px-2 py-0.5 text-slate-100 text-xs"
        >
          {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <label className="text-slate-500 text-xs">通讯速率</label>
        <select
          value={commRateLimit}
          onChange={(e) => setCommRateLimit(Number(e.target.value))}
          className="bg-slate-700 border border-slate-600 rounded px-2 py-0.5 text-slate-100 text-xs"
        >
          {COMM_RATE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* 手机单栏 / 桌面双栏 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        {activeRows.map((row, i) => (
          <div key={i} className="grid grid-cols-[1.2rem_1fr_1fr_1.5fr] gap-1 items-center">
            <span className="text-slate-500 text-xs text-right">{i + 1}</span>
            <input
              type="text"
              value={row.varAddrHex}
              onChange={(e) => setRow(i, { varAddrHex: e.target.value.toUpperCase() })}
              className="bg-slate-700 border border-slate-600 rounded px-1.5 py-0.5 text-slate-100 font-mono text-xs w-full"
              placeholder="0000"
              maxLength={4}
            />
            <select
              value={row.paramType}
              onChange={(e) => setRow(i, { paramType: Number(e.target.value) })}
              className="bg-slate-700 border border-slate-600 rounded px-1 py-0.5 text-slate-100 text-xs w-full"
            >
              {PARAM_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <input
              type="text"
              value={row.label}
              onChange={(e) => handleAliasInput(i, e.target.value)}
              className="bg-slate-700 border border-slate-600 rounded px-1.5 py-0.5 text-slate-100 text-xs w-full"
              placeholder="标签"
            />
          </div>
        ))}
      </div>
    </div>
  );
}