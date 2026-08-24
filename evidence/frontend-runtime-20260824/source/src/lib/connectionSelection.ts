export type ConnectionChoice = 'local' | 'cloud' | 'custom';

export interface CloudDeviceRecord {
  device_id?: string;
  display_name?: string;
  cloud_state?: string;
}

export interface CloudDeviceOption {
  deviceId: string;
  displayName: string;
}

export function onlineCloudDevices(devices: CloudDeviceRecord[]): CloudDeviceOption[] {
  return devices
    .filter((device) => device.cloud_state === 'online' && device.device_id)
    .map((device) => ({
      deviceId: device.device_id as string,
      displayName: device.display_name?.trim() || device.device_id as string,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));
}

export function buildCloudDeviceUrl(pageOrigin: string, deviceId: string): string {
  const url = new URL(pageOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (url.port === '18088') url.port = '18089';
  url.pathname = `/ws/device/${encodeURIComponent(deviceId)}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function connectionChoiceFromUrl(input: string): ConnectionChoice {
  try {
    const url = new URL(input);
    if (url.hostname === '192.168.4.1') return 'local';
    if (/^\/ws\/device\/[^/]+\/?$/.test(url.pathname)) return 'cloud';
  } catch {
    // Invalid values remain editable under the custom option.
  }
  return 'custom';
}

export function cloudDeviceIdFromUrl(input: string): string | null {
  try {
    const parts = new URL(input).pathname.split('/').filter(Boolean);
    if (parts.length >= 3 && parts[0] === 'ws' && parts[1] === 'device') return parts[2] || null;
    if (parts.length >= 2 && parts[0] === 'remote') return parts[1] || null;
  } catch {
    // Invalid custom values do not select a cloud device.
  }
  return null;
}
