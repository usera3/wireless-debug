import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { crc16 } from '../src/lib/crc16';
import {
  OSC_CHANNEL_TYPE_OPTIONS,
  channelRowFromParam,
  countOscChannelSlots,
  getOscChannelType,
  inferOscChannelType,
  validateOscChannelConfigs,
  type OscChannelDescriptor,
  type OscChannelValidationInput,
} from '../src/lib/oscChannelTypes';
import { configureOscChannels } from '../src/lib/oscChannelHandshake';
import { parseOscDataFrame } from '../src/lib/oscilloscope';
import { buildChannelConfigs } from '../src/components/OscChannelConfig';

const MAGIC = new Uint8Array([0xff, 0x77, 0xaa, 0x55]);

function makeOscFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.length + 10);
  const checksum = crc16(payload);
  frame.set(MAGIC, 0);
  frame.set(payload, 4);
  frame[frame.length - 6] = checksum & 0xff;
  frame[frame.length - 5] = checksum >> 8;
  frame.set(MAGIC, frame.length - 4);
  return frame;
}

function channel(
  channelNo: number,
  varAddr: number,
  typeKey: OscChannelValidationInput['typeKey'],
): OscChannelValidationInput {
  return { channelNo, varAddr, typeKey };
}

assert.deepEqual(
  {
    int16: getOscChannelType('int16'),
    float32: getOscChannelType('float32'),
    float64: getOscChannelType('float64'),
    q14: getOscChannelType('float-q14'),
    scaled1000: getOscChannelType('float-x1000'),
  },
  {
    int16: {
      key: 'int16', label: '0x02 int16', paramType: 0x02,
      byteWidth: 2, slotCount: 1, decoder: 'int16',
    },
    float32: {
      key: 'float32', label: '0x03 float32', paramType: 0x03,
      byteWidth: 4, slotCount: 2, decoder: 'float32',
    },
    float64: {
      key: 'float64', label: '0x04 float64', paramType: 0x04,
      byteWidth: 8, slotCount: 4, decoder: 'float64',
    },
    q14: {
      key: 'float-q14', label: '0x05 float/Q14', paramType: 0x05,
      byteWidth: 2, slotCount: 1, decoder: 'q14',
    },
    scaled1000: {
      key: 'float-x1000', label: '0x06 float/x1000', paramType: 0x06,
      byteWidth: 2, slotCount: 1, decoder: 'scaled1000',
    },
  },
  'one protocol table must own byte width, slot use and decoding',
);

assert.equal(getOscChannelType('int16').byteWidth, 2, '0x02 must occupy two bytes, not four');
assert.equal(
  OSC_CHANNEL_TYPE_OPTIONS.some((option) => option.paramType >= 0x07),
  false,
  'types 0x07-0x09 must stay hidden until the data source implements them',
);

assert.equal(
  inferOscChannelType({ isFloat: true, signed: false }),
  'float32',
  'parameter-table float metadata must select the 32-bit float wire/decode pair',
);
assert.equal(
  inferOscChannelType({ isFloat: false, signed: true }),
  'int16',
  'signed integer metadata must select signed 16-bit decoding',
);
assert.equal(
  inferOscChannelType({ isFloat: false, signed: false }),
  'uint16',
  'unsigned integer metadata must select unsigned 16-bit decoding',
);
assert.deepEqual(
  channelRowFromParam({
    regAddr: 0xc52c,
    alias: 'MOTOR_SPEED',
    isFloat: true,
    signed: false,
  }),
  {
    varAddrHex: 'C52C',
    typeKey: 'float32',
    label: 'MOTOR_SPEED',
  },
  'selecting a parameter alias must update address, label and decoder metadata together',
);

const builtChannels = buildChannelConfigs(
  [{ varAddrHex: '1000', typeKey: 'float32', label: 'temperature' }] as never,
  1,
);
assert.deepEqual(
  builtChannels[0],
  { channelNo: 1, varAddr: 0x1000, typeKey: 'float32', label: 'temperature' },
  'UI rows must carry one type key; wire type and width are derived from the protocol table',
);

const descriptors: OscChannelDescriptor[] = [
  { typeKey: 'uint8' },
  { typeKey: 'int16' },
  { typeKey: 'uint16' },
  { typeKey: 'int32' },
  { typeKey: 'uint32' },
  { typeKey: 'float32' },
  { typeKey: 'int64' },
  { typeKey: 'uint64' },
  { typeKey: 'float64' },
  { typeKey: 'float-q14' },
  { typeKey: 'float-x1000' },
];
const payloadLength = descriptors.reduce(
  (sum, descriptor) => sum + getOscChannelType(descriptor.typeKey).byteWidth,
  0,
);
const payload = new Uint8Array(payloadLength);
const view = new DataView(payload.buffer);
let offset = 0;
view.setUint16(offset, 0x00fe, false); offset += 2;
view.setInt16(offset, -2, false); offset += 2;
view.setUint16(offset, 0xfffe, false); offset += 2;
view.setInt32(offset, -3, false); offset += 4;
view.setUint32(offset, 0xfffffffd, false); offset += 4;
view.setFloat32(offset, 1.5, false); offset += 4;
view.setBigInt64(offset, -4n, false); offset += 8;
view.setBigUint64(offset, 4_294_967_296n, false); offset += 8;
view.setFloat64(offset, -2.25, false); offset += 8;
view.setInt16(offset, 8192, false); offset += 2;
view.setInt16(offset, -1250, false);

const parsed = parseOscDataFrame(makeOscFrame(payload), descriptors, { requireCrc: true });
assert.deepEqual(
  parsed?.channels,
  [[254], [-2], [65534], [-3], [4294967293], [1.5], [-4], [4294967296], [-2.25], [0.5], [-1.25]],
  'mixed channel values must keep their boundaries and selected interpretation',
);

const unsafeUint64 = new Uint8Array(8);
new DataView(unsafeUint64.buffer).setBigUint64(
  0,
  BigInt(Number.MAX_SAFE_INTEGER) + 1n,
  false,
);
assert.throws(
  () => parseOscDataFrame(
    makeOscFrame(unsafeUint64),
    [{ typeKey: 'uint64' }],
    { requireCrc: true },
  ),
  /uint64.*安全整数范围/,
  '64-bit integers must never be rounded silently before plotting',
);

const controllerSource = readFileSync('src/hooks/useOscController.ts', 'utf8');
assert.match(
  controllerSource,
  /frameRouter\.onOscFrame\(\(frame\) => \{[\s\S]{0,160}try \{[\s\S]{0,240}parseOscDataFrame[\s\S]{0,600}catch \(error\)[\s\S]{0,500}setStartError/,
  'decode failures must be caught at the WebSocket-to-waveform boundary and shown to the user',
);

const mcuSource = readFileSync('reference/mcu_code/lwmb.c', 'utf8');
assert.match(
  mcuSource,
  /u8_temp\s*=\s*\*\(\(uint8_t \*\)abs_addr\);[\s\S]{0,180}lwmb_osc_sample_buf\[index \* 2 \+ 1\]\s*=\s*u8_temp/,
  'the 0x01 source branch must transmit the uint8 value it just sampled',
);

const validChannels = [
  channel(1, 0x1000, 'float32'),
  channel(2, 0x1008, 'float64'),
];
assert.equal(countOscChannelSlots(validChannels), 6);
assert.doesNotThrow(() => validateOscChannelConfigs(validChannels, 6));
assert.throws(
  () => validateOscChannelConfigs(validChannels, 5),
  /占用 6 个 16 位槽位.*最多支持 5 个/,
);
assert.doesNotThrow(
  () => validateOscChannelConfigs([channel(1, 0xc3aa, 'int32')], 12),
  'the browser must not reject a user-selected type based on target-specific address alignment',
);
assert.throws(
  () => validateOscChannelConfigs([channel(1, Number.NaN, 'int16')], 12),
  /通道 1.*地址/,
);

const requests = [
  new Uint8Array([1]),
  new Uint8Array([2]),
  new Uint8Array([3]),
];
const pendingResolvers: Array<() => void> = [];
const started: number[] = [];
const parallel = configureOscChannels(requests, 'parallel', (request) => {
  started.push(request[0]);
  return new Promise<void>((resolve) => pendingResolvers.push(resolve));
});
assert.deepEqual(started, [1, 2, 3], 'cloud configuration waiters must start in parallel');
pendingResolvers.forEach((resolve) => resolve());
await parallel;

const serialStarted: number[] = [];
const serialResolvers: Array<() => void> = [];
const serial = configureOscChannels(requests, 'serial', (request) => {
  serialStarted.push(request[0]);
  return new Promise<void>((resolve) => serialResolvers.push(resolve));
});
assert.deepEqual(serialStarted, [1], 'local configuration must preserve request/ACK ordering');
serialResolvers.shift()?.();
await Promise.resolve();
assert.deepEqual(serialStarted, [1, 2]);
serialResolvers.shift()?.();
await Promise.resolve();
assert.deepEqual(serialStarted, [1, 2, 3]);
serialResolvers.shift()?.();
await serial;

console.log('osc channel type regression passed');
