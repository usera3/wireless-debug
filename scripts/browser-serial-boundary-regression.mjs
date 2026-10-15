import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(resolve(root, path), 'utf8');
const issues = [];
for (const path of ['local-agent', 'src/lib/localSerial.ts']) {
  if (existsSync(resolve(root, path))) issues.push(`Excluded agent path: ${path}`);
}
const scripts = JSON.parse(read('package.json')).scripts;
for (const name of Object.keys(scripts)) {
  if (/^test:(legacy-agent|local-serial)/.test(name)) issues.push(`Agent-only command: ${name}`);
}
for (const file of readdirSync(resolve(root, 'scripts'))) {
  if (/^local-serial-/.test(file)) issues.push(`Agent-only test: ${file}`);
  if (/^browser-.*\.mjs$/.test(file) && file !== 'browser-serial-boundary-regression.mjs') {
    if (/["'`](?:file:\/\/)?(?:\/(?:tmp|home|mnt)\/|[A-Za-z]:[\\/])/.test(read(`scripts/${file}`))) {
      issues.push(`Machine-specific test dependency: ${file}`);
    }
  }
}
for (const file of ['src/store/connectionStore.ts', 'src/components/ConnectionPanel.tsx']) {
  if (read(file).includes('lib/localSerial')) issues.push(`Agent helper dependency: ${file}`);
}
assert.deepEqual(issues, [], `Browser serial release boundary:\n${issues.join('\n')}`);
console.log('Browser serial release boundary passed');
