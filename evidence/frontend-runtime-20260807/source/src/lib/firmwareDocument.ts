/**
 * 固件文档解析器（浏览器版）
 * 移植自 bl_electron_gui/src/firmware-document.js
 * 去除 fs 依赖，改用 File.text() API
 */

import type { GuiTarget } from './guiConfig';

// ─── CRC32 ─────────────────────────────────────────────────────────────────

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i;
    for (let b = 0; b < 8; b++) v = v & 1 ? (0xedb88320 ^ (v >>> 1)) : (v >>> 1);
    table[i] = v;
  }
  return table;
})();

function calcCrc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ─── Intel HEX parse ───────────────────────────────────────────────────────

function hexLineToBytes(hexStr: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hexStr.length; i += 2) {
    bytes.push(parseInt(hexStr.substring(i, i + 2), 16));
  }
  return bytes;
}

function parseIntelHexContent(content: string): Map<number, number> {
  const lines = content.split(/\r?\n/);
  const data = new Map<number, number>();
  let extendedAddr = 0;
  let eofSeen = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith(':')) throw new Error(`无效的 Intel HEX 记录: ${trimmed}`);

    const bytes = hexLineToBytes(trimmed.substring(1));
    if (bytes.length < 5) throw new Error(`Intel HEX 记录过短: ${trimmed}`);

    const byteCount = bytes[0];
    const address = (bytes[1] << 8) | bytes[2];
    const recordType = bytes[3];
    const dataBytes = bytes.slice(4, 4 + byteCount);
    const checksum = bytes[4 + byteCount];

    let sum = 0;
    for (let i = 0; i < 4 + byteCount; i++) sum += bytes[i];
    sum = (~sum + 1) & 0xff;
    if (sum !== checksum) throw new Error(`校验和错误`);

    switch (recordType) {
      case 0x00: {
        const fullAddr = extendedAddr + address;
        for (let i = 0; i < dataBytes.length; i++) data.set(fullAddr + i, dataBytes[i]);
        break;
      }
      case 0x01:
        eofSeen = true;
        break;
      case 0x02:
        extendedAddr = ((dataBytes[0] << 8) | dataBytes[1]) << 4;
        break;
      case 0x04:
        extendedAddr = ((dataBytes[0] << 8) | dataBytes[1]) << 16;
        break;
      default:
        throw new Error(`不支持的记录类型: 0x${recordType.toString(16)}`);
    }
  }

  if (!eofSeen) throw new Error('分段缺少 Intel HEX EOF 记录');
  return data;
}

// ─── Data merge helpers ────────────────────────────────────────────────────

function mergeWordData(
  lowData: Map<number, number>,
  highData: Map<number, number>
): { dataBlocks: Map<number, Uint8Array>; minAddr: number; maxAddr: number } {
  const lowAddrs = Array.from(lowData.keys()).sort((a, b) => a - b);
  const highAddrs = Array.from(highData.keys()).sort((a, b) => a - b);
  if (lowAddrs.length !== highAddrs.length) throw new Error('高低位分段长度不匹配');
  for (let i = 0; i < lowAddrs.length; i++) {
    if (lowAddrs[i] !== highAddrs[i])
      throw new Error(`高低位地址不匹配: low=0x${lowAddrs[i].toString(16)}`);
  }

  const dataBlocks = new Map<number, Uint8Array>();
  if (lowAddrs.length === 0) return { dataBlocks, minAddr: 0, maxAddr: 0 };

  let blockAddr = lowAddrs[0];
  let buf: number[] = [];
  let lastAddr = lowAddrs[0] - 1;

  for (const addr of lowAddrs) {
    if (addr > lastAddr + 1 && buf.length > 0) {
      dataBlocks.set(blockAddr, new Uint8Array(buf));
      buf = [];
      blockAddr = addr;
      lastAddr = addr - 1;
    }
    while (lastAddr + 1 < addr) { buf.push(0xff, 0xff); lastAddr++; }
    buf.push(lowData.get(addr)!, highData.get(addr)!);
    lastAddr = addr;
  }
  if (buf.length > 0) dataBlocks.set(blockAddr, new Uint8Array(buf));
  return { dataBlocks, minAddr: lowAddrs[0], maxAddr: lowAddrs[lowAddrs.length - 1] };
}

function mergeByteData(
  dataMap: Map<number, number>
): { dataBlocks: Map<number, Uint8Array>; minAddr: number; maxAddr: number } {
  const addresses = Array.from(dataMap.keys()).sort((a, b) => a - b);
  const dataBlocks = new Map<number, Uint8Array>();
  if (addresses.length === 0) return { dataBlocks, minAddr: 0, maxAddr: 0 };

  let blockAddr = addresses[0];
  let buf: number[] = [];
  let lastAddr = addresses[0] - 1;

  for (const addr of addresses) {
    if (addr > lastAddr + 1 && buf.length > 0) {
      dataBlocks.set(blockAddr, new Uint8Array(buf));
      buf = [];
      blockAddr = addr;
      lastAddr = addr - 1;
    }
    while (lastAddr + 1 < addr) { buf.push(0xff); lastAddr++; }
    buf.push(dataMap.get(addr)!);
    lastAddr = addr;
  }
  if (buf.length > 0) dataBlocks.set(blockAddr, new Uint8Array(buf));
  return { dataBlocks, minAddr: addresses[0], maxAddr: addresses[addresses.length - 1] };
}

function mergeDataMaps(maps: Map<number, number>[]): Map<number, number> {
  const merged = new Map<number, number>();
  for (const m of maps) {
    for (const [addr, val] of m) {
      if (merged.has(addr) && merged.get(addr) !== val)
        throw new Error(`地址 0x${addr.toString(16)} 出现冲突数据`);
      merged.set(addr, val);
    }
  }
  return merged;
}

// ─── ParsedTargetImage ─────────────────────────────────────────────────────

export interface MemoryRow {
  address: number;
  bytes: number[];
  ascii: string;
}

export interface MemoryResult {
  target: string;
  addrUnit: string;
  startAddress: number;
  requestedLength: number;
  missing: number;
  rows: MemoryRow[];
}

export class ParsedTargetImage {
  target: string;
  addrUnit: 'word16' | 'byte8';
  is16bitMode: boolean;
  dataBlocks: Map<number, Uint8Array>;
  minAddr: number;
  maxAddr: number;
  segmentNames: string[];
  purpose: string;

  constructor(opts: {
    target: string;
    addrUnit: 'word16' | 'byte8';
    dataBlocks: Map<number, Uint8Array>;
    minAddr: number;
    maxAddr: number;
    segmentNames?: string[];
    purpose?: string;
  }) {
    this.target = opts.target;
    this.addrUnit = opts.addrUnit;
    this.is16bitMode = opts.addrUnit === 'word16';
    this.dataBlocks = opts.dataBlocks;
    this.minAddr = opts.minAddr;
    this.maxAddr = opts.maxAddr;
    this.segmentNames = opts.segmentNames ?? [];
    this.purpose = opts.purpose ?? '';
  }

  getDataBlocks(): Map<number, Uint8Array> {
    return this.dataBlocks;
  }

  calculateCrc32(): number {
    const blocks = Array.from(this.dataBlocks.entries()).sort((a, b) => a[0] - b[0]);
    const total = blocks.reduce((s, [, d]) => s + d.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const [, d] of blocks) { merged.set(d, off); off += d.length; }
    return calcCrc32(merged);
  }

  getAppInfo() {
    const totalBytes = Array.from(this.dataBlocks.values()).reduce((s, d) => s + d.length, 0);
    return { startAddr: this.minAddr, length: totalBytes, crc32: this.calculateCrc32() };
  }

  getSummary() {
    const info = this.getAppInfo();
    return {
      target: this.target,
      addrUnit: this.addrUnit,
      is16bitMode: this.is16bitMode,
      blockCount: this.dataBlocks.size,
      minAddr: this.minAddr,
      maxAddr: this.maxAddr,
      totalBytes: info.length,
      totalWords: this.is16bitMode ? Math.floor(info.length / 2) : undefined,
      crc32: info.crc32,
      startAddr: info.startAddr,
      segmentNames: this.segmentNames,
      purpose: this.purpose,
    };
  }

  _readBytesAt(address: number, length: number): { buffer: Uint8Array; missing: number } {
    const buffer = new Uint8Array(length).fill(0xff);
    const blocks = Array.from(this.dataBlocks.entries()).sort((a, b) => a[0] - b[0]);
    let missing = 0;

    for (let i = 0; i < length; i++) {
      let found = false;
      if (this.is16bitMode) {
        const wordAddr = address + Math.floor(i / 2);
        const byteInWord = i % 2;
        for (const [start, data] of blocks) {
          const wlen = Math.floor(data.length / 2);
          if (wordAddr >= start && wordAddr < start + wlen) {
            buffer[i] = data[(wordAddr - start) * 2 + byteInWord];
            found = true;
            break;
          }
        }
      } else {
        const byteAddr = address + i;
        for (const [start, data] of blocks) {
          if (byteAddr >= start && byteAddr < start + data.length) {
            buffer[i] = data[byteAddr - start];
            found = true;
            break;
          }
        }
      }
      if (!found) missing++;
    }
    return { buffer, missing };
  }

  parseAppInfo(address: number) {
    const { buffer, missing } = this._readBytesAt(address, 68);
    if (missing > 0) return { success: false as const, error: `AppInfo 数据不完整: 缺失 ${missing} 字节` };

    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const appInfo = {
      magic: view.getUint32(0, true),
      entryAddr: view.getUint32(4, true),
      majorVersion: view.getUint16(8, true),
      minorVersion: view.getUint16(10, true),
      appStartAddr: view.getUint32(12, true),
      appLength: view.getUint32(16, true),
      crc32: view.getUint32(20, true),
      timestamp: view.getUint32(24, true),
      gitCommitId: view.getUint32(28, true),
      validFlag: view.getUint16(32, true),
      gitTagLength: view.getUint16(34, true),
      gitTag: '',
    };

    const tagLen = Math.min(appInfo.gitTagLength, 32);
    for (let i = 0; i < tagLen; i++) {
      const ch = buffer[36 + i];
      if (ch === 0) break;
      appInfo.gitTag += String.fromCharCode(ch);
    }
    return { success: true as const, appInfo };
  }

  getMemoryRows(address: number, length: number, bytesPerRow = 16): MemoryResult {
    const { buffer, missing } = this._readBytesAt(address, length);
    const rows: MemoryRow[] = [];

    for (let offset = 0; offset < buffer.length; offset += bytesPerRow) {
      const rowBytes = Array.from(buffer.slice(offset, offset + bytesPerRow));
      const ascii = rowBytes
        .map((v) => (v >= 32 && v <= 126 ? String.fromCharCode(v) : '.'))
        .join('');
      rows.push({
        address: address + (this.is16bitMode ? Math.floor(offset / 2) : offset),
        bytes: rowBytes,
        ascii,
      });
    }

    return { target: this.target, addrUnit: this.addrUnit, startAddress: address, requestedLength: length, missing, rows };
  }
}

// ─── FirmwareDocument ──────────────────────────────────────────────────────

export class FirmwareDocument {
  format: 'hex2' | 'legacy';
  source: string;
  targets: Map<string, ParsedTargetImage>;

  constructor(opts: { format: 'hex2' | 'legacy'; source: string; targets: Map<string, ParsedTargetImage> }) {
    this.format = opts.format;
    this.source = opts.source;
    this.targets = opts.targets;
  }

  getTarget(target: string): ParsedTargetImage | null {
    return this.targets.get(target) ?? null;
  }

  listTargets() {
    return Array.from(this.targets.values()).map((img) => img.getSummary());
  }
}

// ─── Segment header parse ──────────────────────────────────────────────────

interface SegmentHeader {
  name: string;
  target: string;
  addrUnit: 'word16' | 'byte8';
  combine: 'none' | 'pair-low' | 'pair-high';
  purpose: string;
}

function parseSegmentHeader(line: string): SegmentHeader {
  const trimmed = line.trim();
  if (!trimmed.startsWith('@SEGMENT')) throw new Error(`无效的分段头: ${line}`);

  const body = trimmed.substring('@SEGMENT'.length).trim();
  const matches = body.match(/([^\s=]+)=([^\s]+)/g) ?? [];
  const fields: Record<string, string> = {};
  for (const item of matches) {
    const sep = item.indexOf('=');
    fields[item.substring(0, sep)] = item.substring(sep + 1);
  }

  for (const req of ['name', 'target', 'addr-unit', 'combine']) {
    if (!fields[req]) throw new Error(`分段头缺少字段: ${req}`);
  }
  if (!['word16', 'byte8'].includes(fields['addr-unit']))
    throw new Error(`不支持的 addr-unit: ${fields['addr-unit']}`);
  if (!['none', 'pair-low', 'pair-high'].includes(fields['combine']))
    throw new Error(`不支持的 combine: ${fields['combine']}`);

  return {
    name: fields['name'],
    target: fields['target'],
    addrUnit: fields['addr-unit'] as 'word16' | 'byte8',
    combine: fields['combine'] as 'none' | 'pair-low' | 'pair-high',
    purpose: fields['purpose'] ?? '',
  };
}

// ─── HEX2 document loader ──────────────────────────────────────────────────

async function createHex2Document(
  file: File,
  targetDefinitions: GuiTarget[] = []
): Promise<FirmwareDocument> {
  const content = await file.text();
  const lines = content.split(/\r?\n/);
  const segments: (SegmentHeader & { data: Map<number, number> })[] = [];
  let lineIndex = 0;
  let versionSeen = false;

  while (lineIndex < lines.length) {
    const trimmed = lines[lineIndex].trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) { lineIndex++; continue; }

    if (!versionSeen) {
      if (trimmed !== '@HEX2 version=1') throw new Error('HEX2 文件头无效，必须为 @HEX2 version=1');
      versionSeen = true;
      lineIndex++;
      continue;
    }

    if (!trimmed.startsWith('@SEGMENT')) throw new Error(`无效控制行: ${trimmed}`);

    const header = parseSegmentHeader(trimmed);
    const hexLines: string[] = [];
    let eofSeen = false;
    lineIndex++;

    while (lineIndex < lines.length) {
      const cur = lines[lineIndex].trim();
      if (!cur || cur.startsWith(';') || cur.startsWith('#')) { lineIndex++; continue; }
      if (cur.startsWith('@')) break;
      if (!cur.startsWith(':')) throw new Error(`分段 ${header.name} 中存在无效内容: ${cur}`);
      hexLines.push(cur);
      if (cur === ':00000001FF') { eofSeen = true; lineIndex++; break; }
      lineIndex++;
    }

    if (!eofSeen) throw new Error(`分段 ${header.name} 缺少 EOF 记录`);
    segments.push({ ...header, data: parseIntelHexContent(hexLines.join('\n')) });
  }

  // Validate unique segment names
  const nameSet = new Set<string>();
  for (const seg of segments) {
    if (nameSet.has(seg.name)) throw new Error(`分段名称重复: ${seg.name}`);
    nameSet.add(seg.name);
  }

  // Group by target
  const grouped = new Map<string, typeof segments>();
  for (const seg of segments) {
    if (!grouped.has(seg.target)) grouped.set(seg.target, []);
    grouped.get(seg.target)!.push(seg);
  }

  const targets = new Map<string, ParsedTargetImage>();

  for (const [targetName, segs] of grouped) {
    const pairLow = segs.filter((s) => s.combine === 'pair-low');
    const pairHigh = segs.filter((s) => s.combine === 'pair-high');
    const singles = segs.filter((s) => s.combine === 'none');

    if (pairLow.length > 0 || pairHigh.length > 0) {
      if (singles.length > 0) throw new Error(`目标 ${targetName} 同时包含 pair 和 none 分段`);
      if (pairLow.length !== 1 || pairHigh.length !== 1)
        throw new Error(`目标 ${targetName} 必须恰好包含一对 pair-low / pair-high`);
      const merged = mergeWordData(pairLow[0].data, pairHigh[0].data);
      targets.set(targetName, new ParsedTargetImage({
        target: targetName, addrUnit: 'word16',
        dataBlocks: merged.dataBlocks, minAddr: merged.minAddr, maxAddr: merged.maxAddr,
        segmentNames: [pairLow[0].name, pairHigh[0].name],
        purpose: pairLow[0].purpose || pairHigh[0].purpose,
      }));
      continue;
    }

    if (singles.length === 0) throw new Error(`目标 ${targetName} 没有可用分段`);
    const addrUnit = singles[0].addrUnit;
    if (singles.some((s) => s.addrUnit !== addrUnit))
      throw new Error(`目标 ${targetName} 的单段地址单位不一致`);
    if (addrUnit !== 'byte8') throw new Error(`当前仅支持 byte8 类型的单段目标`);

    const mergedMap = mergeDataMaps(singles.map((s) => s.data));
    const merged = mergeByteData(mergedMap);
    targets.set(targetName, new ParsedTargetImage({
      target: targetName, addrUnit,
      dataBlocks: merged.dataBlocks, minAddr: merged.minAddr, maxAddr: merged.maxAddr,
      segmentNames: singles.map((s) => s.name),
      purpose: singles[0].purpose,
    }));
  }

  // Validate against targetDefinitions
  for (const def of targetDefinitions) {
    const img = targets.get(def.firmwareTarget);
    if (!img) continue;
    const expected = def.bitWidth === 16 ? 'word16' : 'byte8';
    if (img.addrUnit !== expected)
      throw new Error(`目标 ${def.displayName} 位宽配置为 ${def.bitWidth}bit，但 HEX2 实际为 ${img.addrUnit}`);
  }

  return new FirmwareDocument({ format: 'hex2', source: file.name, targets });
}

// ─── Legacy document loader ────────────────────────────────────────────────

export interface LegacyConfig {
  targetType: string;
  legacyFiles?: Record<string, { low?: File; high?: File; single?: File }>;
  targetDefinitions?: GuiTarget[];
}

async function createLegacyDocument(config: LegacyConfig): Promise<FirmwareDocument> {
  const { targetType, legacyFiles = {}, targetDefinitions = [] } = config;
  const targets = new Map<string, ParsedTargetImage>();
  const selectedDef = targetDefinitions.find((d) => d.id === targetType);

  if (selectedDef) {
    const files = legacyFiles[targetType] ?? {};
    if (selectedDef.bitWidth === 16) {
      if (!files.low || !files.high) throw new Error(`${selectedDef.displayName} 缺少低字节或高字节 HEX 文件`);
      const lowContent = await files.low.text();
      const highContent = await files.high.text();
      const merged = mergeWordData(parseIntelHexContent(lowContent), parseIntelHexContent(highContent));
      targets.set(selectedDef.firmwareTarget, new ParsedTargetImage({
        target: selectedDef.firmwareTarget, addrUnit: 'word16',
        dataBlocks: merged.dataBlocks, minAddr: merged.minAddr, maxAddr: merged.maxAddr,
        segmentNames: [`legacy-${targetType}-low`, `legacy-${targetType}-high`],
        purpose: 'firmware',
      }));
    } else {
      if (!files.single) throw new Error(`${selectedDef.displayName} 缺少 HEX 文件`);
      const content = await files.single.text();
      const merged = mergeByteData(parseIntelHexContent(content));
      targets.set(selectedDef.firmwareTarget, new ParsedTargetImage({
        target: selectedDef.firmwareTarget, addrUnit: 'byte8',
        dataBlocks: merged.dataBlocks, minAddr: merged.minAddr, maxAddr: merged.maxAddr,
        segmentNames: [`legacy-${targetType}`],
        purpose: 'firmware',
      }));
    }
    return new FirmwareDocument({ format: 'legacy', source: 'legacy', targets });
  }

  throw new Error(`未找到目标定义: ${targetType}`);
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface LoadFirmwareConfig {
  firmwareFormat: 'hex2' | 'legacy';
  hex2File?: File | null;
  targetType?: string;
  legacyFiles?: Record<string, { low?: File; high?: File; single?: File }>;
  targetDefinitions?: GuiTarget[];
}

export async function loadFirmwareDocument(config: LoadFirmwareConfig): Promise<FirmwareDocument> {
  if (config.firmwareFormat === 'hex2') {
    if (!config.hex2File) throw new Error('未选择 HEX2 文件');
    return createHex2Document(config.hex2File, config.targetDefinitions ?? []);
  }
  if (!config.targetType) throw new Error('未指定目标类型');
  return createLegacyDocument({
    targetType: config.targetType,
    legacyFiles: config.legacyFiles,
    targetDefinitions: config.targetDefinitions,
  });
}
