import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { ChannelConfig, ChannelRowState } from '../store/oscStore';
import { useOscStore, defaultRow } from '../store/oscStore';
import { useParamStore } from '../store/paramStore';
import {
  OSC_CHANNEL_TYPE_OPTIONS,
  channelRowFromParam,
  getOscChannelType,
  parseOscAddressHex,
} from '../lib/oscChannelTypes';
import {
  buildElfChannelPatch,
  createElfAddressParser,
  type ElfAddressParser,
  type VariableSuggestion,
} from '../lib/elfAddressParser';

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
    varAddr: parseOscAddressHex(r.varAddrHex),
    typeKey: r.typeKey,
    label: r.label,
  }));
}

export function OscChannelConfig() {
  const { maxChannels, configRows, numChannels, setConfigRows, setNumChannels, commRateLimit, setCommRateLimit } = useOscStore();
  const params = useParamStore((s) => s.params);
  const count = Math.min(maxChannels, MAX_CHANNELS);
  const elfFileRef = useRef<HTMLInputElement>(null);
  const [elfParser, setElfParser] = useState<ElfAddressParser | null>(null);
  const [elfVariableCount, setElfVariableCount] = useState(0);
  const [elfFileName, setElfFileName] = useState<string | null>(null);
  const [elfLoading, setElfLoading] = useState(false);
  const [elfError, setElfError] = useState<string | null>(null);
  const [suggestionRow, setSuggestionRow] = useState<number | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});

  function setRow(i: number, patch: Partial<ChannelRowState>) {
    const next = configRows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    setConfigRows(next);
  }

  function clearRowError(i: number) {
    setRowErrors((current) => {
      if (!current[i]) return current;
      const next = { ...current };
      delete next[i];
      return next;
    });
  }

  function handleVariableInput(i: number, expression: string) {
    const param = params.find((p) => p.alias === expression);
    if (param) {
      setRow(i, channelRowFromParam(param));
    } else {
      setRow(i, { label: expression });
    }
    clearRowError(i);
    setSuggestionRow(i);
  }

  function handleAddressInput(i: number, value: string) {
    setRow(i, { varAddrHex: value });
    clearRowError(i);
  }

  async function handleElfFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setElfLoading(true);
    setElfError(null);
    setElfFileName(null);
    setElfParser(null);
    setElfVariableCount(0);
    setSuggestionRow(null);
    try {
      const parser = await createElfAddressParser(file);
      setElfParser(parser);
      setElfVariableCount(parser.getVariableNames().length);
      setElfFileName(file.name);
    } catch (error) {
      setElfError(error instanceof Error ? error.message : '解析 ELF 文件失败');
    } finally {
      setElfLoading(false);
    }
  }

  function handleVariableSelect(i: number, suggestion: VariableSuggestion) {
    if (!elfParser) return;
    if (suggestion.continuation) {
      setRow(i, { label: `${suggestion.expression}${suggestion.continuation}` });
      clearRowError(i);
      setSuggestionRow(i);
      return;
    }
    try {
      const result = elfParser.resolve(suggestion.expression);
      setRow(i, buildElfChannelPatch(suggestion.expression, result.address));
      clearRowError(i);
      setSuggestionRow(null);
    } catch (error) {
      setRowErrors((current) => ({
        ...current,
        [i]: error instanceof Error ? error.message : '变量地址解析失败',
      }));
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
  const occupiedSlots = activeRows.reduce(
    (total, row) => total + getOscChannelType(row.typeKey).slotCount,
    0,
  );

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
        <span className="text-slate-500 text-xs tabular-nums">
          占用槽位 {occupiedSlots}/{maxChannels}
        </span>
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

      <div className="flex items-center gap-2 flex-wrap text-xs">
        <input
          ref={elfFileRef}
          type="file"
          accept=".out,.elf,application/octet-stream"
          className="hidden"
          onChange={handleElfFileChange}
        />
        <button
          type="button"
          onClick={() => elfFileRef.current?.click()}
          disabled={elfLoading}
          className="px-2 py-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed text-slate-100 border border-slate-600 rounded"
        >
          {elfLoading ? '解析中...' : '加载 .out / .elf'}
        </button>
        {elfFileName && (
          <span className="text-emerald-400 truncate max-w-[24rem]" title={elfFileName}>
            已解析 {elfFileName} · {elfVariableCount} 个变量
          </span>
        )}
        {elfError && <span className="text-red-400">{elfError}</span>}
      </div>

      {/* 手机单栏 / 桌面双栏 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        {activeRows.map((row, i) => (
          <div key={i} className="grid grid-cols-[1.2rem_minmax(4rem,0.7fr)_minmax(6.5rem,0.9fr)_minmax(7rem,1.5fr)] gap-1 items-center">
            <span className="text-slate-500 text-xs text-right">{i + 1}</span>
            <div className="min-w-0">
              <input
                type="text"
                value={row.varAddrHex}
                onChange={(e) => handleAddressInput(i, e.target.value)}
                className="bg-slate-700 border border-slate-600 rounded px-1.5 py-0.5 text-slate-100 font-mono text-xs w-full"
                placeholder="0000"
                maxLength={16}
                aria-label={`通道 ${i + 1} 地址`}
              />
            </div>
            <select
              value={row.typeKey}
              onChange={(e) => setRow(i, { typeKey: e.target.value as ChannelRowState['typeKey'] })}
              className="bg-slate-700 border border-slate-600 rounded px-1 py-0.5 text-slate-100 text-xs w-full"
            >
              {OSC_CHANNEL_TYPE_OPTIONS.map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
            <div className="relative min-w-0">
              <input
                type="text"
                value={row.label}
                onChange={(e) => handleVariableInput(i, e.target.value)}
                onFocus={() => setSuggestionRow(i)}
                onBlur={() => setSuggestionRow(null)}
                className="bg-slate-700 border border-slate-600 rounded px-1.5 py-0.5 text-slate-100 font-mono text-xs w-full"
                placeholder="变量名"
                maxLength={256}
                aria-label={`通道 ${i + 1} 变量名`}
              />
              {suggestionRow === i && elfParser && (() => {
                const suggestions = elfParser.getSuggestions(row.label);
                if (suggestions.length === 0) return null;
                return (
                  <div className="absolute right-0 top-full z-50 mt-1 w-80 max-w-[calc(100vw-2rem)] max-h-48 overflow-auto rounded border border-slate-600 bg-slate-800 shadow-xl">
                    {suggestions.map((suggestion) => (
                      <button
                        key={suggestion.expression}
                        type="button"
                        title={suggestion.expression}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          handleVariableSelect(i, suggestion);
                        }}
                        className="block w-full truncate px-2 py-1 text-left font-mono text-xs text-slate-200 hover:bg-slate-700"
                      >
                        {suggestion.expression}
                      </button>
                    ))}
                  </div>
                );
              })()}
              {rowErrors[i] && <div className="absolute right-0 top-full z-40 mt-1 text-[10px] text-red-400">{rowErrors[i]}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
