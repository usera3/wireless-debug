import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  cloudDeviceConsolePath,
  cloudPlatformApiUrl,
  isAuthRequiredResponse,
  normalizeCloudDevice,
  type CloudBusMessage,
  type CloudBusMessagesResponse,
  type CloudDeviceCommand,
  type CloudDeviceDetailResponse,
  type CloudDeviceHistoryResponse,
  type CloudDeviceRecord,
  type CloudDeviceRow,
  type CloudHistorySummary,
  type CloudStatusPoint,
} from '../lib/cloudPlatformApi';

interface DeviceListResponse {
  devices?: CloudDeviceRecord[];
  mqtt_connected?: boolean;
  generated_at?: string;
  summary?: {
    total?: number;
    online?: number;
    offline?: number;
    unknown?: number;
  };
}

interface CloudSummary {
  total: number;
  online: number;
  offline: number;
  unknown: number;
}

const EMPTY_SUMMARY: CloudSummary = { total: 0, online: 0, offline: 0, unknown: 0 };

type PlatformSection =
  | 'overview'
  | 'devices'
  | 'connections'
  | 'history'
  | 'messages'
  | 'capabilities'
  | 'events'
  | 'settings';

const NAV_GROUPS = [
  {
    title: '控制台',
    items: [
      { id: 'overview', code: 'OV', label: '仪表盘' },
      { id: 'devices', code: 'DV', label: '设备管理' },
      { id: 'connections', code: 'CN', label: '连接管理' },
      { id: 'history', code: 'HS', label: '连接历史' },
      { id: 'messages', code: 'MS', label: '消息中心' },
      { id: 'capabilities', code: 'CP', label: '能力清单' },
      { id: 'events', code: 'EV', label: '事件记录' },
    ],
  },
  {
    title: '系统',
    items: [{ id: 'settings', code: 'ST', label: '系统设置' }],
  },
] satisfies { title: string; items: { id: PlatformSection; code: string; label: string }[] }[];

const SECTION_COPY: Record<PlatformSection, { title: string; desc: string }> = {
  overview: {
    title: '仪表盘',
    desc: '按设备名、网络状态和实时心跳集中管理 ESP32 无线调试终端',
  },
  devices: {
    title: '设备管理',
    desc: '查看设备诊断、系统资源、基础信息和备注',
  },
  connections: {
    title: '连接管理',
    desc: '核对 AP / STA / BLE / WebSocket / UART 的实时状态',
  },
  history: {
    title: '连接历史',
    desc: '查看状态变化和云端命令 ACK 响应',
  },
  messages: {
    title: '消息中心',
    desc: '通过云平台向设备发送 notify，并查看消息流水',
  },
  capabilities: {
    title: '能力清单',
    desc: '整理云端、本地网页和固件已经暴露的能力边界',
  },
  events: {
    title: '事件记录',
    desc: '查看设备 status、availability 和命令回执原始记录',
  },
  settings: {
    title: '系统设置',
    desc: '查看云端控制台运行状态、入口策略和登录会话',
  },
};

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(cloudPlatformApiUrl(path), { cache: 'no-store' });
  if (isAuthRequiredResponse(response.status)) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.hash)}`;
    throw new Error('authentication required');
  }
  if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(cloudPlatformApiUrl(path), {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (isAuthRequiredResponse(response.status)) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.hash)}`;
    throw new Error('authentication required');
  }
  if (!response.ok) {
    const raw = await response.text();
    try {
      const parsed = JSON.parse(raw) as { message?: string; msg?: string };
      throw new Error(parsed.message || parsed.msg || raw || `HTTP ${response.status}`);
    } catch (err) {
      if (err instanceof Error && err.message !== raw) throw err;
      throw new Error(raw || `HTTP ${response.status}`);
    }
  }
  return response.json() as Promise<T>;
}

function normalizeSummary(data: DeviceListResponse, devices: CloudDeviceRow[]): CloudSummary {
  return {
    total: data.summary?.total ?? devices.length,
    online: data.summary?.online ?? devices.filter((device) => device.cloudState === 'online').length,
    offline: data.summary?.offline ?? devices.filter((device) => device.cloudState === 'offline').length,
    unknown: data.summary?.unknown ?? devices.filter((device) => device.cloudState === 'unknown').length,
  };
}

function formatGeneratedAt(value?: string): string {
  if (!value) return '--:--:--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

export function CloudPlatformPage() {
  const [devices, setDevices] = useState<CloudDeviceRow[]>([]);
  const [summary, setSummary] = useState<CloudSummary>(EMPTY_SUMMARY);
  const [mqttConnected, setMqttConnected] = useState(false);
  const [generatedAt, setGeneratedAt] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [activeSection, setActiveSection] = useState<PlatformSection>('overview');
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement | null>(null);

  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [detail, setDetail] = useState<CloudDeviceDetailResponse | null>(null);
  const [history, setHistory] = useState<CloudDeviceHistoryResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailRefreshSeq, setDetailRefreshSeq] = useState(0);
  const [displayNameDraft, setDisplayNameDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [actionMessage, setActionMessage] = useState('');

  const [busMessages, setBusMessages] = useState<CloudBusMessage[]>([]);
  const [busChannels, setBusChannels] = useState<string[]>(['notify']);
  const [busTargetDeviceId, setBusTargetDeviceId] = useState('');
  const [busChannel, setBusChannel] = useState('notify');
  const [busPayload, setBusPayload] = useState('');
  const [busMessage, setBusMessage] = useState('当前只开放 notify，避免把云端做成危险控制入口。');
  const [busLoading, setBusLoading] = useState(false);
  const [busRefreshSeq, setBusRefreshSeq] = useState(0);

  useEffect(() => {
    if (!userMenuOpen) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && userMenuRef.current?.contains(target)) return;
      setUserMenuOpen(false);
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
    };
  }, [userMenuOpen]);

  useEffect(() => {
    if (!mobileNavOpen) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMobileNavOpen(false);
    }

    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await fetchJson<DeviceListResponse>('/api/devices');
        const rows = (data.devices || []).map(normalizeCloudDevice);
        if (!cancelled) {
          setDevices(rows);
          setSummary(normalizeSummary(data, rows));
          setMqttConnected(data.mqtt_connected === true);
          setGeneratedAt(data.generated_at || '');
          setSelectedDeviceId((current) => (current && rows.some((row) => row.deviceId === current) ? current : rows[0]?.deviceId || ''));
          setBusTargetDeviceId((current) => (current && rows.some((row) => row.deviceId === current) ? current : rows[0]?.deviceId || ''));
          setError('');
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshSeq]);

  useEffect(() => {
    if (!selectedDeviceId) {
      setDetail(null);
      setHistory(null);
      setDetailError('');
      return;
    }

    let cancelled = false;
    async function loadDetail() {
      setDetailLoading(true);
      try {
        const [detailData, historyData] = await Promise.all([
          fetchJson<CloudDeviceDetailResponse>(`/api/devices/${encodeURIComponent(selectedDeviceId)}`),
          fetchJson<CloudDeviceHistoryResponse>(`/api/devices/${encodeURIComponent(selectedDeviceId)}/history`),
        ]);
        if (!cancelled) {
          setDetail(detailData);
          setHistory(historyData);
          setDisplayNameDraft(detailData.device?.display_name || '');
          setNoteDraft(detailData.notes?.[0]?.note || detailData.device?.note || '');
          setDetailError('');
        }
      } catch (err) {
        if (!cancelled) setDetailError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    }

    loadDetail();
    return () => {
      cancelled = true;
    };
  }, [selectedDeviceId, detailRefreshSeq]);

  useEffect(() => {
    let cancelled = false;
    async function loadBusMessages() {
      setBusLoading(true);
      try {
        const data = await fetchJson<CloudBusMessagesResponse>('/api/bus/messages?limit=80');
        if (!cancelled) {
          setBusMessages(data.messages || []);
          setBusChannels(data.channels?.length ? data.channels : ['notify']);
        }
      } catch (err) {
        if (!cancelled) setBusMessage(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setBusLoading(false);
      }
    }

    loadBusMessages();
    const timer = window.setInterval(loadBusMessages, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [busRefreshSeq]);

  const visibleDevices = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return devices.filter((device) => {
      if (stateFilter !== 'all' && device.cloudState !== stateFilter) return false;
      if (!needle) return true;
      return [
        device.deviceId,
        device.deviceMac,
        device.displayName,
        device.network,
        device.staIp,
        device.apIp,
        device.firmware,
      ].some((value) => value.toLowerCase().includes(needle));
    });
  }, [devices, filter, stateFilter]);

  const selectedRow = useMemo(
    () => devices.find((device) => device.deviceId === selectedDeviceId) || null,
    [devices, selectedDeviceId],
  );
  const latestPayload = useMemo(() => latestStatusPayload(detail, history), [detail, history]);
  const activeCopy = SECTION_COPY[activeSection];

  async function handleQueryStatus() {
    if (!selectedDeviceId) return;
    setActionMessage('正在请求设备刷新状态...');
    try {
      await postJson(`/api/devices/${encodeURIComponent(selectedDeviceId)}/query-status`);
      setActionMessage('已发送 query_status，等待设备 ACK');
      setDetailRefreshSeq((value) => value + 1);
      setRefreshSeq((value) => value + 1);
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSaveDisplayName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedDeviceId) return;
    setActionMessage('正在保存设备名...');
    try {
      const result = await postJson<{ display_name?: string }>(
        `/api/devices/${encodeURIComponent(selectedDeviceId)}/display-name`,
        { display_name: displayNameDraft },
      );
      setActionMessage(`已保存为 ${result.display_name || displayNameDraft || '自动设备名'}`);
      setRefreshSeq((value) => value + 1);
      setDetailRefreshSeq((value) => value + 1);
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSaveNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedDeviceId) return;
    const note = noteDraft.trim();
    if (!note) {
      setActionMessage('备注不能为空');
      return;
    }
    setActionMessage('正在保存备注...');
    try {
      await postJson(`/api/devices/${encodeURIComponent(selectedDeviceId)}/note`, { note });
      setActionMessage('备注已保存');
      setRefreshSeq((value) => value + 1);
      setDetailRefreshSeq((value) => value + 1);
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSendBusMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = busPayload.trim();
    if (!busTargetDeviceId || !payload) {
      setBusMessage('请选择目标设备并填写消息内容');
      return;
    }
    setBusMessage('正在发布到设备 inbox...');
    try {
      await postJson('/api/bus/send', {
        target_device_id: busTargetDeviceId,
        channel: busChannel,
        payload_text: payload,
      });
      setBusPayload('');
      setBusMessage('已发布，等待设备 ACK');
      setBusRefreshSeq((value) => value + 1);
    } catch (err) {
      setBusMessage(err instanceof Error ? err.message : String(err));
    }
  }

  function selectDevice(deviceId: string, section: PlatformSection = 'devices') {
    setSelectedDeviceId(deviceId);
    setBusTargetDeviceId(deviceId);
    setActiveSection(section);
  }

  function switchSection(section: PlatformSection) {
    setActiveSection(section);
    setMobileNavOpen(false);
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <div className="flex min-h-screen">
        <aside className="hidden w-[248px] shrink-0 border-r border-slate-200 bg-white lg:flex lg:flex-col">
          <div className="flex items-center gap-3 border-b border-slate-200 px-5 py-8">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-gradient-to-br from-slate-900 to-teal-500 text-sm font-black text-white">
              WD
            </div>
            <div>
              <div className="whitespace-nowrap text-lg font-black leading-tight">Wireless Debug</div>
              <div className="mt-1 inline-flex rounded-md bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-500">
                Cloud Console
              </div>
            </div>
          </div>

          <nav className="flex-1 px-3 py-6">
            {NAV_GROUPS.map((group) => (
              <div key={group.title} className="mb-7">
                <div className="mb-2 px-2 text-xs font-bold text-slate-400">{group.title}</div>
                <div className="space-y-1">
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => switchSection(item.id)}
                      className={`flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-bold transition ${
                        activeSection === item.id
                          ? 'bg-teal-50 text-teal-900'
                          : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
                      }`}
                    >
                      <span className="grid h-6 w-6 place-items-center rounded bg-slate-100 text-[11px] font-black text-slate-500">
                        {item.code}
                      </span>
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        {mobileNavOpen && (
          <div className="fixed inset-0 z-30 lg:hidden" role="dialog" aria-label="移动端导航" aria-modal="true">
            <button
              type="button"
              className="absolute inset-0 bg-slate-950/45"
              aria-label="关闭导航"
              onClick={() => setMobileNavOpen(false)}
            />
            <aside className="relative h-full w-[292px] max-w-[82vw] border-r border-slate-200 bg-white shadow-2xl">
              <div className="flex items-center gap-3 border-b border-slate-200 px-5 py-6">
                <div className="grid h-10 w-10 place-items-center rounded-lg bg-gradient-to-br from-slate-900 to-teal-500 text-sm font-black text-white">
                  WD
                </div>
                <div>
                  <div className="whitespace-nowrap text-lg font-black leading-tight">Wireless Debug</div>
                  <div className="mt-1 inline-flex rounded-md bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-500">
                    Cloud Console
                  </div>
                </div>
              </div>
              <nav className="px-3 py-5">
                {NAV_GROUPS.map((group) => (
                  <div key={group.title} className="mb-7">
                    <div className="mb-2 px-2 text-xs font-bold text-slate-400">{group.title}</div>
                    <div className="space-y-1">
                      {group.items.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => switchSection(item.id)}
                          className={`flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm font-bold transition ${
                            activeSection === item.id
                              ? 'bg-teal-50 text-teal-900'
                              : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
                          }`}
                        >
                          <span className="grid h-6 w-6 place-items-center rounded bg-slate-100 text-[11px] font-black text-slate-500">
                            {item.code}
                          </span>
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </nav>
            </aside>
          </div>
        )}

        <div className="min-w-0 flex-1">
          <header className="flex min-h-[104px] flex-col gap-4 border-b border-slate-200 bg-white px-4 py-4 sm:px-6 lg:h-[104px] lg:flex-row lg:items-center lg:justify-between lg:px-10 lg:py-0">
            <div className="flex w-full min-w-0 items-start gap-3 lg:w-auto">
              <button
                type="button"
                className="mt-1 grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-slate-200 bg-white text-sm font-black text-slate-700 shadow-sm transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800 lg:hidden"
                aria-label="打开导航"
                onClick={() => setMobileNavOpen(true)}
              >
                ☰
              </button>
              <div className="min-w-0">
                <h1 className="text-xl font-black tracking-tight sm:text-2xl">无线调试云端观测台</h1>
                <p className="mt-2 text-sm text-slate-500">多设备状态、历史事件、诊断回执集中查看</p>
              </div>
            </div>
            <div className="flex w-full flex-wrap items-center gap-2 sm:gap-3 lg:w-auto lg:justify-end">
              <StatusBadge label={mqttConnected ? 'MQTT 已连接' : 'MQTT 未连接'} tone={mqttConnected ? 'green' : 'red'} />
              <span className="inline-flex rounded-full border border-teal-100 bg-teal-50 px-3 py-2 text-xs font-bold text-teal-700 sm:px-4 sm:text-sm">
                同步 {formatGeneratedAt(generatedAt)}
              </span>
              <button
                className="h-10 rounded-lg border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 shadow-sm transition hover:-translate-y-px hover:border-teal-200 hover:bg-teal-50 hover:text-teal-800"
                onClick={() => setRefreshSeq((value) => value + 1)}
              >
                刷新
              </button>
              <div className="user-menu relative" ref={userMenuRef}>
                <button
                  type="button"
                  className="flex h-10 items-center gap-3 rounded-full border border-slate-200 bg-white px-3 text-sm font-black shadow-sm transition hover:border-teal-200 hover:bg-teal-50"
                  onClick={() => setUserMenuOpen((open) => !open)}
                  aria-expanded={userMenuOpen}
                  aria-haspopup="menu"
                >
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-cyan-100 text-xs text-cyan-700">AD</span>
                  <span className="hidden sm:inline">Admin</span>
                  <span className="text-slate-400">⌄</span>
                </button>
                <div className={`absolute right-0 z-20 mt-2 w-56 rounded-lg border border-slate-200 bg-white p-2 text-sm shadow-xl ${userMenuOpen ? 'block' : 'hidden'}`}>
                  <div className="mb-1 rounded-md bg-slate-50 px-3 py-2">
                    <div className="font-black text-slate-900">Admin</div>
                    <div className="mt-0.5 text-xs font-bold text-slate-500">admin@admin.com</div>
                  </div>
                  <span className="block rounded-md px-3 py-2 font-bold text-slate-400">个人资料</span>
                  <span className="block rounded-md px-3 py-2 font-bold text-slate-400">API 密钥</span>
                  <a className="block rounded-md px-3 py-2 font-bold text-rose-600 hover:bg-rose-50" href="/logout">
                    退出登录
                  </a>
                </div>
              </div>
            </div>
          </header>

          <main className="min-h-[calc(100vh-104px)] bg-gradient-to-br from-teal-50 via-slate-50 to-blue-50 px-4 py-5 sm:px-5 lg:px-9 lg:py-8">
            <section className="mx-auto max-w-[1380px]">
              <div className="mb-7">
                <h2 className="text-2xl font-black">{activeCopy.title}</h2>
                <p className="mt-2 text-sm text-slate-500">{activeCopy.desc}</p>
              </div>

              {activeSection === 'overview' && (
                <OverviewSection
                  summary={summary}
                  loading={loading}
                  error={error}
                  devices={visibleDevices}
                  filter={filter}
                  stateFilter={stateFilter}
                  onFilterChange={setFilter}
                  onStateFilterChange={setStateFilter}
                  onSelectDevice={selectDevice}
                />
              )}
              {activeSection === 'devices' && (
                <DeviceManagementSection
                  devices={devices}
                  selectedDeviceId={selectedDeviceId}
                  selectedRow={selectedRow}
                  detail={detail}
                  history={history}
                  latestPayload={latestPayload}
                  loading={detailLoading}
                  error={detailError}
                  displayNameDraft={displayNameDraft}
                  noteDraft={noteDraft}
                  actionMessage={actionMessage}
                  onSelectDevice={setSelectedDeviceId}
                  onDisplayNameChange={setDisplayNameDraft}
                  onNoteChange={setNoteDraft}
                  onQueryStatus={handleQueryStatus}
                  onSaveDisplayName={handleSaveDisplayName}
                  onSaveNote={handleSaveNote}
                />
              )}
              {activeSection === 'connections' && (
                <ConnectivitySection
                  devices={devices}
                  selectedDeviceId={selectedDeviceId}
                  detail={detail}
                  latestPayload={latestPayload}
                  onSelectDevice={setSelectedDeviceId}
                />
              )}
              {activeSection === 'history' && (
                <HistorySection
                  devices={devices}
                  selectedDeviceId={selectedDeviceId}
                  detail={detail}
                  history={history}
                  latestPayload={latestPayload}
                  onSelectDevice={setSelectedDeviceId}
                />
              )}
              {activeSection === 'messages' && (
                <MessageCenterSection
                  devices={devices}
                  busMessages={busMessages}
                  busChannels={busChannels}
                  targetDeviceId={busTargetDeviceId}
                  channel={busChannel}
                  payload={busPayload}
                  message={busMessage}
                  loading={busLoading}
                  onTargetChange={setBusTargetDeviceId}
                  onChannelChange={setBusChannel}
                  onPayloadChange={setBusPayload}
                  onSubmit={handleSendBusMessage}
                  onRefresh={() => setBusRefreshSeq((value) => value + 1)}
                />
              )}
              {activeSection === 'capabilities' && <CapabilitiesSection />}
              {activeSection === 'events' && (
                <EventsSection
                  devices={devices}
                  selectedDeviceId={selectedDeviceId}
                  detail={detail}
                  onSelectDevice={setSelectedDeviceId}
                />
              )}
              {activeSection === 'settings' && (
                <SettingsSection
                  mqttConnected={mqttConnected}
                  generatedAt={generatedAt}
                  selectedDeviceId={selectedDeviceId}
                  selectedRow={selectedRow}
                />
              )}
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}

function OverviewSection({
  summary,
  loading,
  error,
  devices,
  filter,
  stateFilter,
  onFilterChange,
  onStateFilterChange,
  onSelectDevice,
}: {
  summary: CloudSummary;
  loading: boolean;
  error: string;
  devices: CloudDeviceRow[];
  filter: string;
  stateFilter: string;
  onFilterChange: (value: string) => void;
  onStateFilterChange: (value: string) => void;
  onSelectDevice: (deviceId: string, section?: PlatformSection) => void;
}) {
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        <Metric label="设备总数" value={summary.total} />
        <Metric label="在线" value={summary.online} />
        <Metric label="离线" value={summary.offline} />
        <Metric label="未知" value={summary.unknown} />
      </div>
      <DeviceTablePanel
        title="设备总览"
        hint={loading ? '正在同步设备...' : `${devices.length} 台设备`}
        error={error}
        devices={devices}
        filter={filter}
        stateFilter={stateFilter}
        onFilterChange={onFilterChange}
        onStateFilterChange={onStateFilterChange}
        onSelectDevice={onSelectDevice}
      />
    </div>
  );
}

function DeviceManagementSection({
  devices,
  selectedDeviceId,
  selectedRow,
  detail,
  history,
  latestPayload,
  loading,
  error,
  displayNameDraft,
  noteDraft,
  actionMessage,
  onSelectDevice,
  onDisplayNameChange,
  onNoteChange,
  onQueryStatus,
  onSaveDisplayName,
  onSaveNote,
}: {
  devices: CloudDeviceRow[];
  selectedDeviceId: string;
  selectedRow: CloudDeviceRow | null;
  detail: CloudDeviceDetailResponse | null;
  history: CloudDeviceHistoryResponse | null;
  latestPayload: Record<string, unknown>;
  loading: boolean;
  error: string;
  displayNameDraft: string;
  noteDraft: string;
  actionMessage: string;
  onSelectDevice: (deviceId: string) => void;
  onDisplayNameChange: (value: string) => void;
  onNoteChange: (value: string) => void;
  onQueryStatus: () => void;
  onSaveDisplayName: (event: FormEvent<HTMLFormElement>) => void;
  onSaveNote: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const device = detail?.device;

  return (
    <div className="space-y-5">
      <DeviceSelector devices={devices} selectedDeviceId={selectedDeviceId} onSelect={onSelectDevice} />
      {error && <InlineAlert>{error}</InlineAlert>}
      {loading && <InlineAlert tone="blue">正在读取设备详情...</InlineAlert>}
      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <div className="space-y-5">
          <Panel title="诊断摘要" subtitle={device ? `${device.display_name || device.device_id} 当前诊断` : '未选择设备'}>
            <DiagnosticSummary device={device} history={history} />
          </Panel>
          <Panel title="系统资源" subtitle="来自固件 MQTT status 的 heap、通信和 OLED 指标">
            <SystemResources device={device} />
          </Panel>
          <Panel
            title="设备详情"
            subtitle={device?.device_id || selectedRow?.deviceId || '未选择设备'}
            action={
              <button
                className="h-10 rounded-lg bg-slate-900 px-4 text-sm font-black text-white shadow-sm transition hover:-translate-y-px hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                type="button"
                disabled={!selectedDeviceId}
                onClick={onQueryStatus}
              >
                刷新状态
              </button>
            }
          >
            <DeviceDetails
              device={device}
              selectedRow={selectedRow}
              latestPayload={latestPayload}
              displayNameDraft={displayNameDraft}
              actionMessage={actionMessage}
              onDisplayNameChange={onDisplayNameChange}
              onSaveDisplayName={onSaveDisplayName}
            />
          </Panel>
        </div>
        <Panel title="备注" subtitle="记录样机位置、用途和现场信息">
          <form className="space-y-4" onSubmit={onSaveNote}>
            <textarea
              className="min-h-[220px] w-full rounded-lg border border-slate-200 px-3 py-3 text-sm outline-none transition focus:border-teal-400 focus:ring-4 focus:ring-teal-100"
              maxLength={500}
              value={noteDraft}
              onChange={(event) => onNoteChange(event.target.value)}
              placeholder="例如：实验室 A 区，接在手机热点，当前测试 APSTA 云端消息"
            />
            <button className="h-10 rounded-lg border border-slate-200 bg-white px-4 text-sm font-black text-slate-700 shadow-sm transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800" type="submit">
              保存备注
            </button>
            {actionMessage && <p className="text-sm font-bold text-slate-500">{actionMessage}</p>}
          </form>
        </Panel>
      </div>
    </div>
  );
}

function ConnectivitySection({
  devices,
  selectedDeviceId,
  detail,
  latestPayload,
  onSelectDevice,
}: {
  devices: CloudDeviceRow[];
  selectedDeviceId: string;
  detail: CloudDeviceDetailResponse | null;
  latestPayload: Record<string, unknown>;
  onSelectDevice: (deviceId: string) => void;
}) {
  const device = detail?.device;
  const offlineHint = '设备不在线，当前状态不可判断';
  const staConnected = payloadValue(latestPayload, 'sta_connected') ?? device?.sta_connected;
  const cards = device
    ? [
        ['云端', stateLabel(device.cloud_state), relativeTime(device.last_seen_at), device.cloud_state === 'online'],
        ['网络模式', currentText(device, payloadValue(latestPayload, 'net_mode') || device.net_mode, '未知'), isDeviceOnline(device) ? 'AP / STA / APSTA 来自固件真实状态' : offlineHint, null],
        ['STA 连接', currentBoolText(device, staConnected, '已连接', '未连接'), isDeviceOnline(device) ? text(payloadValue(latestPayload, 'sta_ip') || device.sta_ip, '无 STA IP') : offlineHint, currentHealth(device, staConnected)],
        ['STA 配置', currentBoolText(device, payloadValue(latestPayload, 'sta_configured'), '已保存', '未保存'), isDeviceOnline(device) ? (payloadValue(latestPayload, 'sta_connecting') ? '正在尝试连接' : '当前未处于连接中') : offlineHint, currentHealth(device, payloadValue(latestPayload, 'sta_configured'))],
        ['AP 地址', currentText(device, payloadValue(latestPayload, 'ap_ip') || device.ap_ip), isDeviceOnline(device) ? '仅 AP/APSTA 下有效' : offlineHint, null],
        ['通信模式', currentText(device, payloadValue(latestPayload, 'comm_mode') || device.comm_mode, '未知'), isDeviceOnline(device) ? `UART ${text(payloadValue(latestPayload, 'uart_baud') || device.uart_baud)}` : offlineHint, null],
        ['BLE', currentBoolText(device, payloadValue(latestPayload, 'ble_ready'), '已启动', '未启动'), isDeviceOnline(device) ? boolText(payloadValue(latestPayload, 'ble_subscribed'), '有订阅者', '无订阅者') : offlineHint, currentHealth(device, payloadValue(latestPayload, 'ble_ready'))],
        ['WebSocket', currentBoolText(device, payloadValue(latestPayload, 'wifi_ws_client'), '有客户端', '无客户端'), isDeviceOnline(device) ? '局域网页面 UART 隧道连接状态' : offlineHint, currentHealth(device, payloadValue(latestPayload, 'wifi_ws_client'))],
        ['运行时长', isDeviceOnline(device) ? formatUptime(payloadValue(latestPayload, 'uptime_ms') || device.uptime_ms) : '-', isDeviceOnline(device) ? '来自 MQTT status uptime_ms' : offlineHint, null],
      ] as InfoCardData[]
    : [];

  return (
    <div className="space-y-5">
      <DeviceSelector devices={devices} selectedDeviceId={selectedDeviceId} onSelect={onSelectDevice} />
      <div className="grid gap-5 xl:grid-cols-[1fr_460px]">
        <Panel title="连接状态" subtitle={device ? `${device.display_name || device.device_id} 当前连接状态` : '选择设备后显示网络、BLE 和 WebSocket 状态'}>
          {device ? (
            <InfoGrid>
              {cards.map(([label, value, hint, health]) => (
                <InfoCard key={label} label={label} value={value} hint={hint} tone={toneFromHealth(health)} />
              ))}
            </InfoGrid>
          ) : (
            <EmptyBox>从总览选择设备</EmptyBox>
          )}
        </Panel>
        <Panel title="最近状态包" subtitle="MQTT status 原始上报，便于现场核对">
          <pre className="max-h-[520px] overflow-auto rounded-lg bg-slate-950 p-4 text-xs leading-relaxed text-teal-100">
            {device ? JSON.stringify(latestPayload, null, 2) : '从总览选择设备'}
          </pre>
        </Panel>
      </div>
    </div>
  );
}

function HistorySection({
  devices,
  selectedDeviceId,
  detail,
  history,
  latestPayload,
  onSelectDevice,
}: {
  devices: CloudDeviceRow[];
  selectedDeviceId: string;
  detail: CloudDeviceDetailResponse | null;
  history: CloudDeviceHistoryResponse | null;
  latestPayload: Record<string, unknown>;
  onSelectDevice: (deviceId: string) => void;
}) {
  const device = detail?.device;
  const commands = history?.commands || detail?.commands || [];
  const summary = history?.summary || {};
  const cards = device ? trendCards(device, history?.status_points || [], commands, summary, latestPayload) : [];

  return (
    <div className="space-y-5">
      <DeviceSelector devices={devices} selectedDeviceId={selectedDeviceId} onSelect={onSelectDevice} />
      <Panel title="最近状态摘要" subtitle="先看结论，再看下方历史变化">
        {device ? (
          <InfoGrid>
            {cards.map(([label, value, hint, health]) => (
              <InfoCard key={label} label={label} value={value} hint={hint} tone={toneFromHealth(health)} />
            ))}
          </InfoGrid>
        ) : (
          <EmptyBox>从总览选择设备</EmptyBox>
        )}
      </Panel>
      <Panel title="命令响应" subtitle="最近 query_status 的 ACK 情况">
        <StreamList
          emptyText="暂无命令"
          rows={commands.slice(0, 18).map((command) => ({
            time: relativeTime(command.created_at),
            title: commandLatency(command),
            body: `${command.state || '-'} ${command.ack_message || command.command_id || ''}`,
          }))}
        />
      </Panel>
    </div>
  );
}

function MessageCenterSection({
  devices,
  busMessages,
  busChannels,
  targetDeviceId,
  channel,
  payload,
  message,
  loading,
  onTargetChange,
  onChannelChange,
  onPayloadChange,
  onSubmit,
  onRefresh,
}: {
  devices: CloudDeviceRow[];
  busMessages: CloudBusMessage[];
  busChannels: string[];
  targetDeviceId: string;
  channel: string;
  payload: string;
  message: string;
  loading: boolean;
  onTargetChange: (value: string) => void;
  onChannelChange: (value: string) => void;
  onPayloadChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onRefresh: () => void;
}) {
  const target = devices.find((device) => device.deviceId === targetDeviceId);

  return (
    <div className="grid gap-5 xl:grid-cols-[420px_1fr]">
      <Panel title="云端发送" subtitle="通过 MQTT inbox 给设备发送 notify 消息，设备本地决定如何显示">
        <form className="space-y-4" onSubmit={onSubmit}>
          <label className="block text-xs font-black text-slate-500" htmlFor="busTargetDevice">目标设备</label>
          <select
            id="busTargetDevice"
            className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none transition focus:border-teal-400 focus:ring-4 focus:ring-teal-100"
            value={targetDeviceId}
            onChange={(event) => onTargetChange(event.target.value)}
          >
            {devices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.displayName} / {device.statusText}
              </option>
            ))}
          </select>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="block text-xs font-black text-slate-500" htmlFor="busChannel">通道</label>
              <select
                id="busChannel"
                className="mt-2 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none transition focus:border-teal-400 focus:ring-4 focus:ring-teal-100"
                value={channel}
                onChange={(event) => onChannelChange(event.target.value)}
              >
                {busChannels.map((item) => (
                  <option key={item} value={item}>{item === 'notify' ? 'notify / OLED 通知' : item}</option>
                ))}
              </select>
            </div>
            <div>
              <span className="block text-xs font-black text-slate-500">当前目标</span>
              <div className="mt-2 inline-flex min-h-10 items-center rounded-full border border-slate-200 bg-slate-50 px-3 text-sm font-black text-slate-600">
                {target ? `${target.displayName} · ${target.statusText}` : '未选择'}
              </div>
            </div>
          </div>
          <label className="block text-xs font-black text-slate-500" htmlFor="busPayload">消息内容</label>
          <textarea
            id="busPayload"
            className="min-h-[180px] w-full rounded-lg border border-slate-200 px-3 py-3 text-sm outline-none transition focus:border-teal-400 focus:ring-4 focus:ring-teal-100"
            maxLength={256}
            value={payload}
            onChange={(event) => onPayloadChange(event.target.value)}
            placeholder="输入要显示在目标设备上的消息"
          />
          <button className="h-10 rounded-lg bg-slate-900 px-4 text-sm font-black text-white shadow-sm transition hover:-translate-y-px hover:bg-teal-700" type="submit">
            发送消息
          </button>
          <p className="text-sm font-bold text-slate-500">{message}</p>
        </form>
      </Panel>
      <Panel
        title="消息流水"
        subtitle="cloud / device 作为参与者的发布、转发和 ACK"
        action={
          <button className="h-10 rounded-lg border border-slate-200 bg-white px-4 text-sm font-black text-slate-700 shadow-sm transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800" type="button" onClick={onRefresh}>
            {loading ? '同步中' : '刷新流水'}
          </button>
        }
      >
        <StreamList
          emptyText="暂无消息"
          rows={busMessages.map((item) => ({
            time: relativeTime(item.created_at),
            title: busStateLabel(item.state),
            body: `${actorLabel(item.source_type, item.source_id, item.source_display_name, devices)} -> ${actorLabel(item.target_type, item.target_id, item.target_display_name, devices)} / ${text(item.channel)}: ${text(item.payload_text)}${item.ack_message ? ` · ${item.ack_message}` : ''}`,
          }))}
        />
      </Panel>
    </div>
  );
}

function CapabilitiesSection() {
  const groups = [
    {
      title: '云端已开放',
      value: 'MQTT 状态、query_status、消息中心',
      hint: '设备在线、AP/STA IP、BLE、WebSocket、ACK 历史；消息中心支持 cloud/device 参与者和 notify inbox。',
      tone: 'green',
      pill: '安全',
    },
    {
      title: '本地只读状态',
      value: 'health / stats / display / menu',
      hint: 'ESP32 本地 HTTP 已有 heap、restart_reason、通信计数、OLED、菜单状态；需要扩展 MQTT 才能云端稳定展示。',
      tone: 'yellow',
      pill: '可扩展',
    },
    {
      title: '本地通信调试',
      value: 'UART / BLE / WebSocket',
      hint: '本地支持 UART 文本/HEX、BLE notify/write、/ws UART 隧道；云端不直接接管实时隧道。',
      tone: 'yellow',
      pill: '现场',
    },
    {
      title: '网络与配网',
      value: 'AP / STA / APSTA / scan / connect',
      hint: '本地支持扫描、网页配网、模式切换、保存/清除 STA。云端切网络容易让设备失联，暂不开放。',
      tone: 'red',
      pill: '高风险',
    },
    {
      title: '电机诊断',
      value: 'diag / osc / params',
      hint: '本地支持读写寄存器、示波配置、参数表注册和读写。写操作会影响现场设备，云端先只做能力提示。',
      tone: 'red',
      pill: '高风险',
    },
    {
      title: '文件与参数表',
      value: 'Excel list / upload / delete',
      hint: 'ESP32 SPIFFS 可保存参数表。后续可考虑云端托管参数表，再由现场页面同步。',
      tone: 'yellow',
      pill: '后续',
    },
  ] satisfies { title: string; value: string; hint: string; tone: InfoTone; pill: string }[];

  return (
    <Panel title="能力清单" subtitle="依据 ESP32 固件本地 HTTP、WebSocket、BLE 和 MQTT 命令面整理">
      <InfoGrid>
        {groups.map((group) => (
          <InfoCard key={group.title} label={group.title} value={group.value} hint={group.hint} tone={group.tone} pill={group.pill} />
        ))}
      </InfoGrid>
      <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">
        云端当前只开放安全查询。会改变现场网络、写电机参数、启动示波、OTA、重启等动作应保留在局域网现场入口。
      </div>
    </Panel>
  );
}

function EventsSection({
  devices,
  selectedDeviceId,
  detail,
  onSelectDevice,
}: {
  devices: CloudDeviceRow[];
  selectedDeviceId: string;
  detail: CloudDeviceDetailResponse | null;
  onSelectDevice: (deviceId: string) => void;
}) {
  return (
    <div className="space-y-5">
      <DeviceSelector devices={devices} selectedDeviceId={selectedDeviceId} onSelect={onSelectDevice} />
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="最近事件" subtitle="status / availability / ack 原始记录">
          <StreamList
            emptyText={detail?.device ? '暂无事件' : '从总览选择设备'}
            rows={(detail?.events || []).slice(0, 80).map((event) => ({
              time: relativeTime(event.created_at),
              title: text(event.event_type),
              body: stringifyPayload(event.payload_json),
            }))}
          />
        </Panel>
        <Panel title="最近命令" subtitle="云端安全诊断命令记录">
          <StreamList
            emptyText={detail?.device ? '暂无命令' : '从总览选择设备'}
            rows={(detail?.commands || []).slice(0, 50).map((command) => ({
              time: relativeTime(command.created_at),
              title: text(command.state),
              body: `${text(command.command_type)} ${text(command.command_id)} ${command.ack_message || ''}`,
            }))}
          />
        </Panel>
      </div>
    </div>
  );
}

function SettingsSection({
  mqttConnected,
  generatedAt,
  selectedDeviceId,
  selectedRow,
}: {
  mqttConnected: boolean;
  generatedAt: string;
  selectedDeviceId: string;
  selectedRow: CloudDeviceRow | null;
}) {
  return (
    <div className="grid gap-5 xl:grid-cols-3">
      <Panel title="运行状态" subtitle="云端服务与 MQTT 入口">
        <InfoGrid columns="one">
          <InfoCard label="MQTT Broker" value={mqttConnected ? '已连接' : '未连接'} hint="设备通过 MQTT 上报状态和接收安全命令" tone={mqttConnected ? 'green' : 'red'} />
          <InfoCard label="最后同步" value={formatGeneratedAt(generatedAt)} hint="来自 /api/devices 的 generated_at" tone="gray" />
        </InfoGrid>
      </Panel>
      <Panel title="登录会话" subtitle="当前控制台账户">
        <InfoGrid columns="one">
          <InfoCard label="用户" value="Admin" hint="admin@admin.com" tone="green" />
          <InfoCard label="退出入口" value="/logout" hint="右上角用户菜单可退出登录" tone="gray" />
        </InfoGrid>
      </Panel>
      <Panel title="入口策略" subtitle="云端与现场入口边界">
        <InfoGrid columns="one">
          <InfoCard label="当前设备" value={selectedRow?.displayName || selectedDeviceId || '-'} hint={selectedDeviceId || '未选择设备'} tone="gray" />
          <InfoCard label="远程控制台" value={selectedDeviceId ? cloudDeviceConsolePath(selectedDeviceId) : '-'} hint="云端页面保留安全入口；现场高风险操作仍走局域网页面" tone="yellow" />
        </InfoGrid>
      </Panel>
    </div>
  );
}

function DeviceDetails({
  device,
  selectedRow,
  latestPayload,
  displayNameDraft,
  actionMessage,
  onDisplayNameChange,
  onSaveDisplayName,
}: {
  device?: CloudDeviceRecord;
  selectedRow: CloudDeviceRow | null;
  latestPayload: Record<string, unknown>;
  displayNameDraft: string;
  actionMessage: string;
  onDisplayNameChange: (value: string) => void;
  onSaveDisplayName: (event: FormEvent<HTMLFormElement>) => void;
}) {
  if (!device && !selectedRow) return <EmptyBox>从总览选择设备</EmptyBox>;
  const mergedDevice = device || {};
  const deviceId = mergedDevice.device_id || selectedRow?.deviceId || '-';
  const displayName = mergedDevice.display_name || selectedRow?.displayName || deviceId;
  const detailItems = [
    ['设备名', displayName],
    ['设备标识', deviceId],
    ['硬件 MAC', mergedDevice.device_mac || payloadValue(latestPayload, 'device_mac') || selectedRow?.deviceMac],
    ['云端状态', stateLabel(mergedDevice.cloud_state || selectedRow?.cloudState)],
    ['最后心跳', relativeTime(mergedDevice.last_seen_at) || selectedRow?.lastSeen],
    ['网络模式', currentText(mergedDevice, payloadValue(latestPayload, 'net_mode') || mergedDevice.net_mode || selectedRow?.network, '未知')],
    ['STA 连接', currentBoolText(mergedDevice, payloadValue(latestPayload, 'sta_connected') ?? mergedDevice.sta_connected, '已连接', '未连接')],
    ['STA 配置', currentBoolText(mergedDevice, payloadValue(latestPayload, 'sta_configured') ?? mergedDevice.sta_configured, '已保存', '未保存')],
    ['STA 正在连接', currentBoolText(mergedDevice, payloadValue(latestPayload, 'sta_connecting') ?? mergedDevice.sta_connecting, '连接中', '空闲')],
    ['STA IP', currentText(mergedDevice, payloadValue(latestPayload, 'sta_ip') || mergedDevice.sta_ip || selectedRow?.staIp)],
    ['AP IP', currentText(mergedDevice, payloadValue(latestPayload, 'ap_ip') || mergedDevice.ap_ip || selectedRow?.apIp)],
    ['通信模式', currentText(mergedDevice, payloadValue(latestPayload, 'comm_mode') || mergedDevice.comm_mode || selectedRow?.commMode, '未知')],
    ['UART', currentText(mergedDevice, payloadValue(latestPayload, 'uart_baud') || mergedDevice.uart_baud || selectedRow?.uartBaud)],
    ['BLE', currentBoolText(mergedDevice, payloadValue(latestPayload, 'ble_ready') ?? mergedDevice.ble_ready, '已启动', '未启动')],
    ['WebSocket', currentBoolText(mergedDevice, payloadValue(latestPayload, 'wifi_ws_client') ?? mergedDevice.wifi_ws_client, '有客户端', '无客户端')],
    ['运行时长', isDeviceOnline(mergedDevice) ? formatUptime(payloadValue(latestPayload, 'uptime_ms') || mergedDevice.uptime_ms) : '-'],
    ['固件', mergedDevice.fw_version || selectedRow?.firmware || '-'],
  ] satisfies [string, unknown][];

  return (
    <div className="space-y-5">
      <form className="grid gap-3 md:grid-cols-[1fr_auto]" onSubmit={onSaveDisplayName}>
        <div>
          <label className="block text-xs font-black text-slate-500" htmlFor="displayNameInput">设备名</label>
          <input
            id="displayNameInput"
            className="mt-2 h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none transition focus:border-teal-400 focus:ring-4 focus:ring-teal-100"
            maxLength={128}
            value={displayNameDraft}
            onChange={(event) => onDisplayNameChange(event.target.value)}
            placeholder="ESP32-001"
          />
          <p className="mt-2 text-xs font-bold text-slate-500">设备名不能重复；未填写时系统会自动分配 ESP32-001 这种名称。</p>
        </div>
        <button className="mt-6 h-10 rounded-lg border border-slate-200 bg-white px-4 text-sm font-black text-slate-700 shadow-sm transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800" type="submit">
          保存设备名
        </button>
      </form>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {detailItems.map(([label, value]) => (
          <KvCard key={label} label={label} value={text(value)} />
        ))}
      </div>
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-600">
        云端只保留安全诊断操作。网络模式、配网和固件升级仍由现场入口处理。
      </div>
      {actionMessage && <p className="text-sm font-bold text-slate-500">{actionMessage}</p>}
    </div>
  );
}

function DiagnosticSummary({ device, history }: { device?: CloudDeviceRecord; history: CloudDeviceHistoryResponse | null }) {
  if (!device) return <EmptyBox>从总览选择设备</EmptyBox>;
  const reasons = Array.isArray(device.diagnostic_reasons) ? device.diagnostic_reasons : [];
  const summary = history?.summary || {};
  const statusAge = numberValue(device.status_age_seconds);
  const cards = [
    ['健康评分', `${numberValue(device.health_score) ?? 0} 分`, device.diagnostic_text || diagnosticLevelText(device.diagnostic_level), diagnosticTone(device.diagnostic_level)],
    ['诊断级别', diagnosticLevelText(device.diagnostic_level), reasons[0] || '暂无诊断原因', diagnosticTone(device.diagnostic_level)],
    ['心跳年龄', statusAge === undefined ? '-' : `${statusAge} 秒`, `最后心跳 ${relativeTime(device.last_seen_at)}`, statusAge !== undefined && statusAge <= 20 ? 'green' : 'yellow'],
    ['命令质量', `${summary.acked_count || 0}/${summary.command_count || 0} ACK`, `平均延迟 ${summary.avg_latency_ms === null || summary.avg_latency_ms === undefined ? '-' : `${summary.avg_latency_ms} ms`}`, summary.failed_count ? 'red' : 'green'],
    ['关注事项', `${reasons.length} 项`, reasons.slice(0, 3).join('；') || '暂无', diagnosticTone(device.diagnostic_level)],
    ['安全边界', '只读云端', '配网、写参数、OTA、重启保留在现场入口', 'green'],
  ] satisfies [string, string, string, InfoTone][];

  return (
    <InfoGrid>
      {cards.map(([label, value, hint, tone]) => (
        <InfoCard key={label} label={label} value={value} hint={hint} tone={tone} />
      ))}
    </InfoGrid>
  );
}

function SystemResources({ device }: { device?: CloudDeviceRecord }) {
  if (!device) return <EmptyBox>从总览选择设备</EmptyBox>;
  const hasExtendedStatus = [
    device.heap_free,
    device.restart_reason,
    device.display_status,
    device.motor_param_count,
  ].some((value) => value !== null && value !== undefined && value !== '');
  if (!hasExtendedStatus) return <EmptyBox>等待扩展状态上报</EmptyBox>;

  const internalHeapOk = device.heap_internal_free === null || device.heap_internal_free === undefined || device.heap_internal_free >= 32000;
  const cards = [
    ['可用堆内存', formatBytes(device.heap_free), `最低 ${formatBytes(device.heap_min_free)}，最大块 ${formatBytes(device.heap_largest)}`, internalHeapOk ? 'green' : 'yellow'],
    ['内部堆内存', formatBytes(device.heap_internal_free), `内部最低 ${formatBytes(device.heap_internal_min_free)}`, internalHeapOk ? 'green' : 'red'],
    ['重启原因', text(device.restart_reason), 'ESP-IDF reset reason code', device.restart_reason === null || device.restart_reason === undefined || device.restart_reason === 1 ? 'green' : 'yellow'],
    ['通信错误', `${device.comm_error_total ?? 0}`, 'UART/BLE/WiFi/router 错误与丢弃累计', (device.comm_error_total || 0) === 0 ? 'green' : 'red'],
    ['OLED 状态', text(device.display_status), device.display_backend || 'display backend', device.display_enabled === false ? 'red' : 'green'],
    ['参数数量', `${device.motor_param_count ?? '-'}/${device.motor_param_capacity ?? '-'}`, '电机参数表注册容量', 'green'],
  ] satisfies [string, string, string, InfoTone][];

  return (
    <InfoGrid>
      {cards.map(([label, value, hint, tone]) => (
        <InfoCard key={label} label={label} value={value} hint={hint} tone={tone} />
      ))}
    </InfoGrid>
  );
}

function DeviceSelector({
  devices,
  selectedDeviceId,
  onSelect,
}: {
  devices: CloudDeviceRow[];
  selectedDeviceId: string;
  onSelect: (deviceId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white px-5 py-4 shadow-lg shadow-slate-200/60 md:flex-row md:items-center md:justify-between">
      <div>
        <div className="text-sm font-black text-slate-900">当前设备</div>
        <p className="mt-1 text-sm text-slate-500">这些页面都围绕单台设备展开，先选设备再看详情。</p>
      </div>
      <select
        className="h-10 min-w-[260px] rounded-lg border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none transition focus:border-teal-400 focus:ring-4 focus:ring-teal-100"
        value={selectedDeviceId}
        onChange={(event) => onSelect(event.target.value)}
      >
        {devices.length ? (
          devices.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.displayName} / {device.statusText}
            </option>
          ))
        ) : (
          <option value="">暂无设备</option>
        )}
      </select>
    </div>
  );
}

function DeviceTablePanel({
  title,
  hint,
  error,
  devices,
  filter,
  stateFilter,
  onFilterChange,
  onStateFilterChange,
  onSelectDevice,
}: {
  title: string;
  hint: string;
  error: string;
  devices: CloudDeviceRow[];
  filter: string;
  stateFilter: string;
  onFilterChange: (value: string) => void;
  onStateFilterChange: (value: string) => void;
  onSelectDevice: (deviceId: string, section?: PlatformSection) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl shadow-slate-200/70">
      <div className="flex flex-col gap-4 border-b border-slate-200 px-5 py-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h3 className="text-xl font-black">{title}</h3>
          <p className="mt-1 text-sm text-slate-500">{hint}</p>
          {error && <p className="mt-1 text-sm font-bold text-rose-600">{error}</p>}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none transition focus:border-teal-400 focus:ring-4 focus:ring-teal-100 sm:w-64"
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
            placeholder="搜索设备 ID / MAC / 备注 / IP"
          />
          <select
            className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none transition focus:border-teal-400 focus:ring-4 focus:ring-teal-100"
            value={stateFilter}
            onChange={(event) => onStateFilterChange(event.target.value)}
          >
            <option value="all">全部</option>
            <option value="online">在线</option>
            <option value="offline">离线</option>
            <option value="unknown">未知</option>
          </select>
        </div>
      </div>

      <div className="lg:hidden" aria-label="移动端设备列表">
        <div className="space-y-3 px-4 py-4">
          {devices.length ? (
            devices.map((device) => (
              <div key={device.deviceId} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:border-teal-200 hover:bg-teal-50/60">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="break-words text-base font-black text-slate-950">{device.displayName}</div>
                    <div className="mt-1 break-all font-mono text-xs font-bold text-slate-500">{device.deviceId}</div>
                  </div>
                  <StatePill device={device} />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <MobileDeviceFact label="网络" value={device.network} />
                  <MobileDeviceFact label="健康" value={device.health} />
                  <MobileDeviceFact label="STA IP" value={device.staIp} />
                  <MobileDeviceFact label="AP IP" value={device.apIp} />
                  <MobileDeviceFact label="BLE" value={device.bleState} />
                  <MobileDeviceFact label="WS" value={device.wsState} />
                </div>
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    className="h-9 flex-1 rounded-lg bg-slate-900 px-3 text-sm font-black text-white transition hover:bg-teal-700"
                    onClick={() => onSelectDevice(device.deviceId, 'devices')}
                  >
                    查看详情
                  </button>
                  <a
                    className="inline-flex h-9 flex-1 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-black text-slate-700 shadow-sm transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800"
                    href={cloudDeviceConsolePath(device.deviceId)}
                    aria-label={`打开控制台 ${device.displayName}`}
                  >
                    控制台
                  </a>
                </div>
              </div>
            ))
          ) : (
            <EmptyBox>暂无数据</EmptyBox>
          )}
        </div>
      </div>

      <div className="hidden overflow-x-auto px-5 py-4 lg:block">
        <table className="min-w-[1320px] w-full text-left text-sm">
          <thead className="text-slate-500">
            <tr>
              <TableHead>设备名</TableHead>
              <TableHead>控制台</TableHead>
              <TableHead>设备 ID</TableHead>
              <TableHead>硬件 MAC</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>健康</TableHead>
              <TableHead>网络</TableHead>
              <TableHead>STA IP</TableHead>
              <TableHead>AP IP</TableHead>
              <TableHead>通信</TableHead>
              <TableHead>BLE</TableHead>
              <TableHead>WS</TableHead>
              <TableHead>UART</TableHead>
              <TableHead>固件</TableHead>
              <TableHead>最后心跳</TableHead>
            </tr>
          </thead>
          <tbody>
            {devices.length ? (
              devices.map((device) => (
                <tr
                  key={device.deviceId}
                  className={`cursor-pointer border-t border-slate-100 transition hover:bg-teal-50 ${
                    device.online ? 'bg-teal-50/60' : ''
                  }`}
                  onClick={() => onSelectDevice(device.deviceId, 'devices')}
                >
                  <TableCell strong>{device.displayName}</TableCell>
                  <TableCell>
                    <a
                      className="inline-flex h-8 items-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-700 shadow-sm transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800"
                      href={cloudDeviceConsolePath(device.deviceId)}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={`打开控制台 ${device.displayName}`}
                    >
                      控制台
                    </a>
                  </TableCell>
                  <TableCell mono>{device.deviceId}</TableCell>
                  <TableCell mono>{device.deviceMac}</TableCell>
                  <TableCell><StatePill device={device} /></TableCell>
                  <TableCell>{device.health}</TableCell>
                  <TableCell>{device.network}</TableCell>
                  <TableCell>{device.staIp}</TableCell>
                  <TableCell>{device.apIp}</TableCell>
                  <TableCell>{device.commMode}</TableCell>
                  <TableCell><SignalPill value={device.bleState} /></TableCell>
                  <TableCell><SignalPill value={device.wsState} negative={device.wsState === '未接入'} /></TableCell>
                  <TableCell>{device.uartBaud}</TableCell>
                  <TableCell>{device.firmware}</TableCell>
                  <TableCell>{device.lastSeen}</TableCell>
                </tr>
              ))
            ) : (
              <tr>
                <td className="px-3 py-10 text-center text-sm font-bold text-slate-400" colSpan={15}>暂无数据</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-xl shadow-slate-200/70">
      <div className="mb-5 flex flex-col gap-3 border-b border-slate-100 pb-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="text-xl font-black">{title}</h3>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-lg shadow-slate-200/60 transition hover:-translate-y-0.5 hover:shadow-xl">
      <div className="text-sm font-bold text-slate-500">{label}</div>
      <div className="mt-3 text-3xl font-black">{value}</div>
    </div>
  );
}

function StatusBadge({ label, tone }: { label: string; tone: 'green' | 'red' }) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-bold sm:px-4 sm:text-sm ${
      tone === 'green'
        ? 'border-emerald-100 bg-emerald-50 text-emerald-700'
        : 'border-rose-100 bg-rose-50 text-rose-700'
    }`}>
      <i className={`h-2 w-2 rounded-full ${tone === 'green' ? 'bg-emerald-500' : 'bg-rose-500'}`} />
      {label}
    </span>
  );
}

function MobileDeviceFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-xs font-black text-slate-400">{label}</div>
      <div className="mt-1 truncate text-sm font-black text-slate-800">{value}</div>
    </div>
  );
}

type InfoTone = 'green' | 'yellow' | 'red' | 'gray';
type InfoCardData = [label: string, value: string, hint: string, health: boolean | null];

function InfoGrid({ children, columns = 'auto' }: { children: ReactNode; columns?: 'auto' | 'one' }) {
  return <div className={`grid gap-3 ${columns === 'one' ? 'grid-cols-1' : 'md:grid-cols-2 2xl:grid-cols-3'}`}>{children}</div>;
}

function InfoCard({
  label,
  value,
  hint,
  tone = 'gray',
  pill,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: InfoTone;
  pill?: string;
}) {
  const styles = {
    green: 'border-emerald-100 bg-emerald-50 text-emerald-700',
    yellow: 'border-amber-100 bg-amber-50 text-amber-700',
    red: 'border-rose-100 bg-rose-50 text-rose-700',
    gray: 'border-slate-100 bg-slate-50 text-slate-600',
  } satisfies Record<InfoTone, string>;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 transition hover:-translate-y-0.5 hover:border-teal-200 hover:shadow-lg">
      <span className="text-xs font-black text-slate-500">{label}</span>
      <strong className="mt-2 block break-words text-lg font-black text-slate-950">{value}</strong>
      <p className="mt-2 min-h-10 text-sm leading-5 text-slate-500">{hint}</p>
      <em className={`mt-3 inline-flex rounded-full border px-2 py-1 text-xs not-italic font-black ${styles[tone]}`}>
        {pill || toneLabel(tone)}
      </em>
    </div>
  );
}

function KvCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
      <span className="text-xs font-black text-slate-500">{label}</span>
      <strong className="mt-1 block break-words text-sm font-black text-slate-900">{value}</strong>
    </div>
  );
}

function StreamList({
  rows,
  emptyText,
}: {
  rows: { time: string; title: string; body: string }[];
  emptyText: string;
}) {
  if (!rows.length) return <EmptyBox>{emptyText}</EmptyBox>;
  return (
    <div className="max-h-[520px] space-y-2 overflow-auto">
      {rows.map((row, index) => (
        <div key={`${row.time}-${row.title}-${index}`} className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 transition hover:border-teal-200 hover:bg-teal-50/70 lg:grid-cols-[120px_96px_1fr]">
          <span className="text-xs font-bold text-slate-500">{row.time}</span>
          <strong className="text-sm font-black text-slate-900">{row.title}</strong>
          <code className="break-all font-mono text-xs text-slate-600">{row.body}</code>
        </div>
      ))}
    </div>
  );
}

function EmptyBox({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm font-bold text-slate-400">{children}</div>;
}

function InlineAlert({ children, tone = 'red' }: { children: ReactNode; tone?: 'red' | 'blue' }) {
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm font-bold ${
      tone === 'blue'
        ? 'border-blue-100 bg-blue-50 text-blue-700'
        : 'border-rose-100 bg-rose-50 text-rose-700'
    }`}>
      {children}
    </div>
  );
}

function StatePill({ device }: { device: CloudDeviceRow }) {
  const tone = device.cloudState === 'online' ? 'green' : device.cloudState === 'offline' ? 'red' : 'gray';
  return <SignalPill value={device.statusText} tone={tone} />;
}

function SignalPill({
  value,
  tone,
  negative = false,
}: {
  value: string;
  tone?: 'green' | 'red' | 'gray';
  negative?: boolean;
}) {
  if (value === '-') return <span className="text-slate-400">-</span>;
  const resolvedTone = tone || (negative || value.includes('未') ? 'red' : 'green');
  const classes = resolvedTone === 'green'
    ? 'bg-emerald-50 text-emerald-700'
    : resolvedTone === 'red'
      ? 'bg-rose-50 text-rose-700'
      : 'bg-slate-100 text-slate-500';
  const dot = resolvedTone === 'green'
    ? 'bg-emerald-500'
    : resolvedTone === 'red'
      ? 'bg-rose-500'
      : 'bg-slate-400';
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-2 py-1 text-xs font-black ${classes}`}>
      <i className={`h-2 w-2 rounded-full ${dot}`} />
      {value}
    </span>
  );
}

function TableHead({ children }: { children: ReactNode }) {
  return <th className="whitespace-nowrap px-3 py-4 text-xs font-black">{children}</th>;
}

function TableCell({
  children,
  mono = false,
  strong = false,
}: {
  children: ReactNode;
  mono?: boolean;
  strong?: boolean;
}) {
  return (
    <td className={`whitespace-nowrap px-3 py-4 align-middle ${
      mono ? 'font-mono text-xs' : ''
    } ${strong ? 'font-black' : 'text-slate-800'}`}>
      {children}
    </td>
  );
}

function text(value: unknown, fallback = '-'): string {
  const resolved = String(value ?? '').trim();
  return resolved || fallback;
}

function numberValue(value: unknown): number | undefined {
  const resolved = Number(value);
  return Number.isFinite(resolved) ? resolved : undefined;
}

function payloadValue(payload: Record<string, unknown>, key: string): unknown {
  return payload[key];
}

function relativeTime(value?: string): string {
  if (!value) return '-';
  const delta = Date.now() - new Date(value).getTime();
  if (Number.isNaN(delta)) return '-';
  if (delta < 5000) return '刚刚';
  if (delta < 60000) return `${Math.floor(delta / 1000)} 秒前`;
  if (delta < 3600000) return `${Math.floor(delta / 60000)} 分钟前`;
  if (delta < 86400000) return `${Math.floor(delta / 3600000)} 小时前`;
  return `${Math.floor(delta / 86400000)} 天前`;
}

function stateLabel(value?: string): string {
  return {
    online: '在线',
    offline: '离线',
    unknown: '未知',
  }[value || ''] || '未知';
}

function commandLatency(command: CloudDeviceCommand): string {
  if (command.latency_ms !== undefined && command.latency_ms !== null) {
    if (command.latency_ms < 1000) return `${command.latency_ms} ms`;
    return `${(command.latency_ms / 1000).toFixed(1)} s`;
  }
  if (!command.created_at || !command.ack_at) return '-';
  const delta = new Date(command.ack_at).getTime() - new Date(command.created_at).getTime();
  if (!Number.isFinite(delta) || delta < 0) return '-';
  if (delta < 1000) return `${delta} ms`;
  return `${(delta / 1000).toFixed(1)} s`;
}

function formatUptime(ms: unknown): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '-';
  const seconds = Math.floor(value / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
}

function formatBytes(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function boolText(value: unknown, yes = '是', no = '否'): string {
  return value === true ? yes : no;
}

function isDeviceOnline(device?: CloudDeviceRecord): boolean {
  return device?.cloud_state === 'online';
}

function currentText(device: CloudDeviceRecord | undefined, value: unknown, unknown = '-'): string {
  if (!isDeviceOnline(device)) return unknown;
  return text(value);
}

function currentBoolText(device: CloudDeviceRecord | undefined, value: unknown, yes: string, no: string): string {
  if (!isDeviceOnline(device)) return '未知';
  if (value === null || value === undefined) return '未知';
  return boolText(value, yes, no);
}

function currentHealth(device: CloudDeviceRecord | undefined, value: unknown): boolean | null {
  if (!isDeviceOnline(device) || value === null || value === undefined) return null;
  return value === true;
}

function diagnosticLevelText(level?: string): string {
  return {
    normal: '正常',
    attention: '关注',
    warning: '检查',
    offline: '离线',
    unknown: '未知',
  }[level || ''] || '未知';
}

function diagnosticTone(level?: string): InfoTone {
  if (level === 'normal') return 'green';
  if (level === 'attention') return 'yellow';
  if (level === 'warning' || level === 'offline') return 'red';
  return 'yellow';
}

function toneFromHealth(value: boolean | null): InfoTone {
  if (value === true) return 'green';
  if (value === false) return 'red';
  return 'yellow';
}

function toneLabel(tone: InfoTone): string {
  return {
    green: '正常',
    yellow: '参考',
    red: '注意',
    gray: '状态',
  }[tone];
}

function busStateLabel(value?: string): string {
  return {
    PENDING: '待发布',
    PUBLISHED: '已发布',
    ACKED: '已确认',
    FAILED: '失败',
  }[value || ''] || value || '未知';
}

function actorLabel(type: string | undefined, id: string | undefined, displayName: string | undefined, devices: CloudDeviceRow[]): string {
  if (type === 'cloud') return '云平台';
  const device = devices.find((item) => item.deviceId === id);
  return displayName || device?.displayName || id || '-';
}

function latestStatusPayload(
  detail: CloudDeviceDetailResponse | null,
  history: CloudDeviceHistoryResponse | null,
): Record<string, unknown> {
  const detailPayload = detail?.device?.last_status_json;
  if (detailPayload && typeof detailPayload === 'object') return detailPayload;
  const points = history?.status_points || [];
  return points.length ? points[points.length - 1] : {};
}

function transitionCount(points: CloudStatusPoint[], field: keyof CloudStatusPoint): number {
  let count = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (points[index][field] !== points[index - 1][field]) count += 1;
  }
  return count;
}

function trendCards(
  device: CloudDeviceRecord,
  statusPoints: CloudStatusPoint[],
  commands: CloudDeviceCommand[],
  summary: CloudHistorySummary,
  latestPayload: Record<string, unknown>,
): InfoCardData[] {
  const latestPoint = statusPoints.length ? statusPoints[statusPoints.length - 1] : latestPayload;
  const commandWithLatency = commands.find((command) => command.latency_ms !== null && command.latency_ms !== undefined);
  const staKnown = device.cloud_state === 'online' && latestPoint.sta_connected !== null && latestPoint.sta_connected !== undefined;
  const changes = transitionCount(statusPoints, 'sta_connected');
  const avgLatency = summary.avg_latency_ms === null || summary.avg_latency_ms === undefined ? '-' : `${summary.avg_latency_ms} ms`;
  return [
    ['云端状态', stateLabel(device.cloud_state), `最后心跳 ${relativeTime(device.last_seen_at)}`, device.cloud_state === 'online'],
    ['STA 当前', staKnown ? boolText(latestPoint.sta_connected, '已连接', '未连接') : '未知', staKnown ? text(latestPoint.sta_ip || device.sta_ip, '无 STA IP') : '设备不在线时当前状态不可判断', staKnown ? latestPoint.sta_connected === true : null],
    ['连接变化', `${changes} 次`, `${summary.status_count || statusPoints.length} 条状态上报`, changes === 0 ? true : null],
    ['ACK 延迟', commandWithLatency ? commandLatency(commandWithLatency) : '-', `平均 ${avgLatency}，ACK ${summary.acked_count || 0}/${summary.command_count || commands.length}`, summary.failed_count ? false : true],
  ];
}

function stringifyPayload(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 0);
  } catch {
    return text(value);
  }
}
