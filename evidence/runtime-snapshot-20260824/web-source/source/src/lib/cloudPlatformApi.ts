export interface CloudDeviceRecord {
  device_id?: string;
  device_mac?: string;
  display_name?: string;
  note?: string;
  availability?: string;
  cloud_state?: string;
  last_seen_ms?: number;
  last_seen_at?: string;
  status_age_seconds?: number;
  net_mode?: string;
  sta_ip?: string;
  ap_ip?: string;
  sta_connected?: boolean;
  sta_configured?: boolean;
  sta_connecting?: boolean;
  ble_ready?: boolean;
  ble_subscribed?: boolean;
  wifi_ws_client?: boolean;
  uart_baud?: number;
  fw_version?: string;
  comm_mode?: string;
  health_score?: number;
  diagnostic_level?: string;
  diagnostic_text?: string;
  diagnostic_reasons?: string[];
  uptime_ms?: number;
  heap_free?: number;
  heap_min_free?: number;
  heap_largest?: number;
  heap_internal_free?: number;
  heap_internal_min_free?: number;
  restart_reason?: number;
  comm_error_total?: number;
  display_status?: string;
  display_backend?: string;
  display_enabled?: boolean;
  motor_param_count?: number;
  motor_param_capacity?: number;
  last_status_json?: Record<string, unknown> & {
    device_mac?: string;
    net_mode?: string;
    sta_ip?: string;
    ap_ip?: string;
    sta_connected?: boolean;
    sta_configured?: boolean;
    sta_connecting?: boolean;
    ble_ready?: boolean;
    ble_subscribed?: boolean;
    wifi_ws_client?: boolean;
    uart_baud?: number;
    fw?: string;
    fw_version?: string;
    comm_mode?: string;
    cloud_ws_uplink?: { connected?: boolean };
  };
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

export interface CloudDeviceEvent {
  event_type?: string;
  payload_json?: unknown;
  created_at?: string;
}

export interface CloudDeviceCommand {
  command_id?: string;
  command_type?: string;
  args_json?: unknown;
  state?: string;
  ack_ok?: boolean;
  ack_message?: string;
  requested_by?: string;
  created_at?: string;
  ack_at?: string;
  latency_ms?: number | null;
}

export interface CloudDeviceNote {
  note?: string;
  created_at?: string;
}

export interface CloudDeviceDetailResponse {
  ok?: boolean;
  device?: CloudDeviceRecord;
  events?: CloudDeviceEvent[];
  commands?: CloudDeviceCommand[];
  notes?: CloudDeviceNote[];
}

export interface CloudHistorySummary {
  status_count?: number;
  availability_count?: number;
  command_count?: number;
  acked_count?: number;
  failed_count?: number;
  avg_latency_ms?: number | null;
}

export interface CloudStatusPoint {
  created_at?: string;
  uptime_ms?: number | null;
  net_mode?: string | null;
  sta_configured?: boolean | null;
  sta_connecting?: boolean | null;
  sta_connected?: boolean | null;
  ap_ip?: string | null;
  sta_ip?: string | null;
  uart_baud?: number | null;
  comm_mode?: string | null;
  ble_ready?: boolean | null;
  ble_subscribed?: boolean | null;
  wifi_ws_client?: boolean | null;
  [key: string]: unknown;
}

export interface CloudDeviceHistoryResponse {
  ok?: boolean;
  device_id?: string;
  summary?: CloudHistorySummary;
  status_points?: CloudStatusPoint[];
  availability?: CloudDeviceEvent[];
  commands?: CloudDeviceCommand[];
}

export interface CloudBusMessage {
  source_type?: string;
  source_id?: string;
  source_display_name?: string;
  target_type?: string;
  target_id?: string;
  target_display_name?: string;
  channel?: string;
  payload_text?: string;
  state?: string;
  ack_message?: string;
  created_at?: string;
}

export interface CloudBusMessagesResponse {
  ok?: boolean;
  messages?: CloudBusMessage[];
  channels?: string[];
}

export interface CloudDeviceRow {
  deviceId: string;
  deviceMac: string;
  displayName: string;
  cloudState: string;
  statusText: string;
  online: boolean;
  health: string;
  network: string;
  staIp: string;
  apIp: string;
  commMode: string;
  bleState: string;
  wsState: string;
  uartBaud: string;
  firmware: string;
  lastSeen: string;
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

function lastSeenFromAgeSeconds(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  if (value < 60) return '刚刚';
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return `${minutes} 分`;
  return `${Math.floor(minutes / 60)} 小时`;
}

function healthScore(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return `${Math.max(0, Math.min(100, Math.round(value)))} 分`;
}

function boolOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
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
  const lastStatus = record.last_status_json || {};
  const deviceId = valueOrDash(record.device_id);
  const online = record.cloud_state === 'online';
  const bleReady = boolOrUndefined(status.ble_ready)
    ?? boolOrUndefined(record.ble_ready)
    ?? boolOrUndefined(lastStatus.ble_ready);
  const wsConnected = boolOrUndefined(status.cloud_ws_uplink?.connected)
    ?? boolOrUndefined(lastStatus.cloud_ws_uplink?.connected)
    ?? boolOrUndefined(record.wifi_ws_client)
    ?? boolOrUndefined(lastStatus.wifi_ws_client);

  return {
    deviceId,
    deviceMac: valueOrDash(record.device_mac || lastStatus.device_mac),
    displayName: valueOrDash(record.display_name || record.device_id),
    cloudState: valueOrDash(record.cloud_state),
    statusText: record.cloud_state === 'online'
      ? '在线'
      : record.cloud_state === 'offline'
        ? '离线'
        : '未知',
    online,
    health: healthScore(record.health_score),
    network: valueOrDash(status.wifi_mode || record.net_mode || lastStatus.net_mode),
    staIp: valueOrDash(status.sta_ip || record.sta_ip || lastStatus.sta_ip),
    apIp: valueOrDash(status.ap_ip || record.ap_ip || lastStatus.ap_ip),
    commMode: valueOrDash(record.comm_mode || lastStatus.comm_mode),
    bleState: online ? (bleReady ? '就绪' : '未就绪') : '-',
    wsState: online ? (wsConnected ? '已接入' : '未接入') : '-',
    uartBaud: valueOrDash(status.uart_baud || record.uart_baud || lastStatus.uart_baud),
    firmware: valueOrDash(status.firmware_name || record.fw_version || lastStatus.fw_version || lastStatus.fw),
    lastSeen: lastSeenFromAgeSeconds(record.status_age_seconds) !== '-'
      ? lastSeenFromAgeSeconds(record.status_age_seconds)
      : healthFromLastSeen(record.last_seen_ms),
  };
}
