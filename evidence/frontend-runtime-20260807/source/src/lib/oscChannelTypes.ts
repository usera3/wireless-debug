export type OscParamType = 0x00 | 0x01 | 0x02 | 0x03 | 0x04 | 0x05 | 0x06;

export type OscChannelTypeKey =
  | 'default-int16'
  | 'default-uint16'
  | 'uint8'
  | 'int16'
  | 'uint16'
  | 'int32'
  | 'uint32'
  | 'float32'
  | 'int64'
  | 'uint64'
  | 'float64'
  | 'float-q14'
  | 'float-x1000';

export type OscChannelDecoder =
  | 'int16'
  | 'uint16'
  | 'uint8'
  | 'int32'
  | 'uint32'
  | 'float32'
  | 'int64'
  | 'uint64'
  | 'float64'
  | 'q14'
  | 'scaled1000';

export interface OscChannelTypeDefinition {
  key: OscChannelTypeKey;
  label: string;
  paramType: OscParamType;
  byteWidth: 2 | 4 | 8;
  slotCount: 1 | 2 | 4;
  decoder: OscChannelDecoder;
}

export interface OscChannelDescriptor {
  typeKey: OscChannelTypeKey;
}

export interface OscParameterTypeMetadata {
  isFloat: boolean;
  signed: boolean;
}

export interface OscParameterChannelMapping extends OscParameterTypeMetadata {
  regAddr: number;
  alias: string;
}

export interface OscChannelValidationInput extends OscChannelDescriptor {
  channelNo: number;
  varAddr: number;
}

export const OSC_CHANNEL_TYPE_OPTIONS: readonly OscChannelTypeDefinition[] = [
  { key: 'default-int16', label: '0x00 int16', paramType: 0x00, byteWidth: 2, slotCount: 1, decoder: 'int16' },
  { key: 'default-uint16', label: '0x00 uint16', paramType: 0x00, byteWidth: 2, slotCount: 1, decoder: 'uint16' },
  { key: 'uint8', label: '0x01 uint8', paramType: 0x01, byteWidth: 2, slotCount: 1, decoder: 'uint8' },
  { key: 'int16', label: '0x02 int16', paramType: 0x02, byteWidth: 2, slotCount: 1, decoder: 'int16' },
  { key: 'uint16', label: '0x02 uint16', paramType: 0x02, byteWidth: 2, slotCount: 1, decoder: 'uint16' },
  { key: 'int32', label: '0x03 int32', paramType: 0x03, byteWidth: 4, slotCount: 2, decoder: 'int32' },
  { key: 'uint32', label: '0x03 uint32', paramType: 0x03, byteWidth: 4, slotCount: 2, decoder: 'uint32' },
  { key: 'float32', label: '0x03 float32', paramType: 0x03, byteWidth: 4, slotCount: 2, decoder: 'float32' },
  { key: 'int64', label: '0x04 int64', paramType: 0x04, byteWidth: 8, slotCount: 4, decoder: 'int64' },
  { key: 'uint64', label: '0x04 uint64', paramType: 0x04, byteWidth: 8, slotCount: 4, decoder: 'uint64' },
  { key: 'float64', label: '0x04 float64', paramType: 0x04, byteWidth: 8, slotCount: 4, decoder: 'float64' },
  { key: 'float-q14', label: '0x05 float/Q14', paramType: 0x05, byteWidth: 2, slotCount: 1, decoder: 'q14' },
  { key: 'float-x1000', label: '0x06 float/x1000', paramType: 0x06, byteWidth: 2, slotCount: 1, decoder: 'scaled1000' },
];

const OSC_CHANNEL_TYPE_BY_KEY = new Map(
  OSC_CHANNEL_TYPE_OPTIONS.map((definition) => [definition.key, definition]),
);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

function safeBigIntToNumber(value: bigint, decoder: 'int64' | 'uint64'): number {
  if (value < MIN_SAFE_BIGINT || value > MAX_SAFE_BIGINT) {
    throw new Error(`${decoder} 值超出 JavaScript 安全整数范围，无法准确绘图`);
  }
  return Number(value);
}

export function getOscChannelType(typeKey: OscChannelTypeKey): OscChannelTypeDefinition {
  const definition = OSC_CHANNEL_TYPE_BY_KEY.get(typeKey);
  if (!definition) throw new Error(`Unsupported oscilloscope channel type: ${typeKey}`);
  return definition;
}

export function inferOscChannelType(metadata: OscParameterTypeMetadata): OscChannelTypeKey {
  if (metadata.isFloat) return 'float32';
  return metadata.signed ? 'int16' : 'uint16';
}

export function channelRowFromParam(param: OscParameterChannelMapping): {
  varAddrHex: string;
  typeKey: OscChannelTypeKey;
  label: string;
} {
  return {
    varAddrHex: param.regAddr.toString(16).padStart(4, '0').toUpperCase(),
    typeKey: inferOscChannelType(param),
    label: param.alias,
  };
}

export function decodeOscChannelValue(
  view: DataView,
  offset: number,
  descriptor: OscChannelDescriptor,
): number {
  const { decoder } = getOscChannelType(descriptor.typeKey);
  switch (decoder) {
    case 'uint8': return view.getUint16(offset, false) & 0xff;
    case 'int16': return view.getInt16(offset, false);
    case 'uint16': return view.getUint16(offset, false);
    case 'int32': return view.getInt32(offset, false);
    case 'uint32': return view.getUint32(offset, false);
    case 'float32': return view.getFloat32(offset, false);
    case 'int64': return safeBigIntToNumber(view.getBigInt64(offset, false), decoder);
    case 'uint64': return safeBigIntToNumber(view.getBigUint64(offset, false), decoder);
    case 'float64': return view.getFloat64(offset, false);
    case 'q14': return view.getInt16(offset, false) / 16384;
    case 'scaled1000': return view.getInt16(offset, false) / 1000;
  }
}

export function countOscChannelSlots(channels: readonly OscChannelDescriptor[]): number {
  return channels.reduce(
    (total, channel) => total + getOscChannelType(channel.typeKey).slotCount,
    0,
  );
}

export function validateOscChannelConfigs(
  channels: readonly OscChannelValidationInput[],
  maxSlots: number,
): void {
  if (!Number.isInteger(maxSlots) || maxSlots < 1) {
    throw new Error('Device oscilloscope slot limit is invalid');
  }
  if (channels.length === 0) throw new Error('At least one oscilloscope channel is required');

  channels.forEach((channel, index) => {
    const expectedChannelNo = index + 1;
    if (channel.channelNo !== expectedChannelNo) {
      throw new Error(`Channel numbers must be consecutive from 1; expected ${expectedChannelNo}`);
    }
    if (!Number.isInteger(channel.varAddr) || channel.varAddr < 0 || channel.varAddr > 0xffff) {
      throw new Error(`通道 ${channel.channelNo} 地址必须是 0000-FFFF 的十六进制值`);
    }
  });

  const occupiedSlots = countOscChannelSlots(channels);
  if (occupiedSlots > maxSlots) {
    throw new Error(`当前配置占用 ${occupiedSlots} 个 16 位槽位，设备最多支持 ${maxSlots} 个`);
  }
}

export function parseOscAddressHex(value: string): number {
  const normalized = value.trim();
  if (!/^[0-9a-fA-F]{1,4}$/.test(normalized)) return Number.NaN;
  return Number.parseInt(normalized, 16);
}
