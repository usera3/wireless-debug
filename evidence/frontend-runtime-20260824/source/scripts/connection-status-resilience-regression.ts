import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';

const source = readFileSync(join(process.cwd(), 'src/components/ConnectionPanel.tsx'), 'utf8');
assert.match(source, /const refreshInFlightRef = useRef<AbortController/);
assert.match(source, /refreshInFlightRef\.current\?\.abort\(\)/);
assert.match(source, /if \(controller\.signal\.aborted \|\| silent\) return;/);
assert.match(source, /signal: controller\.signal/);
assert.match(source, /if \(refreshInFlightRef\.current === controller\)/);

console.log('connection status resilience regression passed');
