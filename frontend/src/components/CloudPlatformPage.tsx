import { useEffect, useMemo, useState } from 'react';
import '../cloud-console.css';
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
}

export function CloudPlatformPage() {
  const [devices, setDevices] = useState<CloudDeviceRow[]>([]);
  const [query, setQuery] = useState('');
  const [state, setState] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshSeq, setRefreshSeq] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      setLoading(true);
      try {
        const response = await fetch(cloudPlatformApiUrl('/api/devices'), {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (isAuthRequiredResponse(response.status)) {
          window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname + window.location.hash);
          return;
        }
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json() as DeviceListResponse;
        if (!Array.isArray(data.devices)) throw new Error('设备列表格式无效');
        if (!controller.signal.aborted) {
          setDevices(data.devices.filter(device => device && typeof device === 'object').map(normalizeCloudDevice));
          setError('');
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setDevices([]);
          setError('设备列表加载失败：' + (err instanceof Error ? err.message : String(err)));
        }
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    const timer = window.setInterval(load, 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refreshSeq]);

  const visibleDevices = useMemo(() => {
    const filter = query.trim().toLocaleLowerCase();
    return devices.filter(device =>
      (state === 'all' || (state === 'unknown'
        ? !['online', 'offline'].includes(device.cloudState)
        : device.cloudState === state)) &&
      [device.displayName, device.deviceId, device.deviceMac, device.staIp, device.apIp]
        .some(value => value.toLocaleLowerCase().includes(filter)),
    );
  }, [devices, query, state]);

  return (
    <div className="wd-cloud">
      <header className="wd-cloud-topbar">
        <div className="wd-cloud-brand">
          <span className="wd-cloud-wordmark" aria-label="GMCC">GMCC<span aria-hidden="true" /></span>
          <span className="wd-cloud-product">设备调试台</span>
        </div>
        <a className="wd-cloud-logout" href="/logout">退出登录</a>
      </header>
      <main className="wd-cloud-main">
        <h1>设备列表</h1>
        <div className="wd-cloud-toolbar">
          <input type="search" aria-label="搜索设备" placeholder="搜索设备名 / 设备 ID / IP"
            value={query} onChange={event => setQuery(event.target.value)} />
          <select aria-label="设备状态" value={state} onChange={event => setState(event.target.value)}>
            <option value="all">全部状态</option>
            <option value="online">在线</option>
            <option value="offline">离线</option>
            <option value="unknown">未知</option>
          </select>
          <button type="button" aria-label="刷新" disabled={loading} onClick={() => setRefreshSeq(value => value + 1)}>
            刷新
          </button>
        </div>
        {error && <p className="wd-cloud-error" role="alert">{error}</p>}
        {visibleDevices.length > 0 ? (
          <div className="wd-cloud-list" aria-label="设备列表">
            <div className="wd-cloud-columns" aria-hidden="true">
              <span>设备名</span><span>设备 ID</span><span>在线状态</span><span>网络地址</span><span>入口</span>
            </div>
            {visibleDevices.map(device => (
              <article className="wd-cloud-row" key={device.deviceId}>
                <h2>{device.displayName}</h2>
                <div className="wd-cloud-id"><span className="wd-cloud-mobile-label">设备 ID</span>{device.deviceId}</div>
                <div className="wd-cloud-state-cell">
                  <span className="wd-cloud-state" data-state={device.cloudState}>{device.statusText}</span>
                </div>
                <div className="wd-cloud-address">
                  <div>STA: {device.staIp}</div>
                  <div>AP: {device.apIp}</div>
                </div>
                {device.deviceId !== '-' ? (
                  <a className="wd-cloud-entry" href={cloudDeviceConsolePath(device.deviceId)}
                    aria-label={'打开控制台 ' + device.displayName}>打开控制台</a>
                ) : <span className="wd-cloud-missing-id">缺少设备 ID</span>}
              </article>
            ))}
          </div>
        ) : !error && (
          <p className="wd-cloud-empty" role="status">
            {loading ? '正在加载设备…' : devices.length ? '没有匹配的设备' : '暂无设备'}
          </p>
        )}
      </main>
    </div>
  );
}
