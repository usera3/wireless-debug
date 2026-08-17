import type { ConnectionTarget } from './connectionTarget';

export type LocalNetworkRequestInit = RequestInit & {
  targetAddressSpace?: 'local';
};

type FetchLike = (input: RequestInfo | URL, init?: LocalNetworkRequestInit) => Promise<Response>;

function isDirectLocalAddress(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname.endsWith('.local')
    || /^127\./.test(hostname)
    || /^10\./.test(hostname)
    || /^192\.168\./.test(hostname)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    || hostname === '::1'
    || hostname.startsWith('fc')
    || hostname.startsWith('fd')
    || hostname.startsWith('fe80:');
}

export function requiresLocalNetworkPermission(
  target: ConnectionTarget,
  pageProtocol: string,
): boolean {
  return target.kind === 'local' && pageProtocol === 'https:';
}

export function buildLocalNetworkRequestInit(
  target: ConnectionTarget,
  init: RequestInit = {},
): LocalNetworkRequestInit {
  if (target.kind !== 'local') return init;
  const hostname = new URL(target.apiBase).hostname.toLowerCase();
  if (isDirectLocalAddress(hostname)) return init;
  return {
    ...init,
    targetAddressSpace: 'local',
  };
}

export async function probeLocalNetworkAccess(
  target: ConnectionTarget,
  fetcher: FetchLike = window.fetch.bind(window),
): Promise<boolean> {
  if (target.kind !== 'local') return true;
  const response = await fetcher(`${target.apiBase}/api/device/status`, buildLocalNetworkRequestInit(target, {
    cache: 'no-store',
  }));
  return response.ok;
}
