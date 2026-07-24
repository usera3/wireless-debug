import { strict as assert } from 'node:assert';
import { appendCrc, crc16 } from '../src/lib/crc16';
import { FrameRouter } from '../src/lib/frameRouter';
import { parseReadResponse } from '../src/lib/modbus';
import { parseOscDataFrame } from '../src/lib/oscilloscope';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

function makeReadResponseWithOscMagicInPayload(): Uint8Array {
  return appendCrc(
    new Uint8Array([
      0xff, 0x03, 0x0a,
      0x00, 0x01, 0xff, 0x77, 0xaa, 0x55, 0x00, 0x02, 0x00, 0x03,
    ]),
  );
}

function makeOscFrame(frameLen: number): Uint8Array {
  const payloadLen = frameLen - 10;
  const payload = new Uint8Array(payloadLen);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 17) & 0xff;

  const crc = crc16(payload);
  const frame = new Uint8Array(frameLen);
  frame.set([0xff, 0x77, 0xaa, 0x55], 0);
  frame.set(payload, 4);
  frame[frameLen - 6] = crc & 0xff;
  frame[frameLen - 5] = (crc >> 8) & 0xff;
  frame.set([0xff, 0x77, 0xaa, 0x55], frameLen - 4);
  return frame;
}

function makeFooterAnchoredOscFrame(frameLen: number): Uint8Array {
  const frame = makeOscFrame(frameLen);
  frame.set([0x5f, 0x05, 0x01, 0xf4], 0);
  return frame;
}

function corruptOscCrc(frame: Uint8Array): Uint8Array {
  const copy = frame.slice();
  copy[copy.length - 6] ^= 0x5a;
  copy[copy.length - 5] ^= 0xa5;
  return copy;
}

function clearOscCrc(frame: Uint8Array): Uint8Array {
  const copy = frame.slice();
  copy[copy.length - 6] = 0x00;
  copy[copy.length - 5] = 0x00;
  return copy;
}

for (const splitOffset of [1, 2, 3]) {
  const router = new FrameRouter();
  const frames: Uint8Array[] = [];
  const oscFrame = makeOscFrame(250);

  router.setFrameLen(250);
  router.onOscFrame((frame) => frames.push(frame));
  router.feed(oscFrame.slice(0, splitOffset));
  router.feed(oscFrame.slice(splitOffset));

  assert.equal(
    frames.length,
    1,
    `a ${splitOffset}-byte osc magic prefix must join the next WebSocket message`,
  );
  assert.equal(hex(frames[0]), hex(oscFrame));
}

{
  const router = new FrameRouter();
  const frames: Uint8Array[] = [];
  const oscFrame = makeOscFrame(250);
  oscFrame.fill(0, 246, 250);

  router.setFrameLen(250);
  router.onOscFrame((frame) => frames.push(frame));
  router.feed(oscFrame);

  assert.equal(frames.length, 1, 'valid CRC must allow a zero osc footer');
  assert.equal(hex(frames[0]), hex(oscFrame));
}

{
  const oscFrame = makeOscFrame(250);
  oscFrame.fill(0, 246, 250);
  const parsed = parseOscDataFrame(
    oscFrame,
    [{ byteWidth: 2, paramType: 0x00 }],
    { requireCrc: true },
  );

  assert.notEqual(parsed, null, 'parser must accept a zero footer when CRC is valid');
  assert.equal(parsed?.rawData.length, 240);
}

{
  const router = new FrameRouter();
  const frames: Uint8Array[] = [];
  const oscFrame = corruptOscCrc(makeOscFrame(250));
  oscFrame.fill(0, 246, 250);

  router.setFrameLen(250);
  router.onOscFrame((frame) => frames.push(frame));
  router.feed(oscFrame);

  assert.equal(frames.length, 0, 'zero footer must not bypass an invalid CRC');
  assert.equal(
    parseOscDataFrame(oscFrame, [{ byteWidth: 2, paramType: 0x00 }]),
    null,
    'parser must reject a frame when both CRC and footer are invalid',
  );
}

{
  const router = new FrameRouter();
  const frames: Uint8Array[] = [];
  const headerAnchored = makeOscFrame(250);
  headerAnchored.fill(0, 246, 250);
  const footerAnchored = makeFooterAnchoredOscFrame(250);

  router.setFrameLen(250);
  router.onOscFrame((frame) => frames.push(frame));
  router.feed(headerAnchored);
  router.feed(footerAnchored);

  assert.equal(frames.length, 2, 'alternating valid boundary blocks must both be routed');
  assert.notEqual(
    parseOscDataFrame(footerAnchored, [{ byteWidth: 2, paramType: 0x00 }], { requireCrc: true }),
    null,
    'parser must accept a CRC-valid footer-anchored block',
  );
}

{
  const router = new FrameRouter();
  const frames: Uint8Array[] = [];
  const unanchored = makeOscFrame(250);
  unanchored.fill(0, 0, 4);
  unanchored.fill(0, 246, 250);

  router.setFrameLen(250);
  router.onOscFrame((frame) => frames.push(frame));
  router.feed(unanchored);

  assert.equal(frames.length, 0, 'CRC alone must not accept an unanchored block');
  assert.equal(
    parseOscDataFrame(unanchored, [{ byteWidth: 2, paramType: 0x00 }]),
    null,
    'parser must reject a block with neither boundary',
  );
}

{
  const router = new FrameRouter();
  const frames: Uint8Array[] = [];

  router.onModbusFrame((frame) => frames.push(frame));

  const response = makeReadResponseWithOscMagicInPayload();
  router.feed(response);

  assert.equal(frames.length, 1, '完整 Modbus 响应必须被分发，即使数据体里出现示波 magic 字节');
  assert.equal(hex(frames[0]), hex(response));
}

{
  const router = new FrameRouter();
  const frames: Uint8Array[] = [];
  const statusResponse = new Uint8Array([
    0xff, 0x03, 0x1e,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x23, 0x91, 0x5e,
  ]);

  router.onModbusFrame((frame) => frames.push(frame));
  router.feed(statusResponse);

  assert.equal(frames.length, 1, '长度明确的 FC03 长响应即使 CRC 异常也要被分发给上层判断');
  assert.equal(hex(frames[0]), hex(statusResponse));
  assert.equal(parseReadResponse(statusResponse, 15), null, '默认解析仍然严格校验 CRC');
  assert.equal(parseReadResponse(statusResponse, 15, { allowBadCrc: true })?.length, 15);
}

{
  const router = new FrameRouter();
  const frames: Uint8Array[] = [];
  const staleOscTail = new Uint8Array([
    0x00, 0x00, 0x41, 0x0f,
    0xff, 0x77, 0xaa, 0x55,
    0x08, 0xff, 0x72, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x1f,
  ]);
  const queryResponse = new Uint8Array([0xff, 0x04, 0x02, 0x00, 0xfa, 0x10, 0xa7]);

  router.setFrameLen(250);
  router.onModbusFrame((frame) => frames.push(frame));
  router.feed(staleOscTail);
  router.feed(queryResponse);

  assert.equal(
    frames.some((frame) => hex(frame) === hex(queryResponse)),
    true,
    '上一轮示波尾帧留下伪 magic 时，后续合法 Modbus 响应仍必须被恢复并分发',
  );
}

{
  const router = new FrameRouter();
  const frames: Uint8Array[] = [];
  const oscFrame = makeOscFrame(500);

  router.setFrameLen(250);
  router.onOscFrame((frame) => frames.push(frame));
  router.feed(oscFrame.slice(0, 250));
  assert.equal(frames.length, 0, '半个真实示波帧不能被误解析');
  router.feed(oscFrame.slice(250));

  assert.equal(
    frames.length,
    1,
    '真实示波帧长度与查询值不一致时，必须用 magic+CRC 自动恢复有效帧',
  );
  assert.equal(hex(frames[0]), hex(oscFrame));
}

{
  const router = new FrameRouter();
  const frames: Uint8Array[] = [];
  const oscFrame = corruptOscCrc(makeOscFrame(500));

  router.setFrameLen(250);
  router.onOscFrame((frame) => frames.push(frame));
  router.feed(oscFrame.slice(0, 250));
  router.feed(oscFrame.slice(250));

  assert.equal(
    frames.length,
    0,
    '非零 CRC 错误的示波帧不能被分发，否则公网丢包/错位会画出假尖峰',
  );
}

{
  const router = new FrameRouter();
  const frames: Uint8Array[] = [];
  const oscFrame = clearOscCrc(makeOscFrame(500));

  router.setFrameLen(250);
  router.onOscFrame((frame) => frames.push(frame));
  router.feed(oscFrame.slice(0, 250));
  router.feed(oscFrame.slice(250));

  assert.equal(
    frames.length,
    0,
    'CRC 字节为 00 00 的示波帧也必须拒绝，否则云端断流中的零值会被误判为完整帧',
  );
}
