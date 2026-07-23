import { strict as assert } from 'node:assert';
import fs from 'node:fs';

const source = fs.readFileSync('src/hooks/useOscController.ts', 'utf8');

assert.match(source, /selectOscStartupMode/);
assert.match(source, /oscCapabilityCache/);
assert.match(source, /frameRouter\.onOscFrame[\s\S]*wsClient\.send\(buildStartOsc\(\)\)/,
  'waveform handler must be registered before the start command');
assert.doesNotMatch(source, /cloud-cached[\s\S]{0,1800}await sendAndWait\(buildSetChannel/,
  'warm cloud startup must not wait for every channel ACK');
assert.match(source, /cloud-cached[\s\S]{0,3200}const request = buildSetChannel[\s\S]{0,300}wsClient\.send\(request\)/,
  'warm cloud startup must still send every channel configuration');
assert.match(
  source,
  /const stop = useCallback\(\(\) => \{[\s\S]*?oscBuffer\.drain\(performance\.now\(\)\)[\s\S]*?appendSamples\(drained\.batch\)[\s\S]*?oscBuffer\.clear\(\)/,
  'stop must append the final realtime batch before clearing it',
);

const handlerStart = source.indexOf('frameRouter.onOscFrame((frame) => {');
const handlerEnd = source.indexOf('\n      });', handlerStart);
const handlerBody = source.slice(handlerStart, handlerEnd);
assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'waveform handler source must be found');
assert.doesNotMatch(
  handlerBody,
  /appendSamples\(/,
  'WebSocket frame handling must not synchronously update the chart store',
);
assert.match(
  source,
  /storeFlushTimer = setInterval\([\s\S]*?oscBuffer\.drain\(performance\.now\(\)\)[\s\S]*?STORE_FLUSH_INTERVAL_MS/,
  'a fixed-cadence timer must drain the realtime buffer',
);

console.log('osc fast start regression passed');
