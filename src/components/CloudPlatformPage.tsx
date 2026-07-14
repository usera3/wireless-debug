import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  cloudDeviceConsolePath,
  cloudPlatformApiUrl,
  isAuthRequiredResponse,
  normalizeCloudDevice,
  type CloudDeviceRecord,
  type CloudDeviceRow,
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
    desc: '查看设备身份、硬件地址、固件版本和云端控制台入口',
  },
  connections: {
    title: '连接管理',
    desc: '查看 AP/STA 地址、通信模式、BLE 与 WebSocket 接入状态',
  },
  history: {
    title: '连接历史',
    desc: '查看设备在线、离线和重连记录',
  },
  messages: {
    title: '消息中心',
    desc: '查看云平台与设备之间的消息收发状态',
  },
  capabilities: {
    title: '能力清单',
    desc: '查看当前云端控制台已接入的设备能力',
  },
  events: {
    title: '事件记录',
    desc: '查看设备状态上报、命令回执和诊断事件',
  },
  settings: {
    title: '系统设置',
    desc: '查看云端控制台运行状态和登录会话',
  },
};

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(cloudPlatformApiUrl(path), { cache: 'no-store' });
  if (isAuthRequiredResponse(response.status)) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.hash)}`;
    throw new Error('authentication required');
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
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

  const activeCopy = SECTION_COPY[activeSection];
  const showMetrics = activeSection === 'overview';
  const showDeviceTable = activeSection === 'overview'
    || activeSection === 'devices'
    || activeSection === 'connections';
  const tableTitle = activeSection === 'connections' ? '连接状态' : '设备总览';

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
                      onClick={() => setActiveSection(item.id)}
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

        <div className="min-w-0 flex-1">
          <header className="flex h-[104px] items-center justify-between border-b border-slate-200 bg-white px-6 lg:px-10">
            <div>
              <h1 className="text-2xl font-black tracking-tight">无线调试云端观测台</h1>
              <p className="mt-2 text-sm text-slate-500">多设备状态、历史事件、诊断回执集中查看</p>
            </div>
            <div className="flex items-center gap-3">
              <StatusBadge label={mqttConnected ? 'MQTT 已连接' : 'MQTT 未连接'} tone={mqttConnected ? 'green' : 'red'} />
              <span className="hidden rounded-full border border-teal-100 bg-teal-50 px-4 py-2 text-sm font-bold text-teal-700 md:inline-flex">
                同步 {formatGeneratedAt(generatedAt)}
              </span>
              <button
                className="h-10 rounded-lg border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 shadow-sm transition hover:-translate-y-px hover:border-teal-200 hover:bg-teal-50 hover:text-teal-800"
                onClick={() => setRefreshSeq((value) => value + 1)}
              >
                刷新
              </button>
              <div className="user-menu relative">
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
                <div className={`absolute right-0 z-20 mt-2 w-40 rounded-lg border border-slate-200 bg-white p-2 text-sm shadow-xl ${userMenuOpen ? 'block' : 'hidden'}`}>
                  <a className="block rounded-md px-3 py-2 font-bold text-slate-600 hover:bg-slate-50" href="/logout">
                    退出登录
                  </a>
                </div>
              </div>
            </div>
          </header>

          <main className="min-h-[calc(100vh-104px)] bg-gradient-to-br from-teal-50 via-slate-50 to-blue-50 px-5 py-8 lg:px-9">
            <section className="mx-auto max-w-[1380px]">
              <div className="mb-7">
                <h2 className="text-2xl font-black">{activeCopy.title}</h2>
                <p className="mt-2 text-sm text-slate-500">{activeCopy.desc}</p>
              </div>

              {showMetrics && (
                <div className="mb-8 grid gap-4 md:grid-cols-4">
                  <Metric label="设备总数" value={summary.total} />
                  <Metric label="在线" value={summary.online} />
                  <Metric label="离线" value={summary.offline} />
                  <Metric label="未知" value={summary.unknown} />
                </div>
              )}

              {showDeviceTable ? (
                <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl shadow-slate-200/70">
                <div className="flex flex-col gap-4 border-b border-slate-200 px-5 py-4 xl:flex-row xl:items-center xl:justify-between">
                  <div>
                    <h3 className="text-xl font-black">{tableTitle}</h3>
                    <p className="mt-1 text-sm text-slate-500">
                      {loading ? '正在同步设备...' : `${visibleDevices.length} 台设备`}
                    </p>
                    {error && <p className="mt-1 text-sm font-bold text-rose-600">{error}</p>}
                  </div>
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <input
                      className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none transition focus:border-teal-400 focus:ring-4 focus:ring-teal-100 sm:w-64"
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                      placeholder="搜索设备 ID / MAC / 备注 / IP"
                    />
                    <select
                      className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 outline-none transition focus:border-teal-400 focus:ring-4 focus:ring-teal-100"
                      value={stateFilter}
                      onChange={(event) => setStateFilter(event.target.value)}
                    >
                      <option value="all">全部</option>
                      <option value="online">在线</option>
                      <option value="offline">离线</option>
                      <option value="unknown">未知</option>
                    </select>
                  </div>
                </div>

                <div className="overflow-x-auto px-5 py-4">
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
                      {visibleDevices.map((device) => (
                        <tr
                          key={device.deviceId}
                          className={`border-t border-slate-100 transition hover:bg-teal-50 ${
                            device.online ? 'bg-teal-50/60' : ''
                          }`}
                        >
                          <TableCell strong>{device.displayName}</TableCell>
                          <TableCell>
                            <a
                              className="inline-flex h-8 items-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-black text-slate-700 shadow-sm transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800"
                              href={cloudDeviceConsolePath(device.deviceId)}
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
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              ) : (
                <EmptySection section={activeSection} devices={devices} mqttConnected={mqttConnected} />
              )}
            </section>
          </main>
        </div>
      </div>
    </div>
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
    <span className={`hidden items-center gap-2 rounded-full border px-4 py-2 text-sm font-bold md:inline-flex ${
      tone === 'green'
        ? 'border-emerald-100 bg-emerald-50 text-emerald-700'
        : 'border-rose-100 bg-rose-50 text-rose-700'
    }`}>
      <i className={`h-2 w-2 rounded-full ${tone === 'green' ? 'bg-emerald-500' : 'bg-rose-500'}`} />
      {label}
    </span>
  );
}

function EmptySection({
  section,
  devices,
  mqttConnected,
}: {
  section: PlatformSection;
  devices: CloudDeviceRow[];
  mqttConnected: boolean;
}) {
  if (section === 'capabilities') {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <CapabilityCard title="设备状态上报" value={`${devices.length} 台设备`} />
        <CapabilityCard title="MQTT 通道" value={mqttConnected ? '已连接' : '未连接'} />
        <CapabilityCard title="远程控制台" value="已启用" />
        <CapabilityCard title="参数表服务" value="已启用" />
      </div>
    );
  }

  const emptyText: Record<PlatformSection, string> = {
    overview: '',
    devices: '',
    connections: '',
    history: '暂无连接历史记录',
    messages: '暂无消息记录',
    capabilities: '',
    events: '暂无事件记录',
    settings: '当前登录用户：Admin',
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-6 py-12 text-center shadow-xl shadow-slate-200/70">
      <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-lg bg-teal-50 text-sm font-black text-teal-700">
        {SECTION_COPY[section].title.slice(0, 2)}
      </div>
      <h3 className="text-lg font-black">{SECTION_COPY[section].title}</h3>
      <p className="mt-2 text-sm text-slate-500">{emptyText[section]}</p>
    </div>
  );
}

function CapabilityCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-lg shadow-slate-200/60">
      <div className="text-sm font-bold text-slate-500">{title}</div>
      <div className="mt-3 text-xl font-black text-slate-950">{value}</div>
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
