import { useConnectionStore } from '../store/connectionStore';
import { resolveConnectionTarget, targetApiUrl } from './connectionTarget';
import { buildLocalNetworkRequestInit } from './localNetworkAccess';

export function currentConnectionTarget() {
  return resolveConnectionTarget(useConnectionStore.getState().url, window.location.origin);
}

export function apiUrl(path: string): string {
  return targetApiUrl(currentConnectionTarget(), path);
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const target = currentConnectionTarget();
  return fetch(targetApiUrl(target, path), buildLocalNetworkRequestInit(target, {
    cache: 'no-store',
    ...init,
  }));
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) as T : ({} as T);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return json;
}

export function apiPostJson<T>(path: string, body: unknown): Promise<T> {
  return apiJson<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
