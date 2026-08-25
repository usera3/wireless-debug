import { strict as assert } from 'node:assert';
import {
  buildLocalNetworkRequestInit,
  probeLocalNetworkAccess,
  requiresLocalNetworkPermission,
} from '../src/lib/localNetworkAccess';
import type { ConnectionTarget } from '../src/lib/connectionTarget';

const localTarget: ConnectionTarget = {
  kind: 'local',
  label: '局域网直连',
  wsUrl: 'ws://192.168.4.1/ws',
  apiBase: 'http://192.168.4.1',
};

const cloudTarget: ConnectionTarget = {
  kind: 'cloud',
  label: '云端通道',
  deviceId: 'wd-ac276eab7c9c',
  wsUrl: 'ws://127.0.0.1:18089/ws/device/wd-ac276eab7c9c',
  apiBase: 'http://127.0.0.1:18088/remote/wd-ac276eab7c9c',
};

const localDomainTarget: ConnectionTarget = {
  kind: 'local',
  label: '局域网直连',
  wsUrl: 'ws://device.internal/ws',
  apiBase: 'http://device.internal',
};

assert.deepEqual(buildLocalNetworkRequestInit(localTarget, { method: 'GET' }), {
  method: 'GET',
});
assert.deepEqual(buildLocalNetworkRequestInit(localDomainTarget, { method: 'GET' }), {
  method: 'GET',
  targetAddressSpace: 'local',
});
assert.deepEqual(buildLocalNetworkRequestInit(cloudTarget, { method: 'GET' }), {
  method: 'GET',
});
assert.equal(requiresLocalNetworkPermission(localTarget, 'https:'), true);
assert.equal(requiresLocalNetworkPermission(localTarget, 'http:'), false);
assert.equal(requiresLocalNetworkPermission(cloudTarget, 'https:'), false);

const calls: Array<{ url: string; init?: RequestInit }> = [];
const allowed = await probeLocalNetworkAccess(localTarget, async (url, init) => {
  calls.push({ url: String(url), init });
  return new Response('{"ok":true}', { status: 200 });
});
assert.equal(allowed, true);
assert.equal(calls[0]?.url, 'http://192.168.4.1/api/device/status');
assert.equal((calls[0]?.init as RequestInit & { targetAddressSpace?: string }).targetAddressSpace, undefined);

const cloudCalls: string[] = [];
const skipped = await probeLocalNetworkAccess(cloudTarget, async (url) => {
  cloudCalls.push(String(url));
  return new Response(null, { status: 200 });
});
assert.equal(skipped, true);
assert.deepEqual(cloudCalls, []);

console.log('local network access regression passed');
