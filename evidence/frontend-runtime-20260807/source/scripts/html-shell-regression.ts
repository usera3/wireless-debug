import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');

assert.ok(!html.includes('vite.svg'), 'index.html must not reference the Vite favicon');
assert.ok(!html.includes('Vite + React + TS'), 'index.html must not keep the Vite starter title');
assert.ok(html.includes('<title>无线调试云端观测台</title>'), 'index.html should use the product title');

console.log('HTML shell regression passed');
