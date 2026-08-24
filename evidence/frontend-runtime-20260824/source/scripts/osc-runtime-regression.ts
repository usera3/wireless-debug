import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { createElfAddressParser, MAX_ELF_FILE_BYTES } from '../src/lib/elfAddressParser';

const liveChart = readFileSync(join(process.cwd(), 'src/components/OscLiveChart.tsx'), 'utf8');
const streamToIndex = liveChart.indexOf('chart.streamTo(canvas, 0);');
assert.ok(streamToIndex >= 0, 'live chart must attach the canvas stream');
assert.match(liveChart, /const syncCanvasSize = \(\) =>/);
assert.doesNotMatch(liveChart, /\n {4}resize\(\);\n/);
assert.match(liveChart.slice(streamToIndex), /chart\.render\(canvas\);/);

const parserSource = readFileSync(join(process.cwd(), 'src/lib/elfAddressParser.ts'), 'utf8');
assert.match(parserSource, /MAX_ELF_FILE_BYTES/);
assert.match(parserSource, /file\.size\s*>\s*MAX_ELF_FILE_BYTES/);
assert.match(parserSource, /file\.arrayBuffer\(\)/);
const oversized = {
  size: MAX_ELF_FILE_BYTES + 1,
  arrayBuffer: async () => { throw new Error('arrayBuffer must not be called for oversized files'); },
} as unknown as Blob;
await assert.rejects(() => createElfAddressParser(oversized), /不超过 64 MB/);

console.log('osc runtime regression passed');
