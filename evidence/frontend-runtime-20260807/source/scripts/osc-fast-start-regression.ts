import { strict as assert } from 'node:assert';
import fs from 'node:fs';

const source = fs.readFileSync('src/hooks/useOscController.ts', 'utf8');
const wsClientSource = fs.readFileSync('src/lib/wsClient.ts', 'utf8');

assert.match(source, /selectOscStartupMode/);
assert.match(source, /oscCapabilityCache/);
assert.match(source, /frameRouter\.onOscFrame[\s\S]*wsClient\.send\(buildStartOsc\(\)\)/,
  'waveform handler must be registered before the start command');
assert.match(
  source,
  /const channelRequests = channels\.map\([\s\S]*?buildSetChannel\([\s\S]*?await configureOscChannels\([\s\S]*?target\.kind === 'cloud' \? 'parallel' : 'serial'/,
  'cloud channel configuration must await all ACKs in parallel while local mode stays serial',
);
assert.doesNotMatch(
  source,
  /configureOscChannels\([\s\S]{0,300}sendAndWaitWithRetry/,
  'non-idempotent channel configuration must not use the retrying query helper',
);
assert.match(
  source,
  /configureOscChannels\([\s\S]{0,300}\(request\) => sendAndWaitOnce\(request\)/,
  'channel configuration must use the non-retrying ACK waiter',
);
assert.match(
  source,
  /const stop = useCallback\(\(\) => \{[\s\S]*?oscPlaybackBuffer\.drainAll\(\)[\s\S]*?appendSamples\(playbackTail\.batch\)[\s\S]*?oscPlaybackBuffer\.clear\(\)/,
  'stop must append the final paced batch before clearing it',
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
  /storeFlushTimer = setInterval\([\s\S]*?oscPlaybackBuffer\.drainDue\(performance\.now\(\)\)[\s\S]*?STORE_FLUSH_INTERVAL_MS/,
  'a fixed-cadence timer must drain the paced playback buffer',
);
assert.doesNotMatch(
  source,
  /OscRealtimeBuffer/,
  'local address samples must not be flushed in receive-sized bursts',
);
assert.match(source, /const oscPlaybackBuffer = new OscJitterBuffer\(\)/);
assert.match(source, /const LOCAL_OSC_TARGET_LATENCY_MS = 200/);
assert.match(source, /const CLOUD_OSC_TARGET_LATENCY_MS = 300/);
assert.match(
  source,
  /targetLatencyMs:\s*target\.kind === 'cloud'\s*\?\s*CLOUD_OSC_TARGET_LATENCY_MS\s*:\s*LOCAL_OSC_TARGET_LATENCY_MS[\s\S]*?resumeLatencyMs: 100/,
  'cloud playback should retain 300 ms while local playback uses the measured 200 ms reserve',
);
assert.match(
  source,
  /oscPlaybackBuffer\.appendBatch\(batch\)/,
  'all address samples must enter the ordered playback reserve',
);
assert.match(
  source,
  /const stop = useCallback[\s\S]*?queueOscStopBarrier\(\)[\s\S]*?\.then\(\(\) => \{[\s\S]*?stopStoreFlushTimer\(\)[\s\S]*?oscPlaybackBuffer\.drainAll\(\)/,
  'runtime cleanup must wait for the ordered stop ACK barrier',
);
assert.match(
  source,
  /let stopBarrierSequence = new OscStopBarrierSequence\(\)[\s\S]*?function queueOscStopBarrier\([\s\S]*?stopBarrierSequence\.wait\(/,
  'all stop requests must share one ACK-debt sequence',
);
assert.match(
  source,
  /async function stopAndDrainPreviousRun[\s\S]*?queueOscStopBarrier\(\)[\s\S]*?if \(!waitForAck\)/,
  'cloud startup stop must enter the same sequence without delaying fast start',
);
assert.doesNotMatch(
  source,
  /waitForSequencedOscStopBarrier/,
  'the controller must not use promise completion as proof that a timed-out ACK was consumed',
);
assert.match(wsClientSource, /get generation\(\): number/);
assert.match(
  source,
  /stopBarrierConnectionGeneration[\s\S]*?isCurrent:[\s\S]*?wsClient\.generation/,
  'queued stop barriers must be bound to the active WebSocket generation',
);

console.log('osc fast start regression passed');
