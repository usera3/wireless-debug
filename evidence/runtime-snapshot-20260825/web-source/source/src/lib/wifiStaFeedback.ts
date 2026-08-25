export type StaFeedbackKind = 'ok' | 'err' | 'ing';

export interface WifiStaStatusSnapshot {
  mode?: string;
  sta_ssid?: string;
  sta_configured?: boolean;
  sta_connecting?: boolean;
  sta_connected?: boolean;
  sta_ip?: string;
}

export interface StaConnectFeedback {
  done: boolean;
  kind: StaFeedbackKind;
  message: string;
}

const DEFAULT_SETTLE_MS = 1500;
const DEFAULT_TIMEOUT_MS = 12000;

function cleanSsid(status: WifiStaStatusSnapshot): string {
  return status.sta_ssid?.trim() || '已保存热点';
}

function cleanIp(status: WifiStaStatusSnapshot): string {
  const ip = status.sta_ip?.trim();
  return ip && ip !== '-' ? ip : '';
}

export function evaluateStaConnectAttempt(
  status: WifiStaStatusSnapshot,
  elapsedMs: number,
  options: { settleMs?: number; timeoutMs?: number } = {},
): StaConnectFeedback {
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ssid = cleanSsid(status);
  const mode = status.mode?.toUpperCase();

  if (!status.sta_configured) {
    return {
      done: true,
      kind: 'err',
      message: '连接外部 WiFi失败：未保存热点，请先网页配网',
    };
  }

  if (status.sta_connected) {
    const ip = cleanIp(status);
    return {
      done: true,
      kind: 'ok',
      message: ip ? `已连接外部 WiFi：${ssid} (${ip})` : `已连接外部 WiFi：${ssid}`,
    };
  }

  if (status.sta_connecting) {
    return {
      done: false,
      kind: 'ing',
      message: `正在连接外部 WiFi：${ssid}...`,
    };
  }

  if (elapsedMs >= timeoutMs) {
    return {
      done: true,
      kind: 'err',
      message: `连接外部 WiFi超时：${ssid} 不可用或密码错误`,
    };
  }

  if (elapsedMs >= settleMs && mode === 'AP') {
    return {
      done: true,
      kind: 'err',
      message: `连接外部 WiFi失败：${ssid} 不可用或密码错误`,
    };
  }

  return {
    done: false,
    kind: 'ing',
    message: `正在连接外部 WiFi：${ssid}...`,
  };
}
