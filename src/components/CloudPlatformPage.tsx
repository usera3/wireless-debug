import { useEffect, useMemo, useState } from 'react';
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
  summary?: {
    total?: number;
    online?: number;
    offline?: number;
    unknown?: number;
  };
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(cloudPlatformApiUrl(path), { cache: 'no-store' });
  if (isAuthRequiredResponse(response.status)) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.hash)}`;
    throw new Error('authentication required');
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export function CloudPlatformPage() {
  const [devices, setDevices] = useState<CloudDeviceRow[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await fetchJson<DeviceListResponse>('/api/devices');
        if (!cancelled) {
          setDevices((data.devices || []).map(normalizeCloudDevice));
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
  }, []);

  const visibleDevices = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return devices;
    return devices.filter((device) => [
      device.deviceId,
      device.displayName,
      device.network,
      device.staIp,
      device.apIp,
    ].some((value) => value.toLowerCase().includes(needle)));
  }, [devices, filter]);

  const online = devices.filter((device) => device.online).length;
  const offline = devices.length - online;

  return (
    <section className="min-h-full bg-slate-50 text-slate-950">
      <div className="mx-auto max-w-7xl px-6 py-8">
        <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="text-2xl font-black">无线调试云端观测台</h2>
            <p className="mt-1 text-sm text-slate-500">
              按设备名、网络状态和实时心跳集中管理 ESP32 无线调试终端
            </p>
          </div>
          <button
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-bold shadow-sm hover:bg-slate-50"
            onClick={() => window.location.reload()}
          >
            刷新
          </button>
        </div>

        <div className="mb-6 grid gap-4 md:grid-cols-4">
          <Metric label="设备总数" value={devices.length} />
          <Metric label="在线" value={online} />
          <Metric label="离线" value={offline} />
          <Metric label="未知" value={0} />
        </div>

        <div className="rounded-xl border border-slate-200 bg-white shadow-xl shadow-slate-200/60">
          <div className="flex flex-col gap-3 border-b border-slate-200 p-5 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="text-lg font-black">设备总览</h3>
              <p className="text-sm text-slate-500">
                {loading ? '正在同步设备...' : `${visibleDevices.length} 台设备`}
              </p>
              {error && <p className="mt-1 text-sm font-bold text-rose-600">{error}</p>}
            </div>
            <input
              className="h-10 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-teal-400"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="搜索设备 ID / 名称 / IP"
            />
          </div>
          <div className="overflow-x-auto p-5">
            <table className="w-full min-w-[920px] text-left text-sm">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-3">设备名</th>
                  <th>控制台</th>
                  <th>设备 ID</th>
                  <th>状态</th>
                  <th>网络</th>
                  <th>STA IP</th>
                  <th>AP IP</th>
                  <th>BLE</th>
                  <th>WS</th>
                  <th>最后心跳</th>
                </tr>
              </thead>
              <tbody>
                {visibleDevices.map((device) => (
                  <tr key={device.deviceId} className="border-t border-slate-100 hover:bg-teal-50/70">
                    <td className="py-4 font-black">{device.displayName}</td>
                    <td>
                      <a
                        className="rounded-lg border border-slate-200 px-3 py-1.5 font-bold hover:bg-white"
                        href={cloudDeviceConsolePath(device.deviceId)}
                      >
                        打开控制台
                      </a>
                    </td>
                    <td className="font-mono text-xs">{device.deviceId}</td>
                    <td><Status online={device.online} /></td>
                    <td>{device.network}</td>
                    <td>{device.staIp}</td>
                    <td>{device.apIp}</td>
                    <td>{device.bleState}</td>
                    <td>{device.wsState}</td>
                    <td>{device.health}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-lg shadow-slate-200/50">
      <div className="text-sm font-bold text-slate-500">{label}</div>
      <div className="mt-2 text-3xl font-black">{value}</div>
    </div>
  );
}

function Status({ online }: { online: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-2 py-1 text-xs font-bold ${online ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
      <i className={`h-2 w-2 rounded-full ${online ? 'bg-emerald-500' : 'bg-rose-500'}`} />
      {online ? '在线' : '离线'}
    </span>
  );
}
