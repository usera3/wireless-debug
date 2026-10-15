import { useConnectionStore } from '../store/connectionStore';
import { resolveConnectionTarget, targetApiUrl } from './connectionTarget';
import { buildLocalNetworkRequestInit } from './localNetworkAccess';
import { currentRuntimeInfo } from './runtimeMode';

export function currentConnectionTarget() {
  const runtime = currentRuntimeInfo();
  const cloudApiOrigin = runtime.mode === 'cloud-device' ? runtime.pageOrigin : undefined;
  return resolveConnectionTarget(
    useConnectionStore.getState().url,
    window.location.origin,
    cloudApiOrigin,
  );
}

export function apiUrl(path: string): string {
  return targetApiUrl(currentConnectionTarget(), path);
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const { revision, serialMode } = useConnectionStore.getState();
  if (serialMode) throw new Error('浏览器串口模式不支持设备 HTTP API');
  const target = currentConnectionTarget();
  const headers = new Headers(init?.headers);
  const response = await fetch(targetApiUrl(target, path), buildLocalNetworkRequestInit(target, {
    cache: 'no-store',
    ...init,
    headers,
  }));
  if (useConnectionStore.getState().revision !== revision) throw new DOMException('Connection changed', 'AbortError');
  return response;
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const revision = useConnectionStore.getState().revision;
  const res = await apiFetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) as T : ({} as T);
  if (useConnectionStore.getState().revision !== revision) throw new DOMException('Connection changed', 'AbortError');
  if (!res.ok) throw new Error((json as { msg?: string }).msg || `HTTP ${res.status}`);
  return json;
}

export function apiPostJson<T>(path: string, body: unknown): Promise<T> {
  return apiJson<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
