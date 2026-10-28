import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const page = readFileSync(resolve(process.cwd(), 'src/components/OscilloscoperPage.tsx'), 'utf8');
const controller = readFileSync(resolve(process.cwd(), 'src/hooks/useOscController.ts'), 'utf8');

for (const token of [
  'const url = useConnectionStore((s) => s.url)',
]) {
  assert.ok(page.includes(token), `address oscilloscope page missing transport behavior: ${token}`);
}

for (const token of ['describeOscTransport', 'transport.title', 'transport.detail', '通信地址无效', '请先在连接设置中选择局域网设备或云端设备']) {
  assert.ok(!page.includes(token), `address oscilloscope page must remove the transport banner: ${token}`);
}

assert.ok(
  /if \(!connected && running && shouldStopOscOnDisconnect\(connectionTarget\.kind\)\) stop\(\)/.test(page),
  'only local address sampling must stop immediately after a WebSocket disconnect',
);
assert.ok(controller.includes('frameRouter.reset()'), 'osc stop path must reset the shared frame parser');

console.log('osc page link regression passed');
