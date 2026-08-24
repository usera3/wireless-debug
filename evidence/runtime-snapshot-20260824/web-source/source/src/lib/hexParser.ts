/**
 * Intel HEX 文件解析器（浏览器版）
 * 移植自 bl_electron_gui/src/hex-parser.js
 * 去除 fs/require，改用 File.text() API
 */

export interface HexSummary {
  is16bitMode: boolean;
  blockCount: number;
  minAddr: number;
  maxAddr: number;
  totalBytes: number;
  totalWords?: number;
  crc32: number;
  startAddr: number;
  target?: string;
}

export interface ParseResult {
  success: true;
  summary: HexSummary;
}

export interface ParseError {
  success: false;
  error: string;
}

// CRC32 查表法
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export class HexParser {
  is16bitMode = false;
  dataBlocks = new Map<number, Uint8Array>();
  minAddr = 0;
  maxAddr = 0;

  reset() {
    this.dataBlocks.clear();
    this.minAddr = 0;
    this.maxAddr = 0;
    this.is16bitMode = false;
  }

  /** 解析两个 HEX 文件（低字节 + 高字节）— 16 位内存模式 */
  async parseFiles(lowFile: File, highFile: File): Promise<ParseResult | ParseError> {
    this.reset();
    this.is16bitMode = true;
    try {
      const lowData = await this._parseIntelHex(lowFile);
      const highData = await this._parseIntelHex(highFile);

      const lowAddrs = Array.from(lowData.keys()).sort((a, b) => a - b);
      const highAddrs = Array.from(highData.keys()).sort((a, b) => a - b);

      if (lowAddrs.length !== highAddrs.length) {
        throw new Error('高低字节 HEX 文件的数据长度不匹配');
      }
      for (let i = 0; i < lowAddrs.length; i++) {
        if (lowAddrs[i] !== highAddrs[i]) {
          throw new Error(
            `地址不匹配: 低字节=0x${lowAddrs[i].toString(16)}, 高字节=0x${highAddrs[i].toString(16)}`
          );
        }
      }

      this.minAddr = lowAddrs[0] ?? 0;
      this.maxAddr = lowAddrs[lowAddrs.length - 1] ?? 0;
      this._mergeC2000Data(lowData, highData);

      return { success: true, summary: this.getSummary() };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  /** 解析单个 HEX 文件 — 8 位内存模式 */
  async parseSingleFile(file: File): Promise<ParseResult | ParseError> {
    this.reset();
    this.is16bitMode = false;
    try {
      const data = await this._parseIntelHex(file);
      const addrs = Array.from(data.keys()).sort((a, b) => a - b);

      if (addrs.length === 0) throw new Error('HEX 文件为空');

      this.minAddr = addrs[0];
      this.maxAddr = addrs[addrs.length - 1];
      this._mergeSingleFileData(data);

      return { success: true, summary: this.getSummary() };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  getDataBlocks(): Map<number, Uint8Array> {
    return this.dataBlocks;
  }

  getSummary(): HexSummary {
    const appInfo = this._getAppInfo();
    const summary: HexSummary = {
      is16bitMode: this.is16bitMode,
      blockCount: this.dataBlocks.size,
      minAddr: this.minAddr,
      maxAddr: this.maxAddr,
      totalBytes: appInfo.length,
      crc32: appInfo.crc32,
      startAddr: appInfo.startAddr,
    };
    if (this.is16bitMode) {
      summary.totalWords = appInfo.length / 2;
    }
    return summary;
  }

  /** 解析 AppInfo 结构体（固定偏移，68 字节） */
  parseAppInfo(address: number) {
    const appInfoSize = 68;
    const { buffer, missing } = this._readBytesAt(address, appInfoSize);

    if (missing > 0) {
      return { success: false, error: `AppInfo 数据不完整: 缺失 ${missing} 字节` };
    }

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

    const tagLength = Math.min(appInfo.gitTagLength, 32);
    for (let i = 0; i < tagLength; i++) {
      const ch = buffer[36 + i];
      if (ch === 0) break;
      appInfo.gitTag += String.fromCharCode(ch);
    }

    return { success: true, appInfo };
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async _parseIntelHex(file: File): Promise<Map<number, number>> {
    const content = await file.text();
    const lines = content.split(/\r?\n/);
    const data = new Map<number, number>();
    let extendedAddr = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith(':')) continue;

      const bytes = this._hexLineToBytes(trimmed.substring(1));
      if (bytes.length < 5) continue;

      const byteCount = bytes[0];
      const address = (bytes[1] << 8) | bytes[2];
      const recordType = bytes[3];
      const dataBytes = bytes.slice(4, 4 + byteCount);
      const checksum = bytes[4 + byteCount];

      let sum = 0;
      for (let i = 0; i < 4 + byteCount; i++) sum += bytes[i];
      sum = (~sum + 1) & 0xff;
      if (sum !== checksum) {
        throw new Error(`校验和错误: 计算=0x${sum.toString(16)}, 实际=0x${checksum.toString(16)}`);
      }

      switch (recordType) {
        case 0x00: {
          const fullAddr = extendedAddr + address;
          for (let i = 0; i < dataBytes.length; i++) {
            data.set(fullAddr + i, dataBytes[i]);
          }
          break;
        }
        case 0x01:
          break;
        case 0x02:
          extendedAddr = ((dataBytes[0] << 8) | dataBytes[1]) << 4;
          break;
        case 0x04:
          extendedAddr = ((dataBytes[0] << 8) | dataBytes[1]) << 16;
          break;
        default:
          break;
      }
    }

    return data;
  }

  private _hexLineToBytes(hexStr: string): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < hexStr.length; i += 2) {
      bytes.push(parseInt(hexStr.substring(i, i + 2), 16));
    }
    return bytes;
  }

  private _mergeC2000Data(lowData: Map<number, number>, highData: Map<number, number>) {
    this.dataBlocks.clear();
    const addresses = Array.from(lowData.keys()).sort((a, b) => a - b);
    if (addresses.length === 0) return;

    let currentBlockAddr = addresses[0];
    let currentData: number[] = [];
    let lastAddr = addresses[0] - 1;

    for (const addr of addresses) {
      if (addr > lastAddr + 1 && currentData.length > 0) {
        this.dataBlocks.set(currentBlockAddr, new Uint8Array(currentData));
        currentData = [];
        currentBlockAddr = addr;
        lastAddr = addr - 1;
      }
      while (lastAddr + 1 < addr) {
        currentData.push(0xff, 0xff);
        lastAddr++;
      }
      currentData.push(lowData.get(addr)!, highData.get(addr)!);
      lastAddr = addr;
    }
    if (currentData.length > 0) {
      this.dataBlocks.set(currentBlockAddr, new Uint8Array(currentData));
    }
  }

  private _mergeSingleFileData(data: Map<number, number>) {
    this.dataBlocks.clear();
    const addresses = Array.from(data.keys()).sort((a, b) => a - b);
    if (addresses.length === 0) return;

    let currentBlockAddr = addresses[0];
    let currentData: number[] = [];
    let lastAddr = addresses[0] - 1;

    for (const addr of addresses) {
      if (addr > lastAddr + 1 && currentData.length > 0) {
        this.dataBlocks.set(currentBlockAddr, new Uint8Array(currentData));
        currentData = [];
        currentBlockAddr = addr;
        lastAddr = addr - 1;
      }
      while (lastAddr + 1 < addr) {
        currentData.push(0xff);
        lastAddr++;
      }
      currentData.push(data.get(addr)!);
      lastAddr = addr;
    }
    if (currentData.length > 0) {
      this.dataBlocks.set(currentBlockAddr, new Uint8Array(currentData));
    }
  }

  private _getAppInfo() {
    const totalBytes = Array.from(this.dataBlocks.values()).reduce(
      (sum, buf) => sum + buf.length,
      0
    );
    const blocks = Array.from(this.dataBlocks.entries()).sort((a, b) => a[0] - b[0]);
    const parts = blocks.map(([, d]) => d);
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const p of parts) {
      merged.set(p, offset);
      offset += p.length;
    }
    return {
      startAddr: this.minAddr,
      length: totalBytes,
      crc32: crc32(merged),
    };
  }

  private _readBytesAt(address: number, length: number): { buffer: Uint8Array; missing: number } {
    const buffer = new Uint8Array(length).fill(0xff);
    const blocks = Array.from(this.dataBlocks.entries()).sort((a, b) => a[0] - b[0]);
    let missing = 0;

    for (let i = 0; i < length; i++) {
      let found = false;
      if (this.is16bitMode) {
        const wordAddr = address + Math.floor(i / 2);
        const byteInWord = i % 2;
        for (const [blockStart, blockData] of blocks) {
          const blockWordLength = Math.floor(blockData.length / 2);
          if (wordAddr >= blockStart && wordAddr < blockStart + blockWordLength) {
            buffer[i] = blockData[(wordAddr - blockStart) * 2 + byteInWord];
            found = true;
            break;
          }
        }
      } else {
        const byteAddr = address + i;
        for (const [blockStart, blockData] of blocks) {
          if (byteAddr >= blockStart && byteAddr < blockStart + blockData.length) {
            buffer[i] = blockData[byteAddr - blockStart];
            found = true;
            break;
          }
        }
      }
      if (!found) missing++;
    }

    return { buffer, missing };
  }
}
