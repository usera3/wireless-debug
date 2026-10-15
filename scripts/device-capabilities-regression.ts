import assert from 'node:assert/strict';
import { deviceStatusJson, supportsCapability } from '../src/lib/deviceCapabilities';

assert.equal(supportsCapability({}, 'wifi'), true, 'Legacy ESP32 without capability metadata stays supported');
assert.equal(supportsCapability({ capabilities: { wifi: false } }, 'wifi'), false);
assert.equal(supportsCapability({ capabilities: { ble: true } }, 'ble'), true);
assert.equal(supportsCapability({ adapter_kind: 'browser-serial' }, 'wifi'), false);

let request: { url: string; init: RequestInit } | undefined;
globalThis.fetch = (async (url, init) => {
  request = { url: String(url), init: init! };
  return new Response(JSON.stringify({ ok: true, comm: 'AUTO' }));
}) as typeof fetch;
assert.deepEqual(await deviceStatusJson('https://device.example', '/api/device/status'), { ok: true, comm: 'AUTO' });
assert.equal(request!.url, 'https://device.example/api/device/status');
assert.equal(request!.init.cache, 'no-store');
assert.ok(request!.init.signal instanceof AbortSignal);
assert.equal(new Headers(request!.init.headers).has('X-Serial-Session'), false);

globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, msg: 'device busy' }))) as typeof fetch;
await assert.rejects(deviceStatusJson('https://device.example', '/api/device/status'), /device busy/);
globalThis.fetch = (async () => new Response('{}', { status: 503 })) as typeof fetch;
await assert.rejects(deviceStatusJson('https://device.example', '/api/device/status'), /HTTP 503/);

const abort = new AbortController();
globalThis.fetch = (async (_url, init) => {
  assert.equal(init!.signal, abort.signal);
  return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
}) as typeof fetch;
const pending = deviceStatusJson('https://device.example', '/api/device/status', { signal: abort.signal });
abort.abort();
await assert.rejects(pending, { name: 'AbortError' });
console.log('Device capabilities regression passed');
