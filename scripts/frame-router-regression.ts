import { strict as assert } from 'node:assert';
import { appendCrc } from '../src/lib/crc16';
import { FrameRouter } from '../src/lib/frameRouter';
import { parseReadResponse } from '../src/lib/modbus';

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
