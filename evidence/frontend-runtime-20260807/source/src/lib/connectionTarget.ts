export type ConnectionTarget =
  | {
      kind: 'local';
      label: '局域网直连';
      wsUrl: string;
      apiBase: string;
    }
  | {
      kind: 'cloud';
      label: '云端通道';
      deviceId: string;
      wsUrl: string;
      apiBase: string;
    }
  | {
      kind: 'invalid';
      label: '地址无效';
      error: string;
    };

const CLOUD_HTTP_PORT = '18088';
const CLOUD_WS_PORT = '18089';

function normalizeBase(base: string): string {
  return base.replace(/\/+$/, '');
}

function httpProtocolFromWs(protocol: string): 'http:' | 'https:' | null {
  if (protocol === 'ws:') return 'http:';
  if (protocol === 'wss:') return 'https:';
  return null;
}

function wsProtocolFromHttp(protocol: string): 'ws:' | 'wss:' | null {
  if (protocol === 'http:') return 'ws:';
  if (protocol === 'https:') return 'wss:';
  return null;
}

function cloudHttpPortFromWsPort(port: string): string {
  return port === CLOUD_WS_PORT ? CLOUD_HTTP_PORT : port;
}

function cloudWsPortFromHttpPort(port: string): string {
  return port === CLOUD_HTTP_PORT ? CLOUD_WS_PORT : port;
}

function parseCloudDevicePath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length >= 3 && parts[0] === 'ws' && parts[1] === 'device') return parts[2] || null;
  if (parts.length >= 2 && parts[0] === 'remote') return parts[1] || null;
  return null;
}

function urlOriginWithPort(url: URL, port: string): string {
  const next = new URL(url.toString());
  next.pathname = '/';
  next.search = '';
  next.hash = '';
  next.port = port;
  return normalizeBase(next.origin);
}

function resolveCloudFromWs(url: URL, deviceId: string): ConnectionTarget {
  const httpProtocol = httpProtocolFromWs(url.protocol);
  if (!httpProtocol) {
    return {
      kind: 'invalid',
      label: '地址无效',
      error: '通信地址必须使用 ws://、wss://、http:// 或 https://',
    };
  }

  const apiUrl = new URL(url.toString());
  apiUrl.protocol = httpProtocol;
  apiUrl.port = cloudHttpPortFromWsPort(url.port);

  return {
    kind: 'cloud',
    label: '云端通道',
    deviceId,
    wsUrl: url.toString(),
    apiBase: `${urlOriginWithPort(apiUrl, apiUrl.port)}/remote/${encodeURIComponent(deviceId)}`,
  };
}

function resolveCloudFromHttp(url: URL, deviceId: string): ConnectionTarget {
  const wsProtocol = wsProtocolFromHttp(url.protocol);
  if (!wsProtocol) {
    return {
      kind: 'invalid',
      label: '地址无效',
      error: '通信地址必须使用 ws://、wss://、http:// 或 https://',
    };
  }

  const wsUrl = new URL(url.toString());
  wsUrl.protocol = wsProtocol;
  wsUrl.port = cloudWsPortFromHttpPort(url.port);
  wsUrl.pathname = `/ws/device/${encodeURIComponent(deviceId)}`;
  wsUrl.search = '';
  wsUrl.hash = '';

  return {
    kind: 'cloud',
    label: '云端通道',
    deviceId,
    wsUrl: wsUrl.toString(),
    apiBase: `${urlOriginWithPort(url, url.port)}/remote/${encodeURIComponent(deviceId)}`,
  };
}

function resolveLocalFromWs(url: URL): ConnectionTarget {
  const httpProtocol = httpProtocolFromWs(url.protocol);
  if (!httpProtocol) {
    return {
      kind: 'invalid',
      label: '地址无效',
      error: '通信地址必须使用 ws://、wss://、http:// 或 https://',
    };
  }

  const apiUrl = new URL(url.toString());
  apiUrl.protocol = httpProtocol;
  apiUrl.pathname = '/';
  apiUrl.search = '';
  apiUrl.hash = '';

  return {
    kind: 'local',
    label: '局域网直连',
    wsUrl: url.toString(),
    apiBase: normalizeBase(apiUrl.origin),
  };
}

function resolveLocalFromHttp(url: URL): ConnectionTarget {
  const wsProtocol = wsProtocolFromHttp(url.protocol);
  if (!wsProtocol) {
    return {
      kind: 'invalid',
      label: '地址无效',
      error: '通信地址必须使用 ws://、wss://、http:// 或 https://',
    };
  }

  const wsUrl = new URL(url.toString());
  wsUrl.protocol = wsProtocol;
  wsUrl.pathname = '/ws';
  wsUrl.search = '';
  wsUrl.hash = '';

  return {
    kind: 'local',
    label: '局域网直连',
    wsUrl: wsUrl.toString(),
    apiBase: normalizeBase(url.origin),
  };
}

export function resolveConnectionTarget(input: string, pageOrigin?: string): ConnectionTarget {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      kind: 'invalid',
      label: '地址无效',
      error: '通信地址不能为空',
    };
  }
  if (!/^(wss?|https?):\/\//i.test(trimmed)) {
    return {
      kind: 'invalid',
      label: '地址无效',
      error: '通信地址必须以 ws://、wss://、http:// 或 https:// 开头',
    };
  }

  try {
    const url = new URL(trimmed, pageOrigin);
    const cloudDeviceId = parseCloudDevicePath(url.pathname);
    if ((url.protocol === 'ws:' || url.protocol === 'wss:') && cloudDeviceId) {
      return resolveCloudFromWs(url, cloudDeviceId);
    }
    if ((url.protocol === 'http:' || url.protocol === 'https:') && cloudDeviceId) {
      return resolveCloudFromHttp(url, cloudDeviceId);
    }
    if (url.protocol === 'ws:' || url.protocol === 'wss:') return resolveLocalFromWs(url);
    if (url.protocol === 'http:' || url.protocol === 'https:') return resolveLocalFromHttp(url);
  } catch {
    // Handled below.
  }

  return {
    kind: 'invalid',
    label: '地址无效',
    error: '通信地址格式不正确',
  };
}

export function targetApiUrl(target: ConnectionTarget, path: string): string {
  if (target.kind === 'invalid') throw new Error(target.error);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizeBase(target.apiBase)}${normalizedPath}`;
}
