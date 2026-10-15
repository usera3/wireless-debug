import { useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '../store/connectionStore';
import { useBootloaderStore } from '../store/bootloaderStore';
import type { BrowserSerialApi, BrowserSerialPort } from '../lib/browserSerial';

// Track exact browser objects: unplug/re-enumeration can create a new object.
// Web Serial exposes neither a COM name nor a unique hardware identity.
const identities = new WeakMap<BrowserSerialPort, number>();
// Notes belong to the exact browser object, not a VID/PID shared by many devices.
// They survive view changes, but are intentionally not persisted across reloads.
const portNotes = new WeakMap<BrowserSerialPort, string>();
let nextIdentity = 0;
function portIdentity(port: BrowserSerialPort): string {
  if (!identities.has(port)) identities.set(port, ++nextIdentity);
  return String(identities.get(port));
}
function portDetails(port: BrowserSerialPort) {
  const info = port.getInfo();
  const hex = (value: number) => value.toString(16).padStart(4, '0').toUpperCase();
  if (info.usbVendorId != null) {
    const vid = hex(info.usbVendorId);
    const pid = info.usbProductId == null ? '----' : hex(info.usbProductId);
    return { kind: 'USB 串口', identifier: `VID ${vid} / PID ${pid}`, detail: `VID ${vid} · PID ${pid}` };
  }
  if (info.bluetoothServiceClassId != null) {
    const service = typeof info.bluetoothServiceClassId === 'number'
      ? `0x${hex(info.bluetoothServiceClassId)}` : info.bluetoothServiceClassId;
    return { kind: '蓝牙串口', identifier: `蓝牙服务 ${service}`, detail: `蓝牙服务 ${service}` };
  }
  return { kind: '系统串口', identifier: '未提供硬件标识', detail: '浏览器未提供硬件标识' };
}
function portName(port: BrowserSerialPort): string {
  return portNotes.get(port)?.trim() || `${portDetails(port).kind} ${portIdentity(port)}`;
}
function portLabel(port: BrowserSerialPort): string {
  const identity = portNotes.get(port)?.trim() ? ` · 设备 ${portIdentity(port)}` : '';
  return `${portName(port)}（${portDetails(port).identifier}${identity}）`;
}
function permissionError(error: unknown): string {
  const err = error as Error;
  if (err.name === 'NotFoundError') return '已取消选择，未授权新串口。需要连接时请再次点击选择并授权串口';
  if (err.name === 'SecurityError') return '串口访问被权限策略（Permissions-Policy）阻止。请在允许 serial 的顶层 HTTPS 页面打开，或联系站点管理员';
  if (err.name === 'NotAllowedError') return '浏览器拒绝串口权限。请检查站点串口权限后，再次点击选择并授权串口';
  return `串口授权或发现失败：${err.message}`;
}
function buttonClass(primary = false): string {
  return `px-3 py-2 rounded cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50 disabled:cursor-not-allowed ${primary ? 'bg-blue-600 enabled:hover:bg-blue-500 enabled:active:bg-blue-400' : 'bg-slate-700 enabled:hover:bg-slate-600 enabled:active:bg-slate-500'}`;
}

export function LocalSerialPanel() {
  const state = useConnectionStore();
  const flashing = useBootloaderStore(s => s.isFlashing);
  const api = (navigator as Navigator & { serial?: BrowserSerialApi }).serial;
  const unavailable = !window.isSecureContext
    ? '串口直连需要安全上下文。请使用 HTTPS 或受信任的 localhost 地址打开页面'
    : !api ? '此浏览器不支持 Web Serial。请使用桌面版 Chrome 或 Edge，并在站点设置中允许串口访问' : null;
  const [ports, setPorts] = useState<BrowserSerialPort[]>([]);
  const [selection, setSelected] = useState<BrowserSerialPort | null>(null);
  const [noteDraft, setNoteDraft] = useState<{ port: BrowserSerialPort; value: string } | null>(null);
  const [baudDraft, setBaud] = useState('2000000');
  const [notice, setNotice] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshRef = useRef<(manual?: boolean) => void>(() => {});
  const lifetimeRef = useRef<object | null>(null);
  const discoveryRevision = useRef(0);
  const selected = state.serialSession?.port ?? selection;
  const baud = state.serialSession ? String(state.serialSession.baud) : baudDraft;
  const confirming = state.serialRecovering && state.serialNeedsConfirmation && !state.connecting;
  const locked = state.connected || state.connecting || (state.serialRecovering && !confirming) || flashing;
  const missing = selected !== null && !ports.includes(selected);
  const selectedNote = selected ? noteDraft?.port === selected ? noteDraft.value : portNotes.get(selected) ?? '' : '';
  const { url, serialMode } = state;

  function updateNote(value: string) {
    if (!selected || locked || choosing) return;
    if (value.trim()) portNotes.set(selected, value);
    else portNotes.delete(selected);
    setNoteDraft({ port: selected, value });
  }

  useEffect(() => {
    const lifetime = {};
    lifetimeRef.current = lifetime;
    let active = true;
    let pending = false;
    let again = false;
    const current = () => active && useConnectionStore.getState().serialMode && useConnectionStore.getState().url === url;
    async function refresh(manual = false) {
      if (!api || unavailable || !current()) return;
      if (manual) setRefreshing(true);
      if (pending) { again = true; return; }
      pending = true;
      const revision = discoveryRevision.current;
      try {
        const granted = await api.getPorts();
        if (!current() || discoveryRevision.current !== revision) return;
        granted.forEach(portIdentity);
        setPorts(granted);
        setNotice(null);
      } catch (error) {
        if (current() && discoveryRevision.current === revision) setNotice(permissionError(error));
      } finally {
        pending = false;
        if (current()) {
          if (again) { again = false; void refresh(); }
          else setRefreshing(false);
        }
      }
    }
    const requestRefresh = (manual = false) => { void refresh(manual); };
    refreshRef.current = requestRefresh;
    requestRefresh();
    const changed = () => requestRefresh();
    api?.addEventListener('connect', changed);
    api?.addEventListener('disconnect', changed);
    return () => {
      active = false;
      lifetimeRef.current = null;
      refreshRef.current = () => {};
      api?.removeEventListener('connect', changed);
      api?.removeEventListener('disconnect', changed);
    };
  }, [api, unavailable, url, serialMode]);

  async function choosePort() {
    if (!api || unavailable || locked || choosing) return;
    const lifetime = lifetimeRef.current;
    const revision = useConnectionStore.getState().revision;
    const current = () => lifetimeRef.current === lifetime && useConnectionStore.getState().revision === revision && useConnectionStore.getState().serialMode;
    try {
      // The first permission prompt must run synchronously inside this click.
      const permission = api.requestPort();
      setChoosing(true);
      const port = await permission;
      if (!current()) return;
      discoveryRevision.current++;
      portIdentity(port);
      setPorts(previous => previous.includes(port) ? previous : [...previous, port]);
      setSelected(port);
      setNotice(null);
    } catch (error) {
      if (current()) setNotice(permissionError(error));
    } finally {
      if (lifetimeRef.current === lifetime) setChoosing(false);
    }
  }

  return (
    <section className="space-y-5 rounded-xl border border-slate-700 bg-slate-900/35 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="6" width="18" height="12" rx="3" /><path d="M7 10h2m2 0h2m2 0h2M8 14h2m4 0h2" strokeLinecap="round" /></svg>
          </span>
          <div>
            <h3 className="text-sm font-semibold">浏览器串口直连（无需本地代理）</h3>
            <p className="mt-1 text-xs text-slate-400">首次授权并连接；原端口恢复时自动重连，身份变化需确认</p>
          </div>
        </div>
        <div role="status" data-testid="serial-state" className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs ${state.connected ? 'bg-emerald-500/10 text-emerald-300' : state.connecting || state.serialRecovering ? 'bg-amber-500/10 text-amber-300' : 'bg-slate-800 text-slate-400'}`}>
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${state.connected ? 'bg-emerald-400' : state.connecting || state.serialRecovering ? 'bg-amber-400' : 'bg-slate-500'}`} />
          {state.connected ? '串口传输已连接' : confirming ? '串口身份待确认' : state.serialRecovering ? (state.connecting ? '正在恢复串口连接' : '等待串口重新接入') : state.connecting ? '串口打开中' : '串口未打开'}
        </div>
      </div>

      {confirming && <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm leading-relaxed text-amber-300">检测到其他已授权串口，但无法确认是否为原设备。请核对设备、选择端口，再点击“确认所选串口并连接”。不会仅凭相同 VID/PID 自动连接，也不会沿用旧设备备注。无法区分时，可点击“选择并授权串口”，在浏览器弹窗中核对系统名称。</p>}

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => void choosePort()} disabled={!!unavailable || locked || choosing} className={buttonClass(true)}>{choosing ? '等待串口授权…' : '选择并授权串口'}</button>
          <button aria-label="刷新串口" aria-busy={refreshing} onClick={() => refreshRef.current(true)} disabled={flashing || choosing || !!unavailable || refreshing} className={buttonClass()}>{refreshing ? '刷新中…' : '刷新串口'}</button>
          <span className="text-xs text-slate-400">{choosing ? '请在浏览器弹窗中选择设备，取消不会打开串口' : `当前 ${ports.length} 个已授权端口`}</span>
        </div>
        <p className="text-xs leading-relaxed text-slate-400">浏览器未提供系统名称或 COM 号，可添加备注方便识别。</p>
        <label className="block space-y-2 text-sm">
          <span>已授权串口</span>
          <select aria-label="已授权串口" value={selected ? portIdentity(selected) : ''} onChange={e => setSelected(ports.find(port => portIdentity(port) === e.target.value) ?? null)} disabled={locked || choosing || !!unavailable} className="block w-full rounded-lg border border-slate-600 bg-slate-800 p-2.5 transition-colors enabled:hover:border-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50">
            <option value="">{ports.length ? '请选择已授权串口' : '暂无已授权串口，请点击选择并授权串口'}</option>
            {missing && <option value={portIdentity(selected)} disabled>{portLabel(selected)}（当前不可用）</option>}
            {ports.map(port => <option key={portIdentity(port)} value={portIdentity(port)}>{portLabel(port)}</option>)}
          </select>
        </label>
      </div>

      {selected ? (
        <div className={`space-y-4 rounded-lg border p-4 ${missing ? 'border-amber-500/40 bg-amber-500/5' : 'border-blue-500/30 bg-blue-500/5'}`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="mb-1 text-xs text-slate-400">当前选择 · {portDetails(selected).kind} · 设备 {portIdentity(selected)}</div>
              <h4 className="break-words text-sm font-semibold text-slate-100">{portName(selected)}</h4>
              <p className="mt-1 break-all font-mono text-xs text-slate-400">{portDetails(selected).detail}</p>
            </div>
            <span className={`shrink-0 rounded px-2 py-1 text-xs ${missing ? 'bg-amber-500/10 text-amber-300' : 'bg-blue-500/10 text-blue-300'}`}>{missing ? '当前不可用' : state.connected ? '正在使用' : '已选择'}</span>
          </div>
          <div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1 space-y-2 text-xs text-slate-300">
                <span className="block">设备备注（本页有效）</span>
                <input aria-label="设备备注（本页有效）" value={selectedNote} onChange={e => updateNote(e.target.value)} maxLength={40} placeholder="例如：电机调试口（COM9），由你手动备注" disabled={locked || choosing} className="block w-full min-w-0 rounded border border-slate-600 bg-slate-900 p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50" />
              </label>
              <button type="button" onClick={() => updateNote('')} disabled={locked || choosing || !selectedNote} className={buttonClass()}>清除备注</button>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">备注只跟随本页的这个设备对象，不代表自动识别到的名称。刷新网页后清除，避免同型号设备被误认。</p>
          </div>
          {missing && <p className="text-sm text-amber-400">{confirming ? '所选串口当前不可用，请核对并选择一个可用串口后确认连接' : state.serialRecovering ? '所选串口当前不可用，原端口身份恢复后会自动重连；新端口身份需手动确认' : '所选串口当前不可用，请重新插入或手动选择其他串口'}</p>}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-slate-700 px-4 py-5 text-sm text-slate-400">
          {confirming ? '请核对并选择一个已授权串口，再确认连接。' : state.serialRecovering ? '正在等待原端口恢复；若浏览器分配了新身份，需手动确认。' : state.connected || state.connecting ? '当前串口连接已保留；如需选择或更换设备，请先断开。' : ports.length ? '选择一个已授权端口，查看设备信息并添加备注。' : '首次使用请先点击“选择并授权串口”，在浏览器弹窗中确认设备。'}
        </div>
      )}

      <div className="space-y-3 border-t border-slate-700/70 pt-4">
        <label className="block space-y-2 text-sm">串口波特率
          <input aria-label="串口波特率" type="number" value={baud} onChange={e => setBaud(e.target.value)} min={1200} max={5000000} step={1} disabled={locked} className="block w-full rounded border border-slate-600 bg-slate-800 p-2 sm:w-44 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50" />
        </label>
        <div className="flex flex-wrap gap-2">{[115200, 921600, 2000000, 3000000].map(value => <button key={value} aria-pressed={Number(baud) === value} disabled={locked} onClick={() => setBaud(String(value))} className={buttonClass(Number(baud) === value)}>{value.toLocaleString()}</button>)}</div>
        <p className="text-xs leading-relaxed text-slate-400">8N1，无流控。意外断开后，仅原浏览器端口对象恢复时自动重连；新对象需核对后确认。手动断开或烧录中断后需手动连接。采集和烧录任务不会自动继续，串口已连接不代表下位机已响应。</p>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => void (!confirming && (state.connected || state.connecting || state.serialRecovering) ? state.disconnect() : selected && !missing ? state.connectSerial(selected, Number(baud)) : undefined)} disabled={flashing || choosing || ((confirming || (!state.connected && !state.connecting && !state.serialRecovering)) && (!!unavailable || !selected || missing))} className={`${buttonClass(true)} w-full sm:w-auto`}>{confirming ? '确认所选串口并连接' : state.serialRecovering ? '取消自动重连' : state.connected || state.connecting ? '断开串口' : '连接串口'}</button>
          {confirming && <button onClick={() => void state.disconnect()} disabled={flashing || choosing} className={buttonClass()}>取消自动重连</button>}
        </div>
      </div>
      {(unavailable || state.error || notice) && <p role="alert" className={`rounded-lg border p-3 text-sm ${state.serialRecovering ? 'border-amber-500/20 bg-amber-500/5 text-amber-300' : 'border-red-500/20 bg-red-500/5 text-red-300'}`}>{unavailable || state.error || notice}</p>}
    </section>
  );
}
