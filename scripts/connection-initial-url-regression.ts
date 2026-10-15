import { strict as assert } from 'node:assert';
import { selectInitialConnectionUrl } from '../src/lib/connectionPreference';

for (const savedUrl of ['webserial://local', 'http://127.0.0.1:8000', 'http://localhost:8000', 'http://[::1]:8000']) {
  assert.equal(selectInitialConnectionUrl({ remoteUrl: null, savedUrl, defaultUrl: null }), savedUrl, 'Saved targets are restored without reclassifying a localhost network endpoint');
  assert.equal(selectInitialConnectionUrl({ remoteUrl: 'wss://cloud.test/ws/device/current', savedUrl, defaultUrl: null }), 'wss://cloud.test/ws/device/current', 'Cloud runtime remains authoritative over serial preferences');
}
assert.equal(selectInitialConnectionUrl({ remoteUrl: null, savedUrl: 'http://localhost:8000/custom', defaultUrl: null }), 'http://localhost:8000/custom', 'Unrelated custom endpoint is not silently migrated');
assert.equal(selectInitialConnectionUrl({ remoteUrl: 'ws://localhost:8000/ws', savedUrl: 'http://localhost:8000', defaultUrl: null }), 'ws://localhost:8000/ws', 'Even a legacy-looking explicitly injected runtime target remains authoritative');

assert.equal(
  selectInitialConnectionUrl({
    remoteUrl: 'ws://43.153.137.20:18089/ws/device/wd-ac276eab7c9c',
    savedUrl: 'http://192.168.4.1',
    defaultUrl: 'ws://43.153.137.20:18088/ws',
  }),
  'ws://43.153.137.20:18089/ws/device/wd-ac276eab7c9c',
  'opening a cloud device console must prefer its injected cloud target over a saved LAN target',
);

assert.equal(
  selectInitialConnectionUrl({
    remoteUrl: null,
    savedUrl: 'http://192.168.4.1',
    defaultUrl: 'http://192.168.4.1',
  }),
  'http://192.168.4.1',
  'a normal local page should continue restoring the user-saved target',
);

assert.equal(
  selectInitialConnectionUrl({
    remoteUrl: null,
    savedUrl: 'http://192.168.4.1',
    defaultUrl: null,
    allowSavedUrl: false,
  }),
  null,
  'cloud platform pages must not silently reconnect to a previously saved local ESP32 target',
);

console.log('connection initial URL regression passed');
