/**
 * HEX2 格式打包工具（浏览器版）
 * 移植自 bl_electron_gui/src/hex2-builder.js
 * 去除 fs 依赖，改为返回 Blob 并触发浏览器下载
 */

import { HexParser } from './hexParser';

export interface Hex2TargetFiles {
  low?: File;
  high?: File;
  single?: File;
}

export interface Hex2SelectedTarget {
  id: string;
  files: Hex2TargetFiles;
}

export interface TargetDefinition {
  id: string;
  firmwareTarget: string;
  displayName: string;
  bitWidth: 8 | 16;
  protocolTargetCode: number;
  flashPriority: number;
  legacySupported: boolean;
  bootloaderErase?: {
    enabled: boolean;
    defaultStart: string;
    defaultEndExclusive: string;
    editable: boolean;
  } | null;
}

export interface CreateHex2Result {
  blob: Blob;
  fileName: string;
  segments: string[];
  targetCount: number;
}

function parseHexLine(line: string): { recordType: number; line: string } {
  if (!line.startsWith(':')) throw new Error(`无效的 Intel HEX 记录: ${line}`);
  const hexStr = line.substring(1);
  const bytes: number[] = [];
  for (let i = 0; i < hexStr.length; i += 2) {
    bytes.push(parseInt(hexStr.substring(i, i + 2), 16));
  }
  if (bytes.length < 5) throw new Error(`Intel HEX 记录过短: ${line}`);

  let checksum = 0;
  for (let i = 0; i < bytes.length - 1; i++) checksum += bytes[i];
  checksum = (~checksum + 1) & 0xff;
  if (checksum !== bytes[bytes.length - 1]) {
    throw new Error(`校验和错误`);
  }
  return { recordType: bytes[3], line };
}

async function normalizeIntelHexFile(file: File): Promise<string[]> {
  const content = await file.text();
  const lines = content.split(/\r?\n/);
  const normalized: string[] = [];
  let eofSeen = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || !line.startsWith(':')) continue;
    const parsed = parseHexLine(line);
    normalized.push(parsed.line.toUpperCase());
    if (parsed.recordType === 0x01) eofSeen = true;
  }

  if (!normalized.length) throw new Error(`文件中未找到有效的 Intel HEX 记录`);
  if (!eofSeen) throw new Error(`文件缺少 Intel HEX EOF 记录`);
  return normalized;
}

function createSegmentHeader(opts: {
  name: string;
  target: string;
  addrUnit: string;
  combine: string;
}): string {
  return `@SEGMENT name=${opts.name} target=${opts.target} addr-unit=${opts.addrUnit} combine=${opts.combine} purpose=firmware`;
}

function appendSegment(lines: string[], header: string, body: string[]) {
  lines.push(header);
  lines.push(...body);
  lines.push('');
}

export async function createHex2Bundle(
  targetDefinitions: TargetDefinition[],
  selectedTargets: Hex2SelectedTarget[],
  outputFileName = 'firmware.hex2'
): Promise<CreateHex2Result> {
  if (!selectedTargets.length) {
    throw new Error('至少需要选择一个目标来生成 HEX2');
  }

  const lines: string[] = ['@HEX2 version=1', ''];
  const createdSegments: string[] = [];

  for (const selectedTarget of selectedTargets) {
    const def = targetDefinitions.find((d) => d.id === selectedTarget.id);
    if (!def) throw new Error(`未知目标: ${selectedTarget.id}`);

    const files = selectedTarget.files;

    if (def.bitWidth === 16) {
      if (!files.low || !files.high) {
        throw new Error(`${def.displayName} 需要同时提供低字节和高字节 HEX 文件`);
      }
      const lowLines = await normalizeIntelHexFile(files.low);
      const highLines = await normalizeIntelHexFile(files.high);
      appendSegment(
        lines,
        createSegmentHeader({ name: `${def.id}-low`, target: def.firmwareTarget, addrUnit: 'word16', combine: 'pair-low' }),
        lowLines
      );
      appendSegment(
        lines,
        createSegmentHeader({ name: `${def.id}-high`, target: def.firmwareTarget, addrUnit: 'word16', combine: 'pair-high' }),
        highLines
      );
      createdSegments.push(`${def.displayName}: low/high`);
    } else {
      if (!files.single) throw new Error(`${def.displayName} 需要提供 HEX 文件`);
      const singleLines = await normalizeIntelHexFile(files.single);
      appendSegment(
        lines,
        createSegmentHeader({ name: def.id, target: def.firmwareTarget, addrUnit: 'byte8', combine: 'none' }),
        singleLines
      );
      createdSegments.push(`${def.displayName}: single`);
    }
  }

  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
  return { blob, fileName: outputFileName, segments: createdSegments, targetCount: selectedTargets.length };
}

/** 触发浏览器下载 */
export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

// Re-export HexParser so consumers can use it alongside hex2Builder
export { HexParser };
