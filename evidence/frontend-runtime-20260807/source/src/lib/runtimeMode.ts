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
