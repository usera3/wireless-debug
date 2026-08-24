import { strict as assert } from 'node:assert';
import {
  createOscCapabilityCache,
  oscCapabilityTargetKey,
  selectOscStartupMode,
} from '../src/lib/oscCapabilityCache';
import { resolveConnectionTarget } from '../src/lib/connectionTarget';

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

const cloudA = resolveConnectionTarget('http://43.153.137.20:18088/remote/wd-a/orig/i.html');
const cloudB = resolveConnectionTarget('http://43.153.137.20:18088/remote/wd-b/orig/i.html');
const local = resolveConnectionTarget('http://192.168.4.1');
assert.equal(oscCapabilityTargetKey(cloudA), 'cloud:wd-a');
assert.equal(oscCapabilityTargetKey(cloudB), 'cloud:wd-b');
assert.equal(oscCapabilityTargetKey(local), 'local:http://192.168.4.1');

let now = 1_000_000;
const storage = new MemoryStorage();
const cache = createOscCapabilityCache(storage, () => now);
cache.write(cloudA, { frameLen: 250, maxChannels: 12, sampleRate: 10_000 });
assert.deepEqual(cache.read(cloudA), { frameLen: 250, maxChannels: 12, sampleRate: 10_000 });
assert.equal(cache.read(cloudB), null, 'capabilities must not leak across devices');
assert.equal(selectOscStartupMode(cloudA, cache.read(cloudA)), 'cloud-cached');
assert.equal(selectOscStartupMode(cloudB, cache.read(cloudB)), 'strict');
assert.equal(selectOscStartupMode(local, cache.read(cloudA)), 'strict');

now += 24 * 60 * 60 * 1000 + 1;
assert.equal(cache.read(cloudA), null, 'expired capabilities must be rejected');

cache.write(cloudA, { frameLen: 2, maxChannels: 0, sampleRate: -1 });
assert.equal(cache.read(cloudA), null, 'invalid capabilities must be rejected');

console.log('osc capability cache regression passed');
