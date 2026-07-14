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
