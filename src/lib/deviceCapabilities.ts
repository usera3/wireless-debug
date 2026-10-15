import { resolveConnectionTarget } from './connectionTarget';
import { buildLocalNetworkRequestInit } from './localNetworkAccess';

export interface DeviceCapabilities {
  serial?: boolean;
  wifi?: boolean;
  ble?: boolean;
  comm_mode?: boolean;
  device_files?: boolean;
}

export interface AdapterStatus {
  adapter_kind?: string;
  capabilities?: DeviceCapabilities;
}

export function supportsCapability(status: AdapterStatus, capability: keyof DeviceCapabilities): boolean {
  return status.capabilities?.[capability] ?? status.adapter_kind !== 'browser-serial';
}

/** Network status discovery only; local browser serial never calls device HTTP APIs. */
export async function deviceStatusJson<T>(apiBase: string, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('Content-Type', 'application/json');
  const url = new URL(path.replace(/^\//, ''), `${apiBase.replace(/\/+$/, '')}/`);
  // AbortController works on browsers that do not implement AbortSignal.timeout.
  const controller = init?.signal ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), 5000) : null;
  try {
    const response = await fetch(url, buildLocalNetworkRequestInit(resolveConnectionTarget(apiBase), {
      cache: 'no-store', ...init, headers, signal: init?.signal ?? controller!.signal,
    }));
    const json = await response.json();
    if (!response.ok || json.ok === false) throw new Error(json.msg || `HTTP ${response.status}`);
    return json as T;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
