import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const source = readFileSync('main/wifi_transport.c', 'utf8');

function functionBody(name) {
  const signature = source.indexOf(`${name}(`);
  assert.notEqual(signature, -1, `missing function: ${name}`);
  const open = source.indexOf('{', signature);
  assert.notEqual(open, -1, `missing function body: ${name}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  assert.fail(`unterminated function body: ${name}`);
}

assert.match(
  source,
  /static QueueHandle_t s_free_frame_queue;/,
  'local WebSocket frame pool must expose an O(1) free-slot queue',
);

const acquire = functionBody('frame_acquire');
assert.match(
  acquire,
  /xQueueReceive\(s_free_frame_queue,\s*&slot,\s*0\)/,
  'frame acquisition must be one nonblocking queue receive',
);
assert.doesNotMatch(
  acquire,
  /for\s*\(/,
  'frame acquisition must not linearly scan the PSRAM pool',
);
assert.doesNotMatch(
  acquire,
  /portENTER_CRITICAL/,
  'frame acquisition must not disable interrupts while touching PSRAM',
);

const release = functionBody('frame_release');
assert.match(
  release,
  /xQueueSend\(s_free_frame_queue,\s*&frame,\s*0\)/,
  'frame release must return the pointer in O(1)',
);
assert.doesNotMatch(
  release,
  /portENTER_CRITICAL/,
  'frame release must not disable interrupts while touching PSRAM',
);

const init = functionBody('wifi_transport_init');
assert.match(
  init,
  /s_free_frame_queue\s*=\s*xQueueCreateWithCaps\([\s\S]*MALLOC_CAP_INTERNAL/,
  'the free-pointer queue must use bounded-latency internal RAM',
);
assert.match(
  init,
  /for\s*\(size_t i = 0; i < WIFI_TRANSPORT_FRAME_POOL_SIZE; i\+\+\)[\s\S]*wifi_frame_t \*frame = &s_frame_pool\[i\];[\s\S]*xQueueSend\(s_free_frame_queue, &frame, 0\)/,
  'initialization must seed every pool pointer exactly once',
);

assert.doesNotMatch(
  source,
  /static portMUX_TYPE s_pool_lock|\.in_use|bool in_use/,
  'the old scan-and-flag frame allocator must be removed',
);

console.log('wifi transport pool regression passed');
