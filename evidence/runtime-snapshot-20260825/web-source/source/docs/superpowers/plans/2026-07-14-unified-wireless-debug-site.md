# Unified Wireless Debug Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `wireless_debug_web` the single Vite + React frontend for ESP32 local UI, cloud remote device UI, and cloud platform dashboard UI.

**Architecture:** Add an explicit runtime-mode layer in the React app, then add a cloud-platform dashboard mode beside the existing device-control mode. Keep the current Python cloud backend for auth, device APIs, WebSocket fanout, and static serving; replace the standalone hand-written `cloud.html` only after the React cloud-platform page exists and is smoke-tested.

**Tech Stack:** Vite 5, React 18, TypeScript, Zustand, uPlot, Python Flask/Waitress cloud backend, ESP-IDF SPIFFS static assets.

## Global Constraints

- Do not replace the Python cloud backend with Spring Boot in this phase.
- Do not change firmware WiFi/AP/STA behavior in this phase.
- `wireless_debug_web` is the source of truth for frontend UI.
- ESP32 local mode defaults to `http://192.168.4.1`.
- Cloud device mode uses `/remote/<device_id>/api/...` and `/ws/device/<device_id>`.
- Cloud platform mode uses `/api/devices`, `/api/devices/<id>`, `/api/devices/<id>/history`, and `/health`.
- Build output must keep firmware-compatible names: `i.html`, `a.js`, `a.css`, `x.js`, and gzip variants.
- Every task must be committed before starting the next task.

---

## File Structure

### Frontend Repo: `/mnt/d/Users/sunqi39/Desktop/wireless_debug_web`

- `src/lib/runtimeMode.ts`: Detects `local-device`, `cloud-platform`, and `cloud-device` runtime modes from URL and injected globals.
- `src/lib/connectionPreference.ts`: Chooses initial connection target using runtime mode, injected remote URL, saved URL, and default URL.
- `src/lib/cloudPlatformApi.ts`: Typed cloud-platform fetch helpers and device row normalization.
- `src/components/CloudPlatformPage.tsx`: React replacement for the standalone cloud overview dashboard.
- `src/components/Layout.tsx`: Mode-aware shell and navigation.
- `src/App.tsx`: Runtime-mode routing between cloud platform pages and device-control pages.
- `scripts/*-regression.ts`: Pure TypeScript regressions for mode, URL, and cloud device behavior.
- `scripts/unified-site-smoke.mjs`: Browser smoke test for local-device, cloud-platform, and cloud-device modes.
- `scripts/sync-firmware-dist.mjs`: Copies Vite build output to `wireless_debug-main/dist/orig` with `index.html` renamed to `i.html`.
- `package.json`: Adds test and build scripts for the unified site.

### Firmware/Cloud Repo: `/mnt/d/Users/sunqi39/Desktop/wireless_debug-main`

- `tools/remote_mqtt_python/app.py`: Serves the React bundle for `/cloud.html`, injects cloud-platform globals, and preserves the old dashboard as `/legacy-cloud.html` during the transition.
- `tools/remote_mqtt_python/static/cloud.html`: Kept temporarily as the legacy dashboard while React `/cloud.html` is validated.
- `scripts/cloud_session_auth_regression.py`: Continues to prove cloud routes are login-protected.
- `scripts/cloud_remote_console_https_regression.py`: Continues to prove cloud remote control injects HTTPS-safe WebSocket URLs.
- `scripts/cloud_platform_react_route_regression.py`: New regression proving `/cloud.html` serves the React bundle with cloud-platform runtime globals.

---

### Task 1: Runtime Mode Contract

**Files:**
- Create: `src/lib/runtimeMode.ts`
- Create: `scripts/runtime-mode-regression.ts`
- Modify: `package.json`

**Interfaces:**
- Produces:
  - `export type RuntimeMode = 'local-device' | 'cloud-platform' | 'cloud-device'`
  - `export interface RuntimeInfo { mode: RuntimeMode; deviceId: string | null; pageOrigin: string; defaultConnectionUrl: string | null }`
  - `export function detectRuntimeInfo(href: string, globals?: RuntimeGlobals): RuntimeInfo`
  - `export function currentRuntimeInfo(): RuntimeInfo`
- Consumes:
  - Existing remote globals: `window.__WIRELESS_REMOTE_DEVICE_ID`, `window.__WIRELESS_REMOTE_WS_URL`

- [ ] **Step 1: Write the failing runtime regression**

Create `scripts/runtime-mode-regression.ts`:

```ts
import { strict as assert } from 'node:assert';
import { detectRuntimeInfo } from '../src/lib/runtimeMode';

const local = detectRuntimeInfo('http://192.168.4.1/orig/i.html');
assert.equal(local.mode, 'local-device');
assert.equal(local.deviceId, null);
assert.equal(local.defaultConnectionUrl, 'http://192.168.4.1');

const cloudPlatform = detectRuntimeInfo('https://wd.claudcode.xyz/cloud.html#overview');
assert.equal(cloudPlatform.mode, 'cloud-platform');
assert.equal(cloudPlatform.deviceId, null);
assert.equal(cloudPlatform.defaultConnectionUrl, null);

const remoteByPath = detectRuntimeInfo('https://wd.claudcode.xyz/remote/wd-ac276eab7c9c/orig/i.html');
assert.equal(remoteByPath.mode, 'cloud-device');
assert.equal(remoteByPath.deviceId, 'wd-ac276eab7c9c');
assert.equal(
  remoteByPath.defaultConnectionUrl,
  'wss://wd.claudcode.xyz/ws/device/wd-ac276eab7c9c',
);

const remoteByGlobal = detectRuntimeInfo('https://wd.claudcode.xyz/custom/i.html', {
  remoteDeviceId: 'wd-global',
  remoteWsUrl: 'wss://wd.claudcode.xyz/ws/device/wd-global',
});
assert.equal(remoteByGlobal.mode, 'cloud-device');
assert.equal(remoteByGlobal.deviceId, 'wd-global');
assert.equal(remoteByGlobal.defaultConnectionUrl, 'wss://wd.claudcode.xyz/ws/device/wd-global');

console.log('runtime mode regression passed');
```

- [ ] **Step 2: Add the npm script and verify RED**

Modify `package.json` scripts:

```json
"test:runtime-mode": "esbuild scripts/runtime-mode-regression.ts --bundle --platform=node --format=esm --outfile=node_modules/.tmp/runtime-mode-regression.mjs && node node_modules/.tmp/runtime-mode-regression.mjs"
```

Run:

```bash
npm run test:runtime-mode
```

Expected: FAIL because `src/lib/runtimeMode.ts` does not exist.

- [ ] **Step 3: Implement runtime detection**

Create `src/lib/runtimeMode.ts`:

```ts
export type RuntimeMode = 'local-device' | 'cloud-platform' | 'cloud-device';

export interface RuntimeGlobals {
  remoteDeviceId?: string | null;
  remoteWsUrl?: string | null;
}

export interface RuntimeInfo {
  mode: RuntimeMode;
  deviceId: string | null;
  pageOrigin: string;
  defaultConnectionUrl: string | null;
}

type RuntimeWindow = Window & {
  __WIRELESS_REMOTE_DEVICE_ID?: string;
  __WIRELESS_REMOTE_WS_URL?: string;
  __WIRELESS_RUNTIME_MODE?: RuntimeMode;
};

function clean(value: string | null | undefined): string | null {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

function deviceIdFromPath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length >= 2 && parts[0] === 'remote') return parts[1] || null;
  return null;
}

function cloudWsUrl(origin: string, deviceId: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (url.port === '18088') url.port = '18089';
  url.pathname = `/ws/device/${encodeURIComponent(deviceId)}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function localDefaultUrl(url: URL): string {
  if (url.hostname === '192.168.4.1') return 'http://192.168.4.1';
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return `${url.protocol}//${url.host}`;
  return 'http://192.168.4.1';
}

export function detectRuntimeInfo(href: string, globals: RuntimeGlobals = {}): RuntimeInfo {
  const url = new URL(href);
  const explicitDeviceId = clean(globals.remoteDeviceId);
  const pathDeviceId = deviceIdFromPath(url.pathname);
  const deviceId = explicitDeviceId || pathDeviceId;
  const explicitWsUrl = clean(globals.remoteWsUrl);

  if (deviceId) {
    return {
      mode: 'cloud-device',
      deviceId,
      pageOrigin: url.origin,
      defaultConnectionUrl: explicitWsUrl || cloudWsUrl(url.origin, deviceId),
    };
  }

  if (url.pathname === '/cloud' || url.pathname === '/cloud.html' || url.pathname === '/') {
    return {
      mode: 'cloud-platform',
      deviceId: null,
      pageOrigin: url.origin,
      defaultConnectionUrl: null,
    };
  }

  return {
    mode: 'local-device',
    deviceId: null,
    pageOrigin: url.origin,
    defaultConnectionUrl: localDefaultUrl(url),
  };
}

export function currentRuntimeInfo(): RuntimeInfo {
  const win = window as RuntimeWindow;
  if (win.__WIRELESS_RUNTIME_MODE === 'cloud-platform') {
    return {
      mode: 'cloud-platform',
      deviceId: null,
      pageOrigin: window.location.origin,
      defaultConnectionUrl: null,
    };
  }
  return detectRuntimeInfo(window.location.href, {
    remoteDeviceId: win.__WIRELESS_REMOTE_DEVICE_ID,
    remoteWsUrl: win.__WIRELESS_REMOTE_WS_URL,
  });
}
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm run test:runtime-mode
```

Expected: PASS with `runtime mode regression passed`.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/runtime-mode-regression.ts src/lib/runtimeMode.ts
git commit -m "Add runtime mode detection"
```

---

### Task 2: Runtime-Aware Initial Connection

**Files:**
- Modify: `src/lib/connectionPreference.ts`
- Modify: `src/store/connectionStore.ts`
- Modify: `scripts/connection-initial-url-regression.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes:
  - `RuntimeInfo.defaultConnectionUrl` from Task 1
- Produces:
  - `selectInitialConnectionUrl()` returns `null` when cloud-platform mode should not auto-connect.
  - `initialWsUrl()` falls back to an editable empty string in cloud-platform mode.

- [ ] **Step 1: Extend the failing regression**

Modify `scripts/connection-initial-url-regression.ts` so it includes cloud-platform behavior:

```ts
import { strict as assert } from 'node:assert';
import { selectInitialConnectionUrl } from '../src/lib/connectionPreference';

assert.equal(
  selectInitialConnectionUrl({
    remoteUrl: 'ws://43.153.137.20:18089/ws/device/wd-ac276eab7c9c',
    savedUrl: 'http://192.168.4.1',
    defaultUrl: 'ws://43.153.137.20:18088/ws',
  }),
  'ws://43.153.137.20:18089/ws/device/wd-ac276eab7c9c',
);

assert.equal(
  selectInitialConnectionUrl({
    remoteUrl: null,
    savedUrl: 'http://192.168.4.1',
    defaultUrl: 'http://192.168.4.1',
  }),
  'http://192.168.4.1',
);

assert.equal(
  selectInitialConnectionUrl({
    remoteUrl: null,
    savedUrl: 'http://192.168.4.1',
    defaultUrl: null,
    allowSavedUrl: false,
  }),
  null,
  'cloud platform pages must not silently reconnect to a previously saved local ESP32 target',
);

console.log('connection initial URL regression passed');
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test:connection-initial-url
```

Expected: FAIL because `allowSavedUrl` and nullable default URL are not supported.

- [ ] **Step 3: Update connection preference**

Modify `src/lib/connectionPreference.ts`:

```ts
interface InitialConnectionUrlOptions {
  remoteUrl: string | null;
  savedUrl: string | null;
  defaultUrl: string | null;
  allowSavedUrl?: boolean;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

export function selectInitialConnectionUrl({
  remoteUrl,
  savedUrl,
  defaultUrl,
  allowSavedUrl = true,
}: InitialConnectionUrlOptions): string | null {
  return clean(remoteUrl) || (allowSavedUrl ? clean(savedUrl) : null) || clean(defaultUrl);
}
```

- [ ] **Step 4: Update connection store**

Modify `src/store/connectionStore.ts`:

```ts
import { create } from 'zustand';
import { wsClient } from '../lib/wsClient';
import { resolveConnectionTarget } from '../lib/connectionTarget';
import { selectInitialConnectionUrl } from '../lib/connectionPreference';
import { currentRuntimeInfo } from '../lib/runtimeMode';

const URL_LS_KEY = 'wireless_debug_ws_url';

function initialWsUrl(): string {
  const runtime = currentRuntimeInfo();
  return selectInitialConnectionUrl({
    remoteUrl: runtime.mode === 'cloud-device' ? runtime.defaultConnectionUrl : null,
    savedUrl: localStorage.getItem(URL_LS_KEY),
    defaultUrl: runtime.defaultConnectionUrl,
    allowSavedUrl: runtime.mode !== 'cloud-platform',
  }) || '';
}
```

Keep the existing Zustand store body. In `connect()`, keep the invalid-target branch so an empty cloud-platform URL does not connect.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npm run test:connection-initial-url
npm run test:runtime-mode
npm run test:connection-target
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/connectionPreference.ts src/store/connectionStore.ts scripts/connection-initial-url-regression.ts package.json
git commit -m "Make initial connection runtime aware"
```

---

### Task 3: Cloud Platform API Helpers

**Files:**
- Create: `src/lib/cloudPlatformApi.ts`
- Create: `scripts/cloud-platform-api-regression.ts`
- Modify: `package.json`

**Interfaces:**
- Produces:
  - `CloudDeviceRecord`
  - `CloudDeviceRow`
  - `normalizeCloudDevice(record: CloudDeviceRecord): CloudDeviceRow`
  - `cloudDeviceConsolePath(deviceId: string): string`
  - `cloudPlatformApiUrl(path: string): string`
  - `isAuthRequiredResponse(status: number): boolean`

- [ ] **Step 1: Write failing API regression**

Create `scripts/cloud-platform-api-regression.ts`:

```ts
import { strict as assert } from 'node:assert';
import {
  cloudDeviceConsolePath,
  cloudPlatformApiUrl,
  isAuthRequiredResponse,
  normalizeCloudDevice,
} from '../src/lib/cloudPlatformApi';

assert.equal(cloudPlatformApiUrl('/api/devices'), '/api/devices');
assert.equal(cloudPlatformApiUrl('api/devices'), '/api/devices');

const row = normalizeCloudDevice({
  device_id: 'wd-ac276eab7c9c',
  display_name: 'ESP32-001',
  cloud_state: 'online',
  status: {
    wifi_mode: 'apsta',
    sta_ip: '10.162.92.4',
    ap_ip: '192.168.4.1',
    ble_ready: true,
    uart_baud: 2000000,
    cloud_ws_uplink: { connected: true },
  },
  last_seen_ms: Date.now(),
});

assert.equal(row.deviceId, 'wd-ac276eab7c9c');
assert.equal(row.displayName, 'ESP32-001');
assert.equal(row.online, true);
assert.equal(row.staIp, '10.162.92.4');
assert.equal(row.apIp, '192.168.4.1');
assert.equal(row.bleState, '就绪');
assert.equal(row.wsState, '已接入');
assert.equal(row.uartBaud, '2000000');
assert.equal(cloudDeviceConsolePath(row.deviceId), '/remote/wd-ac276eab7c9c/orig/i.html');
assert.equal(isAuthRequiredResponse(401), true);
assert.equal(isAuthRequiredResponse(403), true);
assert.equal(isAuthRequiredResponse(500), false);

console.log('cloud platform API regression passed');
```

- [ ] **Step 2: Add npm script and run RED**

Add:

```json
"test:cloud-platform-api": "esbuild scripts/cloud-platform-api-regression.ts --bundle --platform=node --format=esm --outfile=node_modules/.tmp/cloud-platform-api-regression.mjs && node node_modules/.tmp/cloud-platform-api-regression.mjs"
```

Run:

```bash
npm run test:cloud-platform-api
```

Expected: FAIL because `src/lib/cloudPlatformApi.ts` does not exist.

- [ ] **Step 3: Implement helper module**

Create `src/lib/cloudPlatformApi.ts`:

```ts
export interface CloudDeviceRecord {
  device_id?: string;
  display_name?: string;
  cloud_state?: string;
  last_seen_ms?: number;
  status?: {
    wifi_mode?: string;
    sta_ip?: string;
    ap_ip?: string;
    ble_ready?: boolean;
    uart_baud?: number;
    firmware_name?: string;
    cloud_ws_uplink?: { connected?: boolean };
  };
}

export interface CloudDeviceRow {
  deviceId: string;
  displayName: string;
  online: boolean;
  health: string;
  network: string;
  staIp: string;
  apIp: string;
  bleState: string;
  wsState: string;
  uartBaud: string;
  firmware: string;
}

function valueOrDash(value: unknown): string {
  const text = String(value ?? '').trim();
  return text || '-';
}

function healthFromLastSeen(lastSeenMs?: number): string {
  if (!lastSeenMs) return '-';
  const ageMs = Math.max(0, Date.now() - lastSeenMs);
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分`;
  return `${Math.floor(minutes / 60)} 小时`;
}

export function cloudPlatformApiUrl(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

export function isAuthRequiredResponse(status: number): boolean {
  return status === 401 || status === 403;
}

export function cloudDeviceConsolePath(deviceId: string): string {
  return `/remote/${encodeURIComponent(deviceId)}/orig/i.html`;
}

export function normalizeCloudDevice(record: CloudDeviceRecord): CloudDeviceRow {
  const status = record.status || {};
  const deviceId = valueOrDash(record.device_id);
  const online = record.cloud_state === 'online';
  return {
    deviceId,
    displayName: valueOrDash(record.display_name || record.device_id),
    online,
    health: healthFromLastSeen(record.last_seen_ms),
    network: valueOrDash(status.wifi_mode),
    staIp: valueOrDash(status.sta_ip),
    apIp: valueOrDash(status.ap_ip),
    bleState: online ? (status.ble_ready ? '就绪' : '未就绪') : '-',
    wsState: online ? (status.cloud_ws_uplink?.connected ? '已接入' : '未接入') : '-',
    uartBaud: valueOrDash(status.uart_baud),
    firmware: valueOrDash(status.firmware_name),
  };
}
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm run test:cloud-platform-api
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/cloud-platform-api-regression.ts src/lib/cloudPlatformApi.ts
git commit -m "Add cloud platform API helpers"
```

---

### Task 4: React Cloud Platform Page

**Files:**
- Create: `src/components/CloudPlatformPage.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/Layout.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Consumes:
  - `currentRuntimeInfo()`
  - `normalizeCloudDevice()`
  - `cloudDeviceConsolePath()`
- Produces:
  - `CloudPlatformPage` component for `cloud-platform` runtime mode.
  - `Layout` accepts `variant: 'device' | 'platform'` and mode-aware tabs.

- [ ] **Step 1: Write a light structural regression**

Create `scripts/cloud-platform-component-regression.ts`:

```ts
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const page = readFileSync('src/components/CloudPlatformPage.tsx', 'utf8');
for (const marker of [
  'export function CloudPlatformPage',
  '/api/devices',
  'cloudDeviceConsolePath',
  '设备总览',
  '打开控制台',
]) {
  assert.ok(page.includes(marker), `CloudPlatformPage missing marker: ${marker}`);
}

const app = readFileSync('src/App.tsx', 'utf8');
assert.ok(app.includes('currentRuntimeInfo'), 'App must use runtime mode detection');
assert.ok(app.includes('CloudPlatformPage'), 'App must render cloud platform page');

console.log('cloud platform component regression passed');
```

Add:

```json
"test:cloud-platform-component": "esbuild scripts/cloud-platform-component-regression.ts --bundle --platform=node --format=esm --outfile=node_modules/.tmp/cloud-platform-component-regression.mjs && node node_modules/.tmp/cloud-platform-component-regression.mjs"
```

Run:

```bash
npm run test:cloud-platform-component
```

Expected: FAIL because `CloudPlatformPage.tsx` does not exist.

- [ ] **Step 2: Create cloud platform component**

Create `src/components/CloudPlatformPage.tsx` with this component shape:

```tsx
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
            <p className="mt-1 text-sm text-slate-500">按设备名、网络状态和实时心跳集中管理 ESP32 无线调试终端</p>
          </div>
          <button className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-bold shadow-sm hover:bg-slate-50" onClick={() => window.location.reload()}>
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
              <p className="text-sm text-slate-500">{loading ? '正在同步设备...' : `${visibleDevices.length} 台设备`}</p>
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
            <table className="min-w-[920px] w-full text-left text-sm">
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
                      <a className="rounded-lg border border-slate-200 px-3 py-1.5 font-bold hover:bg-white" href={cloudDeviceConsolePath(device.deviceId)}>
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
```

- [ ] **Step 3: Update App mode routing**

Modify `src/App.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { currentRuntimeInfo } from './lib/runtimeMode';
import { CloudPlatformPage } from './components/CloudPlatformPage';
```

Inside `App()`:

```tsx
const runtime = useMemo(() => currentRuntimeInfo(), []);
```

Change the auto-connect effect so cloud-platform mode skips auto-connect:

```tsx
if (runtime.mode === 'cloud-platform') return;
```

Before selecting the device page content:

```tsx
if (runtime.mode === 'cloud-platform') {
  return (
    <Layout activeTab="dashboard" onTabChange={() => undefined} variant="platform">
      <CloudPlatformPage />
    </Layout>
  );
}
```

- [ ] **Step 4: Update Layout variant**

Modify `src/components/Layout.tsx`:

```tsx
interface LayoutProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  children: ReactNode;
  variant?: 'device' | 'platform';
}
```

Use `variant = 'device'` as the default. For `platform`, hide device-only tabs for now and keep a simple sidebar with one active item:

```tsx
const visibleTabs = variant === 'platform'
  ? [{ id: 'dashboard' as Tab, label: '仪表盘', icon: 'OV' }]
  : (showDebug ? TABS : TABS.filter((t) => t.id !== 'debug'));
```

Keep the existing device layout classes. This task introduces the platform page without redesigning the shell yet.

- [ ] **Step 5: Verify**

Run:

```bash
npm run test:cloud-platform-component
npm run test:cloud-platform-api
npm run build
```

Expected: all PASS and Vite emits `dist/index.html`, `dist/a.js`, `dist/a.css`, `dist/x.js`.

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/cloud-platform-component-regression.ts src/App.tsx src/components/Layout.tsx src/components/CloudPlatformPage.tsx src/index.css
git commit -m "Add React cloud platform page"
```

---

### Task 5: Firmware Build Artifact Sync

**Files:**
- Create: `scripts/sync-firmware-dist.mjs`
- Modify: `package.json`
- Modify: `scripts/deploy_esp32.sh`

**Interfaces:**
- Produces:
  - `npm run build:firmware-assets`
  - Sibling repo output at `/mnt/d/Users/sunqi39/Desktop/wireless_debug-main/dist/orig/i.html`

- [ ] **Step 1: Write sync script**

Create `scripts/sync-firmware-dist.mjs`:

```js
#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const webRoot = resolve(new URL('..', import.meta.url).pathname);
const distDir = join(webRoot, 'dist');
const firmwareDist = resolve(webRoot, '../wireless_debug-main/dist/orig');

if (!existsSync(join(distDir, 'index.html'))) {
  console.error('dist/index.html missing; run npm run build first');
  process.exit(1);
}

mkdirSync(firmwareDist, { recursive: true });
for (const name of readdirSync(firmwareDist)) {
  rmSync(join(firmwareDist, name), { recursive: true, force: true });
}

for (const name of readdirSync(distDir)) {
  const source = join(distDir, name);
  const targetName = name === 'index.html' ? 'i.html' : name === 'index.html.gz' ? 'i.html.gz' : basename(name);
  copyFileSync(source, join(firmwareDist, targetName));
}

console.log(`synced ${distDir} -> ${firmwareDist}`);
```

- [ ] **Step 2: Add build script**

Modify `package.json`:

```json
"build:firmware-assets": "npm run build && node scripts/sync-firmware-dist.mjs"
```

- [ ] **Step 3: Update deploy helper**

Modify `scripts/deploy_esp32.sh` so it calls:

```bash
npm run build:firmware-assets
```

Replace the old text that mentions uploading `dist/` to LittleFS with:

```bash
echo "==> 完成。固件 SPIFFS 产物已同步到 ../wireless_debug-main/dist/orig"
echo "    下一步在 ESP-IDF 项目中构建 storage.bin 并烧录。"
```

- [ ] **Step 4: Verify**

Run:

```bash
npm run build:firmware-assets
test -f ../wireless_debug-main/dist/orig/i.html
test -f ../wireless_debug-main/dist/orig/a.js
test -f ../wireless_debug-main/dist/orig/a.css
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit both repos**

Frontend repo:

```bash
git add package.json scripts/deploy_esp32.sh scripts/sync-firmware-dist.mjs
git commit -m "Add firmware asset sync script"
```

Firmware/cloud repo:

```bash
cd /mnt/d/Users/sunqi39/Desktop/wireless_debug-main
git add dist/orig
git commit -m "Sync unified frontend firmware assets"
```

---

### Task 6: Python Cloud Serves React Cloud Platform

**Files:**
- Modify: `/mnt/d/Users/sunqi39/Desktop/wireless_debug-main/tools/remote_mqtt_python/app.py`
- Create: `/mnt/d/Users/sunqi39/Desktop/wireless_debug-main/scripts/cloud_platform_react_route_regression.py`
- Modify: `/mnt/d/Users/sunqi39/Desktop/wireless_debug-main/tools/remote_mqtt_python/README.md`

**Interfaces:**
- Consumes:
  - `ORIG_WEB_DIR / 'i.html'` from the unified frontend build.
- Produces:
  - `/cloud.html` serves React bundle with `window.__WIRELESS_RUNTIME_MODE = "cloud-platform"`.
  - `/legacy-cloud.html` serves existing standalone `static/cloud.html`.
  - `/remote/<device_id>/orig/i.html` injects `window.__WIRELESS_RUNTIME_MODE = "cloud-device"`.

- [ ] **Step 1: Write failing route regression**

Create `scripts/cloud_platform_react_route_regression.py`:

```python
#!/usr/bin/env python3
import argparse
import http.cookiejar
import os
import sys
import urllib.parse
import urllib.request


def request(opener, url, data=None):
    body = None
    headers = {}
    if data is not None:
        body = urllib.parse.urlencode(data).encode('utf-8')
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    return opener.open(urllib.request.Request(url, data=body, headers=headers), timeout=12)


def assert_condition(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--username', default='admin@admin.com')
    parser.add_argument('--password', default=os.environ.get('CLOUD_TEST_PASSWORD', ''))
    args = parser.parse_args()
    assert_condition(args.password, 'password is required; pass --password or set CLOUD_TEST_PASSWORD')

    base_url = args.base_url.rstrip('/')
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    request(opener, f'{base_url}/login', data={'username': args.username, 'password': args.password}).read()
    html = request(opener, f'{base_url}/cloud.html').read().decode('utf-8', errors='replace')
    assert_condition('__WIRELESS_RUNTIME_MODE' in html, 'cloud.html must inject runtime mode')
    assert_condition('cloud-platform' in html, 'cloud.html must inject cloud-platform mode')
    assert_condition('./a.js' in html or 'src="./a.js' in html, 'cloud.html must serve React app assets')
    assert_condition('class="app-shell"' not in html, 'cloud.html must not serve the legacy standalone dashboard')
    legacy = request(opener, f'{base_url}/legacy-cloud.html').read().decode('utf-8', errors='replace')
    assert_condition('class="app-shell"' in legacy, 'legacy-cloud.html should keep the old dashboard during migration')
    print('cloud platform React route regression passed')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'cloud platform React route regression failed: {exc}', file=sys.stderr)
        sys.exit(1)
```

- [ ] **Step 2: Run RED against deployed cloud**

Run:

```bash
cd /mnt/d/Users/sunqi39/Desktop/wireless_debug-main
python3 scripts/cloud_platform_react_route_regression.py --base-url https://wd.claudcode.xyz --password '<cloud password>'
```

Expected: FAIL because `/cloud.html` still serves the standalone dashboard.

- [ ] **Step 3: Add shared React HTML renderer**

In `tools/remote_mqtt_python/app.py`, add:

```python
def inject_react_runtime(html, runtime_mode, device_id=None):
    payload = {
        'mode': runtime_mode,
        'deviceId': device_id,
        'remoteWsUrl': cloud_ws_public_url(device_id) if device_id else None,
    }
    script = f"""
    <script>
      window.__WIRELESS_RUNTIME_MODE = {json.dumps(runtime_mode)};
      window.__WIRELESS_REMOTE_DEVICE_ID = {json.dumps(device_id)};
      window.__WIRELESS_REMOTE_WS_URL = {json.dumps(payload['remoteWsUrl'])};
    </script>
    """
    return html.replace('</head>', f'{script}</head>')


def render_react_app(runtime_mode, device_id=None):
    html_path = ORIG_WEB_DIR / 'i.html'
    if not html_path.exists():
        return Response('react app asset missing', 404)
    html = html_path.read_text(encoding='utf-8')
    for asset_name in ('a.js', 'a.css', 'x.js'):
        version = remote_console_asset_version(asset_name)
        html = html.replace(f'./{asset_name}', f'./{asset_name}?v={version}')
    response = Response(inject_react_runtime(html, runtime_mode, device_id), mimetype='text/html')
    response.headers['Cache-Control'] = 'no-store, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    return response
```

- [ ] **Step 4: Switch cloud routes**

Replace the existing `/cloud.html` route with:

```python
@app.get('/legacy-cloud.html')
def legacy_cloud_html():
    return send_from_directory(BASE_DIR / 'static', 'cloud.html')


@app.get('/cloud.html')
def cloud_html():
    return render_react_app('cloud-platform')
```

Modify `render_remote_console_html(device_id)` so it delegates to `render_react_app('cloud-device', device_id)` instead of duplicating asset injection.

- [ ] **Step 5: Update docs**

In `tools/remote_mqtt_python/README.md`, add:

```md
### Unified React frontend

The cloud service serves the same Vite + React bundle used by ESP32 local mode.

- `/cloud.html` runs the bundle in `cloud-platform` mode.
- `/remote/<device_id>/orig/i.html` runs the bundle in `cloud-device` mode.
- `/legacy-cloud.html` is kept temporarily for rollback during the migration.

Build assets in `wireless_debug_web` with `npm run build:firmware-assets`, then deploy the updated `dist/orig` directory with the cloud service.
```

- [ ] **Step 6: Verify locally with syntax and cloud regressions**

Run:

```bash
cd /mnt/d/Users/sunqi39/Desktop/wireless_debug-main/tools/remote_mqtt_python
python3 -m py_compile app.py
cd /mnt/d/Users/sunqi39/Desktop/wireless_debug-main
python3 scripts/cloud_session_auth_regression.py --base-url https://wd.claudcode.xyz --password '<cloud password>'
python3 scripts/cloud_remote_console_https_regression.py --base-url https://wd.claudcode.xyz --password '<cloud password>'
```

Expected: syntax check PASS; existing deployed route regressions still PASS before deployment.

- [ ] **Step 7: Commit**

```bash
cd /mnt/d/Users/sunqi39/Desktop/wireless_debug-main
git add tools/remote_mqtt_python/app.py tools/remote_mqtt_python/README.md scripts/cloud_platform_react_route_regression.py
git commit -m "Serve unified React app from cloud routes"
```

---

### Task 7: Three-Mode Smoke Test And Deployment Verification

**Files:**
- Create: `scripts/unified-site-smoke.mjs`
- Modify: `package.json`
- Modify: `/mnt/d/Users/sunqi39/Desktop/wireless_debug-main/scripts/cloud_dashboard_layout_regression.py`

**Interfaces:**
- Consumes:
  - React app mode detection from Task 1.
  - Cloud route serving from Task 6.
- Produces:
  - `npm run test:unified-smoke`
  - Updated cloud regression expectations for React `/cloud.html`.

- [ ] **Step 1: Write Playwright smoke script**

Create `scripts/unified-site-smoke.mjs`:

```js
#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import playwright from '/tmp/wireless_debug_playwright_runner/node_modules/playwright/index.js';

const { chromium } = playwright;
const root = resolve('dist');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function htmlWithRuntime(mode, deviceId = null) {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const wsUrl = deviceId ? `ws://127.0.0.1:18089/ws/device/${deviceId}` : null;
  return html.replace('</head>', `<script>
    window.__WIRELESS_RUNTIME_MODE = ${JSON.stringify(mode)};
    window.__WIRELESS_REMOTE_DEVICE_ID = ${JSON.stringify(deviceId)};
    window.__WIRELESS_REMOTE_WS_URL = ${JSON.stringify(wsUrl)};
  </script></head>`);
}

const server = createServer((req, res) => {
  if (req.url === '/api/devices') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      devices: [{
        device_id: 'wd-ac276eab7c9c',
        display_name: 'ESP32-001',
        cloud_state: 'online',
        last_seen_ms: Date.now(),
        status: { wifi_mode: 'apsta', sta_ip: '10.162.92.4', ap_ip: '192.168.4.1', ble_ready: true, cloud_ws_uplink: { connected: true } },
      }],
    }));
    return;
  }
  if (req.url === '/cloud.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(htmlWithRuntime('cloud-platform'));
    return;
  }
  if (req.url === '/remote/wd-ac276eab7c9c/orig/i.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(htmlWithRuntime('cloud-device', 'wd-ac276eab7c9c'));
    return;
  }
  const pathname = req.url === '/orig/i.html' ? '/index.html' : (req.url || '/index.html').split('?')[0];
  try {
    const body = readFileSync(join(root, pathname));
    res.writeHead(200, { 'content-type': mime[extname(pathname)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const port = server.address().port;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(`http://127.0.0.1:${port}/orig/i.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  if (!(await page.getByText('Wireless Debug').count())) throw new Error('local mode did not render Wireless Debug shell');

  await page.goto(`http://127.0.0.1:${port}/cloud.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  if (!(await page.getByText('无线调试云端观测台').count())) throw new Error('cloud platform mode did not render dashboard');
  if (!(await page.getByText('ESP32-001').count())) throw new Error('cloud platform mode did not render device row');

  await page.goto(`http://127.0.0.1:${port}/remote/wd-ac276eab7c9c/orig/i.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  if (!(await page.getByText('连接设置').count())) throw new Error('cloud device mode did not render device controls');

  if (errors.length) throw new Error(`browser errors: ${errors.join('\\n')}`);
  console.log('unified site smoke passed');
} finally {
  await browser.close();
  server.close();
}
```

- [ ] **Step 2: Add npm script**

Add:

```json
"test:unified-smoke": "npm run build && node scripts/unified-site-smoke.mjs"
```

- [ ] **Step 3: Verify smoke locally**

Run:

```bash
npm run test:unified-smoke
```

Expected: PASS with `unified site smoke passed`.

- [ ] **Step 4: Deploy cloud static bundle**

Run from frontend repo:

```bash
npm run build:firmware-assets
```

Run from firmware/cloud repo:

```bash
cd /mnt/d/Users/sunqi39/Desktop/wireless_debug-main
scp -r dist/orig tools/remote_mqtt_python/app.py tools/remote_mqtt_python/README.md tencent-wireless:/tmp/
ssh tencent-wireless 'set -e
cd /home/ubuntu/wireless-debug-cloud/tools/remote_mqtt_python
stamp=$(date +%Y%m%d%H%M%S)
cp -a app.py "app.py.bak.$stamp"
cp -a orig "orig.bak.$stamp" 2>/dev/null || true
sudo cp /tmp/app.py .
sudo rm -rf orig
sudo cp -a /tmp/orig ./orig
sudo chown -R ubuntu:ubuntu app.py orig
python3 -m py_compile app.py
sudo docker compose up -d --build cloud'
```

- [ ] **Step 5: Verify deployed cloud**

Run:

```bash
cd /mnt/d/Users/sunqi39/Desktop/wireless_debug-main
python3 scripts/cloud_session_auth_regression.py --base-url https://wd.claudcode.xyz --password '<cloud password>'
python3 scripts/cloud_remote_console_https_regression.py --base-url https://wd.claudcode.xyz --password '<cloud password>'
python3 scripts/cloud_platform_react_route_regression.py --base-url https://wd.claudcode.xyz --password '<cloud password>'
```

Expected: all PASS.

- [ ] **Step 6: Commit**

Frontend repo:

```bash
cd /mnt/d/Users/sunqi39/Desktop/wireless_debug_web
git add package.json scripts/unified-site-smoke.mjs
git commit -m "Add unified site smoke test"
```

Firmware/cloud repo:

```bash
cd /mnt/d/Users/sunqi39/Desktop/wireless_debug-main
git add dist/orig tools/remote_mqtt_python/app.py tools/remote_mqtt_python/README.md scripts/cloud_platform_react_route_regression.py
git commit -m "Deploy unified React cloud routes"
```

---

## Final Verification

Run these before declaring the unified site phase complete:

```bash
cd /mnt/d/Users/sunqi39/Desktop/wireless_debug_web
npm run test:runtime-mode
npm run test:connection-initial-url
npm run test:connection-target
npm run test:cloud-platform-api
npm run test:cloud-platform-component
npm run test:unified-smoke
npm run build:firmware-assets
```

```bash
cd /mnt/d/Users/sunqi39/Desktop/wireless_debug-main
python3 scripts/cloud_session_auth_regression.py --base-url https://wd.claudcode.xyz --password '<cloud password>'
python3 scripts/cloud_remote_console_https_regression.py --base-url https://wd.claudcode.xyz --password '<cloud password>'
python3 scripts/cloud_platform_react_route_regression.py --base-url https://wd.claudcode.xyz --password '<cloud password>'
```

Firmware build verification should be run from the Windows ESP-IDF environment:

```powershell
idf.py build
```

Expected: app image and SPIFFS image build successfully, with `dist/orig/i.html` included in the storage partition.

