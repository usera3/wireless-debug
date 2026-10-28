import { useEffect, useRef, useState } from 'react';
import { useParamStore, type ParamDef } from '../store/paramStore';
import { useDashboardPoller } from '../hooks/useDashboardPoller';
import { DashboardTrend } from './DashboardTrend';
import { dashboardScale } from '../lib/dashboardDisplay';
import { EspFilePicker } from './EspFilePicker';
import { parseParameterTable } from '../lib/paramParser';
import { apiFetch, currentConnectionTarget } from '../lib/apiClient';
import { parameterSourcePolicy } from '../lib/parameterSourcePolicy';
import { buildParameterUploadRequest } from '../lib/parameterFileUpload';
import { useConnectionStore } from '../store/connectionStore';
import { wsClient } from '../lib/wsClient';

type CommandResult = { kind: 'success' | 'error'; text: string } | null;

function canWrite(param?: ParamDef) {
  return !!param && !param.readOnly && !param.isFloat && Number.isFinite(param.min) && Number.isFinite(param.max) && param.min <= param.max;
}

export function DashboardPage() {
  const connected = useConnectionStore(s => s.connected);
  const url = useConnectionStore(s => s.url);
  const params = useParamStore(s => s.params);
  const loadParams = useParamStore(s => s.loadParams);
  const setActivePage = useParamStore(s => s.setActivePage);
  const enabled = useParamStore(s => s.dashboardEnabled);
  const setDashboardEnabled = useParamStore(s => s.setDashboardEnabled);
  const { readings, speedHistory, writeParam } = useDashboardPoller(enabled);
  const fileRef = useRef<HTMLInputElement>(null);
  const commandVersion = useRef(0);
  const commandBusy = useRef(false);
  const loadVersion = useRef(0);
  const [loading, setLoading] = useState(false);
  const [fileError, setFileError] = useState('');
  const [showEspPicker, setShowEspPicker] = useState(false);
  const [speedDraft, setSpeedDraft] = useState('');
  const [currentDraft, setCurrentDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CommandResult>(null);
  const [modeAck, setModeAck] = useState<1 | 2 | null>(null);
  const [now, setNow] = useState(Date.now());
  const sourcePolicy = parameterSourcePolicy(currentConnectionTarget().kind);
  const defOf = (alias: string) => params.find(p => p.alias === alias);
  const cmdSpeed = defOf('CmdSpd');
  const cmdCurrent = defOf('CmdTorq');
  const speedWritable = canWrite(cmdSpeed) && !!cmdSpeed && cmdSpeed.max >= Math.max(0, cmdSpeed.min);
  const speedScale = dashboardScale(cmdSpeed?.unit, cmdSpeed?.decimals);
  const currentScale = dashboardScale(cmdCurrent?.unit, cmdCurrent?.decimals);
  const motorScale = dashboardScale(defOf('MotorSpd')?.unit, defOf('MotorSpd')?.decimals);
  const displayBound = (value: number, scale: ReturnType<typeof dashboardScale>) => Number((value * scale.factor).toFixed(scale.decimals));
  const speed = readings.MotorSpd;
  const commandReady = connected && enabled && !busy;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Results and local drafts cannot migrate to a different table/target/session.
  useEffect(() => {
    commandVersion.current += 1;
    commandBusy.current = false;
    setSpeedDraft(''); setCurrentDraft(''); setResult(null); setModeAck(null); setBusy(false);
    return () => { commandVersion.current += 1; };
  }, [params, url, connected]);

  // A same-tick close/open may leave connected=true in React. Invalidate at
  // the transport boundary, before any awaiting stop continuation can run.
  useEffect(() => wsClient.onConnectionReset(() => {
    commandVersion.current += 1; commandBusy.current = false;
    setSpeedDraft(''); setCurrentDraft(''); setResult(null); setModeAck(null); setBusy(false);
  }), []);

  useEffect(() => {
    loadVersion.current += 1;
    setLoading(false); setFileError('');
    return () => { loadVersion.current += 1; };
  }, [url]);

  async function loadFile(file: File) {
    const version = ++loadVersion.current;
    const capturedUrl = useConnectionStore.getState().url;
    const isLoadCurrent = () => loadVersion.current === version && useConnectionStore.getState().url === capturedUrl;
    const target = currentConnectionTarget();
    setLoading(true); setFileError('');
    try {
      const parsed = await parseParameterTable(file);
      if (!parsed.params.length) throw new Error('未找到有效参数');
      if (!isLoadCurrent()) return;
      if (target.kind === 'cloud') {
        const request = await buildParameterUploadRequest('/api/excel/upload', file);
        if (!isLoadCurrent()) return;
        const { url: uploadUrl, ...init } = request;
        const response = await apiFetch(uploadUrl, init);
        if (!response.ok) throw new Error(`参数表上传失败：HTTP ${response.status}`);
      }
      if (!isLoadCurrent()) return;
      loadParams(parsed.params, parsed.pages);
      setActivePage(parsed.pages[0] ?? '');
    } catch (error) {
      if (isLoadCurrent()) setFileError(error instanceof Error ? error.message : '参数表加载失败');
    } finally {
      if (isLoadCurrent()) setLoading(false);
    }
  }

  function display(alias: string) {
    const reading = readings[alias];
    const param = defOf(alias);
    const scale = dashboardScale(param?.unit, param?.decimals);
    return {
      value: reading && Number.isFinite(reading.value) ? (reading.value * scale.factor).toLocaleString('zh-CN', { minimumFractionDigits: scale.decimals, maximumFractionDigits: scale.decimals }) : '—',
      unit: scale.unit,
    };
  }

  function liveCommandReady() {
    const connection = useConnectionStore.getState();
    return connection.connected && connection.url === url && useParamStore.getState().params === params
      && useParamStore.getState().dashboardEnabled && !commandBusy.current;
  }

  function beginCommand() {
    const version = ++commandVersion.current;
    const generation = wsClient.generation;
    commandBusy.current = true;
    setBusy(true); setResult(null);
    return () => version === commandVersion.current && wsClient.generation === generation
      && useConnectionStore.getState().connected && useConnectionStore.getState().url === url
      && useParamStore.getState().params === params;
  }

  async function submit(alias: string, draft: string) {
    if (!liveCommandReady()) return;
    const param = defOf(alias);
    if (!canWrite(param) || !param) return;
    const scale = dashboardScale(param.unit, param.decimals);
    const actual = Number(draft) / scale.factor;
    if (!draft.trim() || !Number.isFinite(actual) || actual < param.min || actual > param.max || (alias === 'CmdSpd' && actual < 0)) {
      setResult({ kind: 'error', text: '请输入参数表范围内的数值' }); return;
    }
    const isCommandCurrent = beginCommand();
    try {
      await writeParam(alias, actual);
      if (isCommandCurrent()) {
        setResult({ kind: 'success', text: '指令已应答' });
        if (alias === 'CmdMode' && (actual === 1 || actual === 2)) setModeAck(actual);
      }
    } catch (error) {
      if (isCommandCurrent()) setResult({ kind: 'error', text: `指令失败：${error instanceof Error ? error.message : '未收到有效应答'}` });
    } finally {
      if (isCommandCurrent()) { commandBusy.current = false; setBusy(false); }
    }
  }

  async function stop() {
    if (!liveCommandReady() || !canWrite(cmdSpeed) || !canWrite(cmdCurrent)) return;
    const isCommandCurrent = beginCommand();
    let accepted = 0;
    try {
      await writeParam('CmdSpd', 0); accepted = 1;
      if (!isCommandCurrent()) return;
      await writeParam('CmdTorq', 0);
      if (isCommandCurrent()) setResult({ kind: 'success', text: '指令已应答' });
    } catch (error) {
      if (isCommandCurrent()) setResult({ kind: 'error', text: accepted === 1 ? '转速归零已应答，电流归零失败' : `停止指令失败：${error instanceof Error ? error.message : '未收到有效应答'}` });
    } finally {
      if (isCommandCurrent()) { commandBusy.current = false; setBusy(false); }
    }
  }

  const readingState = !connected ? '已断开' : !enabled ? '已暂停' : !speed ? '等待数据' : now - speed.receivedAt > 5000 ? '读数已过期' : '正在监测';
  const fault = display('AlmCode');
  const faultReading = readings.AlmCode;
  const staleFault = !!faultReading && (!connected || !enabled || now - faultReading.receivedAt > 5000);
  const feedback = display('MotorSpd');

  return (
    <div className="wd-dashboard">
      <div className="wd-dashboard-toolbar">
        <div className="wd-dashboard-imports">
          {sourcePolicy.showLocalFilePicker && <button type="button" onClick={() => fileRef.current?.click()} disabled={loading}>本地参数表</button>}
          <button type="button" onClick={() => { if (currentConnectionTarget().kind !== 'invalid') setShowEspPicker(true); }} disabled={loading || currentConnectionTarget().kind === 'invalid'}>{sourcePolicy.remoteButtonLabel}</button>
          <span className="wd-table-state">{loading ? '加载中…' : params.length ? `已加载 ${params.length} 项参数` : '—'}</span>
        </div>
        <button type="button" className="wd-monitor-toggle" aria-label="实时监测" aria-pressed={enabled} onClick={() => setDashboardEnabled(!enabled)}>
          <span>实时监测</span><i aria-hidden="true"><span /></i>
        </button>
      </div>
      {fileError && <div className="wd-inline-error" role="alert">{fileError}</div>}
      {sourcePolicy.showLocalFilePicker && <input ref={fileRef} type="file" accept=".xlsx" className="hidden" aria-label="导入参数表" onChange={event => {
        const file = event.target.files?.[0]; if (file) void loadFile(file); event.target.value = '';
      }} />}

      <div className="wd-dashboard-grid">
        <section className="wd-dashboard-speed" aria-label="实际转速">
          <div className="wd-card-heading"><h2>实际转速</h2><span className="wd-reading-state" data-active={connected && enabled && !!speed && now - speed.receivedAt <= 5000}>{readingState}</span></div>
          <div className="wd-speed-reading"><strong data-testid="dashboard-speed">{feedback.value}</strong><span>{feedback.unit || 'rpm'}</span></div>
          <div className="wd-speed-details"><span>更新 <time>{speed ? new Date(speed.receivedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}</time></span><span>故障码 <strong title={faultReading ? `上次更新 ${new Date(faultReading.receivedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : undefined}>{fault.value}</strong>{staleFault && <> · <small className="wd-metric-stale">未更新</small></>}</span></div>
        </section>

        <aside className="wd-dashboard-control" aria-label="运行控制">
          <h2>运行控制</h2>
          <form onSubmit={event => { event.preventDefault(); void submit('CmdSpd', speedDraft); }}>
            <label htmlFor="dashboard-speed-command">目标转速</label>
            <div className="wd-number-field"><input id="dashboard-speed-command" type="number" value={speedDraft} onChange={event => { setSpeedDraft(event.target.value); setResult(null); }} disabled={!speedWritable || busy} min={cmdSpeed ? displayBound(Math.max(0, cmdSpeed.min), speedScale) : undefined} max={cmdSpeed ? displayBound(cmdSpeed.max, speedScale) : undefined} step={cmdSpeed ? speedScale.factor / 10 ** cmdSpeed.decimals : 1} placeholder="—" /><span>{speedScale.unit || 'rpm'}</span></div>
            <button className="wd-primary-button" type="submit" disabled={!commandReady || !speedWritable || !speedDraft.trim()}>下发转速</button>
          </form>
          <button type="button" className="wd-dashboard-stop" disabled={!commandReady || !canWrite(cmdSpeed) || !canWrite(cmdCurrent)} onClick={() => { void stop(); }}>停止</button>
          {(result || busy) && <div role={result?.kind === 'error' ? 'alert' : 'status'} className="wd-command-result" data-testid="dashboard-command-result" data-state={result?.kind || 'pending'}>{busy ? '等待应答…' : result?.text}</div>}
          <details className="wd-dashboard-advanced">
            <summary>高级调试</summary>
            <div className="wd-dashboard-modes" aria-label="模式指令">
              <button type="button" disabled={!commandReady || !canWrite(defOf('CmdMode'))} aria-pressed={modeAck === 1} onClick={() => { void submit('CmdMode', '1'); }}>转速模式</button>
              <button type="button" disabled={!commandReady || !canWrite(defOf('CmdMode'))} aria-pressed={modeAck === 2} onClick={() => { void submit('CmdMode', '2'); }}>转矩模式</button>
            </div>
            <form onSubmit={event => { event.preventDefault(); void submit('CmdTorq', currentDraft); }}>
              <label htmlFor="dashboard-current-command">电流指令</label>
              <div className="wd-number-field"><input id="dashboard-current-command" type="number" value={currentDraft} onChange={event => { setCurrentDraft(event.target.value); setResult(null); }} disabled={!canWrite(cmdCurrent) || busy} min={cmdCurrent ? displayBound(cmdCurrent.min, currentScale) : undefined} max={cmdCurrent ? displayBound(cmdCurrent.max, currentScale) : undefined} step={cmdCurrent ? currentScale.factor / 10 ** cmdCurrent.decimals : 1} placeholder="—" /><span>{currentScale.unit}</span></div>
              <button type="submit" disabled={!commandReady || !canWrite(cmdCurrent) || !currentDraft.trim()}>下发电流</button>
            </form>
          </details>
        </aside>

        <DashboardTrend points={speedHistory} now={now} factor={motorScale.factor} unit={motorScale.unit || 'rpm'} />

        <div className="wd-dashboard-metrics">
          {([['MotorIq', '电流'], ['Vdc', '母线电压'], ['MotorPower', '功率'], ['PcbTemp', '驱动板温度']] as const).map(([alias, label]) => {
            const metric = display(alias);
            const reading = readings[alias];
            const stale = !!reading && (!connected || !enabled || now - reading.receivedAt > 5000);
            return <div className="wd-metric" key={alias} data-testid={`dashboard-metric-${alias}`} data-stale={stale}><div className="wd-metric-heading"><span className="wd-metric-label">{label}</span>{stale && <span className="wd-metric-stale" title={`上次更新 ${new Date(reading.receivedAt).toLocaleTimeString('zh-CN', { hour12: false })}`}>未更新</span>}</div><span className="wd-metric-value">{metric.value}{metric.unit && <small>{metric.unit}</small>}</span></div>;
          })}
        </div>
      </div>
      {showEspPicker && <EspFilePicker onFileReady={file => { void loadFile(file); }} onClose={() => setShowEspPicker(false)} policy={sourcePolicy} />}
    </div>
  );
}
