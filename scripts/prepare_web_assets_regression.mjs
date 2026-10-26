import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import test from 'node:test';

const script = join(dirname(fileURLToPath(import.meta.url)), 'prepare_web_assets.mjs');

async function setup(t) {
  assert.ok(existsSync(script), 'frontend-to-firmware staging script is missing');
  const { stageWebAssets } = await import(pathToFileURL(script).href);
  const root = mkdtempSync(join(tmpdir(), 'wd-web-assets-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'frontend', 'dist');
  const target = join(root, 'dist');
  mkdirSync(source, { recursive: true });
  mkdirSync(join(target, 'orig'), { recursive: true });
  writeFileSync(join(target, 'index.html'), 'root redirect');
  writeFileSync(join(target, 'wifi.html'), 'provisioning page');
  writeFileSync(join(target, 'orig', 'old-chunk.js'), 'old chunk');
  for (const [name, data] of Object.entries({ 'index.html': '<script src="./a.js"></script>', 'a.js': 'new application', 'a.css': 'new styles', 'x.js': 'xlsx vendor' })) {
    writeFileSync(join(source, name), data);
    writeFileSync(join(source, `${name}.gz`), gzipSync(data));
  }
  return { source, target, stageWebAssets };
}

test('rename HTML and gzip entries, remove stale chunks, preserve other device pages', async (t) => {
  const { source, target, stageWebAssets } = await setup(t);
  const result = stageWebAssets(source, target);
  assert.equal(result, join(target, 'orig'));
  assert.deepEqual(readFileSync(join(result, 'i.html')), readFileSync(join(source, 'index.html')));
  assert.deepEqual(gunzipSync(readFileSync(join(result, 'i.html.gz'))), readFileSync(join(result, 'i.html')));
  assert.equal(readFileSync(join(result, 'a.js'), 'utf8'), 'new application');
  assert.equal(existsSync(join(result, 'index.html')), false);
  assert.equal(existsSync(join(result, 'old-chunk.js')), false);
  assert.equal(readdirSync(result).length, 8);
  assert.equal(readFileSync(join(target, 'index.html'), 'utf8'), 'root redirect');
  assert.equal(readFileSync(join(target, 'wifi.html'), 'utf8'), 'provisioning page');
});

test('incomplete build leaves existing SPIFFS assets untouched', async (t) => {
  const { source, target, stageWebAssets } = await setup(t);
  rmSync(join(source, 'a.js.gz'));
  assert.throws(() => stageWebAssets(source, target), /missing/i);
  assert.equal(readFileSync(join(target, 'orig', 'old-chunk.js'), 'utf8'), 'old chunk');
});

test('mixed gzip from another build is rejected before replacement', async (t) => {
  const { source, target, stageWebAssets } = await setup(t);
  writeFileSync(join(source, 'a.js.gz'), gzipSync('another build'));
  assert.throws(() => stageWebAssets(source, target), /gzip/i);
  assert.equal(readFileSync(join(target, 'orig', 'old-chunk.js'), 'utf8'), 'old chunk');
});

test('repeated packaging updates assets without leaving backups inside SPIFFS', async (t) => {
  const { source, target, stageWebAssets } = await setup(t);
  stageWebAssets(source, target);
  writeFileSync(join(source, 'a.js'), 'second application');
  writeFileSync(join(source, 'a.js.gz'), gzipSync('second application'));
  stageWebAssets(source, target);
  assert.equal(readFileSync(join(target, 'orig', 'a.js'), 'utf8'), 'second application');
  assert.deepEqual(readdirSync(target).sort(), ['index.html', 'orig', 'wifi.html']);
});
