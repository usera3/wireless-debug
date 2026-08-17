import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnectionStore } from '../store/connectionStore';
import { BaudPicker } from './BaudPicker';
import { useBootloaderStore } from '../store/bootloaderStore';
import { evaluateStaConnectAttempt } from '../lib/wifiStaFeedback';
import { resolveConnectionTarget } from '../lib/connectionTarget';
import { apiJson, apiPostJson } from '../lib/apiClient';
import { probeLocalNetworkAccess, requiresLocalNetworkPermission } from '../lib/localNetworkAccess';
import {
  buildCloudDeviceUrl,
  cloudDeviceIdFromUrl,
  connectionChoiceFromUrl,
  onlineCloudDevices,
  type CloudDeviceOption,
  type ConnectionChoice,
} from '../lib/connectionSelection';
import { platformDeviceDirectoryUrl } from '../lib/remoteConsole';

type StatusKind = 'idle' | 'ok' | 'err' | 'ing';

interface DeviceStatus {
  ok?: boolean;
  net?: string;
  comm?: string;
  uart_baud?: number;
  ble_ready?: boolean;
  wifi_ws_client?: boolean;
}

interface WifiStatus {
  mode?: string;
  ap_ssid?: string;
  sta_ssid?: string;
  sta_configured?: boolean;
  sta_connecting?: boolean;
  sta_connected?: boolean;
  sta_ip?: string;
}

interface BleStatus {
  ok?: boolean;
  started?: boolean;
  subscribed?: boolean;
}

interface ApiResponse {
  ok?: boolean;
  msg?: string;
  baud?: number;
}

interface CloudDeviceListResponse {
  devices?: Array<{
    device_id?: string;
    display_name?: string;
    cloud_state?: string;
  }>;
}

const BAUD_PRESETS = [115200, 921600, 2000000, 3000000];
const DEVICE_AP_IP = '192.168.4.1';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatBaud(baud?: number): string {
  if (!baud) return '--';
  return baud.toLocaleString();
}

function formatBool(value?: boolean): string {
  if (value == null) return '--';
  return value ? '是' : '否';
}

function formatMode(mode?: string): string {
  return mode ? mode.toUpperCase() : '--';
}

function statusColor(kind: StatusKind): string {
  if (kind === 'ok') return 'text-green-400';
  if (kind === 'err') return 'text-red-400';
  if (kind === 'ing') return 'text-blue-400';
  return 'text-slate-400';
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-700 bg-slate-900/35 p-4">
      <h3 className="text-sm font-semibold text-slate-200 mb-3">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-slate-500 mb-1">{label}</div>
      <div className="text-sm text-slate-200 truncate tabular-nums" title={typeof value === 'string' ? value : undefined}>
        {value}
      </div>
    </div>
  );
}

function StatusDot({ active, pending }: { active?: boolean; pending?: boolean }) {
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full ${
        active ? 'bg-green-400' : pending ? 'bg-yellow-400 animate-pulse' : 'bg-slate-500'
      }`}
    />
  );
}

function Indicator({
  tone,
  label,
  detail,
}: {
  tone: 'ok' | 'warn' | 'off' | 'err';
  label: string;
  detail?: string;
}) {
  const color = {
    ok: 'bg-green-400',
    warn: 'bg-yellow-400 animate-pulse',
    off: 'bg-slate-500',
    err: 'bg-red-500',
  }[tone];

  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${color}`} />
      <span className="text-sm text-slate-200 truncate" title={detail ?? label}>
        {label}
      </span>
      {detail && <span className="text-xs text-slate-500 truncate">{detail}</span>}
    </div>
  );
}

function actionButtonClass(active = false): string {
  return `px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-45 disabled:cursor-not-allowed ${
    active
      ? 'bg-blue-600 text-white'
      : 'bg-slate-700 hover:bg-slate-600 text-slate-100'
  }`;
}

export function ConnectionPanel() {
  const { url, connected, connecting, setUrl, connect, disconnect } = useConnectionStore();
  const [showBaudPicker, setShowBaudPicker] = useState(false);
  const { guiConfig, loadGuiConfig, exportGuiConfig, applyGuiConfigText } = useBootloaderStore();
  const configInputRef = useRef<HTMLInputElement>(null);

  const [editingJson, setEditingJson] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus | null>(null);
  const [wifiStatus, setWifiStatus] = useState<WifiStatus | null>(null);
  const [bleStatus, setBleStatus] = useState<BleStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<{ msg: string; kind: StatusKind }>({
    msg: '等待操作',
    kind: 'idle',
  });
  const [customBaud, setCustomBaud] = useState('');
  const [localAccessGranted, setLocalAccessGranted] = useState(false);
  const [connectionChoice, setConnectionChoice] = useState<ConnectionChoice>(() => connectionChoiceFromUrl(url));
  const [cloudDevices, setCloudDevices] = useState<CloudDeviceOption[]>([]);
  const [cloudDevicesLoading, setCloudDevicesLoading] = useState(false);
  const [selectedCloudDeviceId, setSelectedCloudDeviceId] = useState(() => cloudDeviceIdFromUrl(url) || '');

  const target = useMemo(() => resolveConnectionTarget(url, window.location.origin), [url]);
  const wifiConfigHref = target.kind === 'invalid' ? '#' : `${target.apiBase}/wifi.html`;
  const needsLocalPermission = requiresLocalNetworkPermission(target, window.location.protocol);

  const loadCloudDevices = useCallback(async () => {
    const directoryUrl = platformDeviceDirectoryUrl();
    if (!directoryUrl) {
      setCloudDevices([]);
      return;
    }
    setCloudDevicesLoading(true);
    try {
      const response = await fetch(directoryUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json() as CloudDeviceListResponse;
      const devices = onlineCloudDevices(json.devices || []);
      setCloudDevices(devices);
      setSelectedCloudDeviceId((current) => {
        if (devices.some((device) => device.deviceId === current)) return current;
        return devices[0]?.deviceId || '';
      });
    } catch {
      setCloudDevices([]);
    } finally {
      setCloudDevicesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!platformDeviceDirectoryUrl()) return;
    void loadCloudDevices();
    const timer = window.setInterval(() => void loadCloudDevices(), 5000);
    return () => window.clearInterval(timer);
  }, [loadCloudDevices]);

  function applyConnectionChoice(choice: ConnectionChoice) {
    if (connected || connecting) return;
    setConnectionChoice(choice);
    if (choice === 'local') {
      setUrl(`http://${DEVICE_AP_IP}`);
      return;
    }
    if (choice === 'cloud') {
      const deviceId = selectedCloudDeviceId || cloudDevices[0]?.deviceId;
      if (deviceId) setUrl(buildCloudDeviceUrl(window.location.origin, deviceId));
    }
  }

  function selectCloudDevice(deviceId: string) {
    setSelectedCloudDeviceId(deviceId);
    if (!connected && !connecting && deviceId) {
      setUrl(buildCloudDeviceUrl(window.location.origin, deviceId));
    }
  }

  const refreshStatus = useCallback(async (silent = false) => {
    if (target.kind === 'invalid') {
      setDeviceStatus(null);
      setWifiStatus(null);
      setBleStatus(null);
      if (!silent) setActionStatus({ msg: target.error, kind: 'err' });
      return;
    }
    if (needsLocalPermission && !localAccessGranted) return;
    if (!silent) setRefreshing(true);
    try {
      const [device, wifi, ble] = await Promise.all([
        apiJson<DeviceStatus>('/api/device/status'),
        apiJson<WifiStatus>('/api/wifi/status'),
        apiJson<BleStatus>('/api/ble/status'),
      ]);
      setDeviceStatus(device);
      setWifiStatus(wifi);
      setBleStatus(ble);
      if (!silent) {
        setActionStatus({ msg: '状态已刷新', kind: 'ok' });
      }
    } catch (err) {
      setActionStatus({ msg: `状态刷新失败：${(err as Error).message}`, kind: 'err' });
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, [localAccessGranted, needsLocalPermission, target]);

  useEffect(() => {
    setLocalAccessGranted(false);
  }, [url]);

  async function connectTarget() {
    if (!needsLocalPermission) {
      connect();
      return;
    }

    setActionStatus({ msg: '正在请求局域网访问权限...', kind: 'ing' });
    try {
      const granted = await probeLocalNetworkAccess(target);
      if (!granted) throw new Error('ESP32 未响应，请确认电脑已连接设备热点');
      setLocalAccessGranted(true);
      setActionStatus({ msg: '局域网访问已授权，正在连接...', kind: 'ok' });
      connect();
    } catch (err) {
      setLocalAccessGranted(false);
      setActionStatus({ msg: `局域网访问失败：${(err as Error).message}`, kind: 'err' });
    }
  }

  useEffect(() => {
    void refreshStatus(true);
    const timer = window.setInterval(() => {
      void refreshStatus(true);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  async function runAction(label: string, fn: () => Promise<ApiResponse>) {
    setActionBusy(label);
    setActionStatus({ msg: `${label}...`, kind: 'ing' });
    try {
      const json = await fn();
      if (json.ok === false) throw new Error(json.msg || '操作失败');
      if (json.baud) {
        localStorage.setItem('esp32_uart_baud', String(json.baud));
      }
      setActionStatus({ msg: `${label}成功`, kind: 'ok' });
      await refreshStatus(true);
    } catch (err) {
      setActionStatus({ msg: `${label}失败：${(err as Error).message}`, kind: 'err' });
    } finally {
      setActionBusy(null);
    }
  }

  async function connectExternalWifi() {
    setActionBusy('连接外部 WiFi');
    setActionStatus({ msg: '正在连接外部 WiFi...', kind: 'ing' });

    try {
      if (!wifiStatus?.sta_configured) {
        setActionStatus({ msg: '连接外部 WiFi失败：未保存热点，请先网页配网', kind: 'err' });
        return;
      }

      const json = await apiPostJson<ApiResponse>('/api/wifi/mode', { mode: 'sta' });
      if (json.ok === false) throw new Error(json.msg || '操作失败');

      const startedAt = Date.now();
      while (true) {
        await sleep(1000);
        const elapsedMs = Date.now() - startedAt;
        let nextWifi: WifiStatus;
        try {
          nextWifi = await apiJson<WifiStatus>('/api/wifi/status');
        } catch {
          if (elapsedMs >= 12000) {
            setActionStatus({
              msg: '连接外部 WiFi失败：设备状态查询超时，请确认 ESP32 热点仍可访问',
              kind: 'err',
            });
            return;
          }
          setActionStatus({ msg: '正在连接外部 WiFi：等待设备状态...', kind: 'ing' });
          continue;
        }
        setWifiStatus(nextWifi);
        const feedback = evaluateStaConnectAttempt(nextWifi, elapsedMs);
        setActionStatus({ msg: feedback.message, kind: feedback.kind });
        if (feedback.done) return;
      }
    } catch (err) {
      setActionStatus({ msg: `连接外部 WiFi失败：${(err as Error).message}`, kind: 'err' });
    } finally {
      setActionBusy(null);
      await refreshStatus(true);
    }
  }

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

  function applyBaud(baud: number) {
    if (!baud || baud < 1200 || baud > 5000000) {
      setActionStatus({ msg: '波特率范围：1200 ~ 5000000', kind: 'err' });
      return;
    }
    void runAction(`设置波特率 ${baud}`, () => apiPostJson<ApiResponse>('/api/uart/baud', { baud }));
    setCustomBaud('');
  }

  const currentComm = formatMode(deviceStatus?.comm);
  const currentWifiMode = formatMode(wifiStatus?.mode ?? deviceStatus?.net);
  const currentBaud = deviceStatus?.uart_baud;
  const staConnecting = Boolean(wifiStatus?.sta_connecting);
  const staConnected = Boolean(wifiStatus?.sta_connected);
  const staActive = currentWifiMode === 'STA' || staConnecting || staConnected;
  const staSsid = wifiStatus?.sta_ssid || '';
  const activeStaSsid = staActive ? staSsid : '';
  const savedStaSsid = !staActive && wifiStatus?.sta_configured ? staSsid : '';
  const staIndicatorTone = staConnected ? 'ok' : staConnecting ? 'warn' : 'off';
  const staIndicatorLabel = staConnected ? 'STA 已连接' : staConnecting ? 'STA 连接中' : 'STA 未连接';
  const busy = actionBusy != null;
  const targetDetail =
    target.kind === 'invalid'
      ? target.error
      : `WS ${target.wsUrl} · API ${target.apiBase}`;
  const targetTone = target.kind === 'invalid' ? 'err' : target.kind === 'cloud' ? 'warn' : 'ok';

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-semibold text-slate-100">连接设置</h2>
        <button
          onClick={() => void refreshStatus(false)}
          disabled={refreshing}
          className="ml-auto px-3 py-1.5 rounded text-xs font-medium bg-slate-700 hover:bg-slate-600 disabled:opacity-45 disabled:cursor-not-allowed text-slate-100 transition-colors"
        >
          {refreshing ? '刷新中...' : '刷新状态'}
        </button>
        <span
          className={`w-72 shrink-0 truncate text-right text-xs ${statusColor(actionStatus.kind)}`}
          title={actionStatus.msg}
        >
          {actionStatus.msg}
        </span>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Section title="连接目标">
          <div className="space-y-4">
            <div>
              <div className="grid grid-cols-3 gap-2">
                {([
                  ['local', '局域网设备'],
                  ['cloud', '云端设备'],
                  ['custom', '自定义地址'],
                ] as const).map(([choice, label]) => (
                  <button
                    key={choice}
                    type="button"
                    onClick={() => applyConnectionChoice(choice)}
                    disabled={connected || connecting}
                    className={actionButtonClass(connectionChoice === choice)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {connectionChoice === 'local' && (
              <div className="rounded border border-slate-700 bg-slate-950/25 px-3 py-3">
                <Field label="设备" value="当前直连 ESP32" />
              </div>
            )}

            {connectionChoice === 'cloud' && (
              <div>
                <label className="block text-sm text-slate-400 mb-1">在线设备</label>
                <select
                  value={selectedCloudDeviceId}
                  onChange={(event) => selectCloudDevice(event.target.value)}
                  disabled={connected || connecting || cloudDevicesLoading || cloudDevices.length === 0}
                  className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-slate-100 text-sm
                             focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {cloudDevices.length === 0 && (
                    <option value="">{cloudDevicesLoading ? '正在读取在线设备...' : '当前没有在线设备'}</option>
                  )}
                  {cloudDevices.map((device) => (
                    <option key={device.deviceId} value={device.deviceId} title={device.deviceId}>
                      {device.displayName}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {connectionChoice === 'custom' && (
              <div>
                <label className="block text-sm text-slate-400 mb-1">通信入口地址</label>
                <input
                  type="text"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  disabled={connected || connecting}
                  className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-slate-100
                             text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  placeholder="http://设备地址 或 ws://服务器地址/ws"
                  title={targetDetail}
                />
              </div>
            )}

            <div>
              <div className="mt-2 flex items-center gap-2 min-w-0">
                <Indicator tone={targetTone} label={target.label} detail={targetDetail} />
              </div>
            </div>

            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex items-center gap-2 min-w-24">
                <StatusDot active={connected} pending={connecting} />
                <span className="text-sm text-slate-300">
                  {connected ? '已连接' : connecting ? '连接中...' : '未连接'}
                </span>
              </div>

              <button
                onClick={connected ? disconnect : () => void connectTarget()}
                disabled={connecting || target.kind === 'invalid'}
                className={`px-4 py-2 rounded text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  connected
                    ? 'bg-red-600 hover:bg-red-700 text-white'
                    : 'bg-blue-600 hover:bg-blue-700 text-white'
                }`}
              >
                {connected ? '断开' : connecting ? '连接中...' : '连接'}
              </button>
            </div>

            <p className="text-xs text-slate-500">
              局域网设备固定连接当前热点中的 ESP32；云端设备仅显示当前在线设备；自定义地址用于工程调试。
            </p>
          </div>
        </Section>

        <Section title="数据转发方式">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="当前模式" value={<span className="font-mono">{currentComm}</span>} />
              <Field label="WebSocket 客户端" value={formatBool(deviceStatus?.wifi_ws_client)} />
            </div>

            <div className="flex gap-2 flex-wrap">
              {(['AUTO', 'WIFI', 'BLE'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => void runAction(`切换通信 ${mode}`, () => apiPostJson<ApiResponse>('/api/comm/mode', { mode: mode.toLowerCase() }))}
                  disabled={busy || target.kind === 'invalid'}
                  className={actionButtonClass(currentComm === mode)}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
        </Section>

        <Section title="WiFi 状态">
          <div className="space-y-4">
            <div className="space-y-3">
              <div className="rounded border border-slate-700/80 bg-slate-950/25 p-3">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <h4 className="text-xs font-semibold text-slate-300">设备热点 AP</h4>
                  <Indicator tone="ok" label="AP 常驻" detail="网页管理入口" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="AP SSID" value={wifiStatus?.ap_ssid || '--'} />
                  <Field label="AP IP" value={<span className="font-mono">{DEVICE_AP_IP}</span>} />
                </div>
              </div>

              <div className="rounded border border-slate-700/80 bg-slate-950/25 p-3">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <h4 className="text-xs font-semibold text-slate-300">外部 WiFi STA</h4>
                  <Indicator tone={staIndicatorTone} label={staIndicatorLabel} />
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                  <Field label="当前状态" value={<span className="font-mono">{staActive ? 'AP+STA' : 'AP'}</span>} />
                  {activeStaSsid && (
                    <Field label={staConnected ? '连接热点' : '正在连接'} value={activeStaSsid} />
                  )}
                  {staConnected && (
                    <Field label="STA IP" value={wifiStatus?.sta_ip || '--'} />
                  )}
                  {savedStaSsid && (
                    <Field label="已保存热点" value={savedStaSsid} />
                  )}
                  {!wifiStatus?.sta_configured && !staActive && (
                    <Field label="已保存热点" value="--" />
                  )}
                </div>
              </div>
            </div>

            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => void connectExternalWifi()}
                disabled={busy || target.kind === 'invalid' || staConnecting || staConnected || !wifiStatus?.sta_configured}
                className={actionButtonClass(staConnecting || staConnected)}
              >
                连接外部 WiFi
              </button>
              <button
                onClick={() => void runAction('断开外部 WiFi', () => apiPostJson<ApiResponse>('/api/wifi/mode', { mode: 'ap' }))}
                disabled={busy || target.kind === 'invalid' || !staActive}
                className={actionButtonClass(false)}
              >
                断开外部 WiFi
              </button>
              <a
                href={wifiConfigHref}
                aria-disabled={target.kind === 'invalid'}
                className="inline-flex items-center px-3 py-1.5 rounded text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-100 transition-colors"
              >
                打开网页配网
              </a>
            </div>
          </div>
        </Section>

        <Section title="蓝牙">
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Indicator
                tone={bleStatus?.started ? 'ok' : deviceStatus?.ble_ready ? 'off' : 'err'}
                label={bleStatus?.started ? 'BLE 已启动' : deviceStatus?.ble_ready ? 'BLE 未启动' : 'BLE 未就绪'}
              />
              <Indicator
                tone={bleStatus?.subscribed ? 'ok' : 'off'}
                label={bleStatus?.subscribed ? '客户端已连接' : '无客户端'}
              />
            </div>

            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => void runAction('启动 BLE', () => apiPostJson<ApiResponse>('/api/ble/start', {}))}
                disabled={busy || target.kind === 'invalid' || Boolean(bleStatus?.started)}
                className={actionButtonClass(Boolean(bleStatus?.started))}
              >
                启动 BLE
              </button>
            </div>
          </div>
        </Section>

        <Section title="串口">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="当前波特率" value={<span className="font-mono">{formatBaud(currentBaud)} bps</span>} />
              <Field label="有效范围" value="1200 ~ 5000000" />
            </div>

            <div className="flex gap-2 flex-wrap">
              {BAUD_PRESETS.map((baud) => (
                <button
                  key={baud}
                  onClick={() => applyBaud(baud)}
                  disabled={busy || target.kind === 'invalid'}
                  className={actionButtonClass(currentBaud === baud)}
                >
                  {baud >= 1000000 ? `${baud / 1000000}M` : baud.toLocaleString()}
                </button>
              ))}
              <button
                onClick={() => setShowBaudPicker(true)}
                className="px-3 py-1.5 rounded text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-100 transition-colors"
              >
                更多波特率
              </button>
            </div>

            <div className="flex gap-2">
              <input
                type="number"
                value={customBaud}
                min={1200}
                max={5000000}
                placeholder="自定义波特率"
                onChange={(e) => setCustomBaud(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyBaud(Number(customBaud));
                }}
                className="w-44 bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-slate-100 text-sm font-mono outline-none focus:border-blue-500"
              />
              <button
                onClick={() => applyBaud(Number(customBaud))}
                disabled={busy || target.kind === 'invalid' || customBaud.trim() === ''}
                className="px-3 py-1.5 rounded text-xs font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-45 disabled:cursor-not-allowed text-white transition-colors"
              >
                应用
              </button>
            </div>
          </div>
        </Section>
      </div>

      <div className="mt-6 border-t border-slate-700 pt-5 max-w-3xl">
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
              <p className="text-xs text-red-400">JSON 错误：{jsonError}</p>
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

      {showBaudPicker && <BaudPicker onClose={() => setShowBaudPicker(false)} />}
    </div>
  );
}
