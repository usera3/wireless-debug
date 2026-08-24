type RemoteWindow = Window & {
  __WIRELESS_REMOTE_DEVICE_ID?: string;
  __WIRELESS_REMOTE_WS_URL?: string;
};

function remoteWindow(): RemoteWindow | null {
  return typeof window === 'undefined' ? null : (window as RemoteWindow);
}

function defaultCloudWsUrl(deviceId: string): string | null {
  const win = remoteWindow();
  if (!win) return null;
  const url = new URL(win.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (url.port === '18088') url.port = '18089';
  url.pathname = `/ws/device/${encodeURIComponent(deviceId)}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function remoteConsoleDeviceId(): string | null {
  const id = remoteWindow()?.__WIRELESS_REMOTE_DEVICE_ID?.trim();
  return id || null;
}

export function remoteConsoleWsUrl(): string | null {
  const win = remoteWindow();
  const explicit = win?.__WIRELESS_REMOTE_WS_URL?.trim();
  if (explicit) return explicit;
  const deviceId = remoteConsoleDeviceId();
  return deviceId ? defaultCloudWsUrl(deviceId) : null;
}

export function isRemoteConsole(): boolean {
  return remoteConsoleDeviceId() !== null;
}

export function platformDeviceDirectoryUrl(): string | null {
  return isRemoteConsole() ? '/platform/api/devices' : null;
}
