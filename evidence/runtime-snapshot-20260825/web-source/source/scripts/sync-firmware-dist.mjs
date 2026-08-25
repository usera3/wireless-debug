#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const webRoot = resolve(new URL('..', import.meta.url).pathname);
const distDir = join(webRoot, 'dist');
const firmwareDist = resolve(webRoot, '../wireless_debug-main/dist/orig');

if (!existsSync(join(distDir, 'index.html'))) {
  console.error('dist/index.html missing; run npm run build first');
  process.exit(1);
}

mkdirSync(firmwareDist, { recursive: true });
for (const name of readdirSync(firmwareDist)) {
  rmSync(join(firmwareDist, name), { recursive: true, force: true });
}

for (const name of readdirSync(distDir)) {
  const source = join(distDir, name);
  const targetName = name === 'index.html'
    ? 'i.html'
    : name === 'index.html.gz'
      ? 'i.html.gz'
      : basename(name);
  copyFileSync(source, join(firmwareDist, targetName));
}

console.log(`synced ${distDir} -> ${firmwareDist}`);
