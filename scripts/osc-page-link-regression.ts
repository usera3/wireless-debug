import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const page = readFileSync(resolve(process.cwd(), 'src/components/OscilloscoperPage.tsx'), 'utf8');
const controller = readFileSync(resolve(process.cwd(), 'src/hooks/useOscController.ts'), 'utf8');

for (const token of [
  'describeOscTransport',
  'transport.title',
  'transport.detail',
  'const url = useConnectionStore((s) => s.url)',
]) {
  assert.ok(page.includes(token), `address oscilloscope page missing transport behavior: ${token}`);
}

assert.ok(
  /useEffect\(\(\) => \{[\s\S]*if \(!connected && running\)[\s\S]*stop\(\)/.test(page),
  'address oscilloscope must stop and reset after the active WebSocket disconnects',
);
assert.ok(controller.includes('frameRouter.reset()'), 'osc stop path must reset the shared frame parser');

console.log('osc page link regression passed');
