import { AddressParser } from './elfParser/address-parser';
import type { AddressResult } from './elfParser/model';

export type ElfAddressParser = Pick<AddressParser, 'getVariableNames' | 'resolve'>;
export type { AddressResult };

// Keep the parser's full-file buffer and DWARF model within a predictable browser budget.
export const MAX_ELF_FILE_BYTES = 64 * 1024 * 1024;

export async function createElfAddressParser(file: Blob): Promise<ElfAddressParser> {
  if (file.size > MAX_ELF_FILE_BYTES) {
    throw new Error(`ELF 文件过大（${Math.ceil(file.size / 1024 / 1024)} MB），请使用不超过 64 MB 的带调试信息文件`);
  }
  return AddressParser.fromBinary(await file.arrayBuffer());
}

export function filterElfVariableNames(
  names: readonly string[],
  query: string,
  limit = 50,
): string[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized || limit <= 0) return [];
  return names
    .filter((name) => name.toLocaleLowerCase().startsWith(normalized))
    .slice(0, limit);
}

export function parseManualAddress(value: string): number | null {
  const normalized = value.trim().replace(/^0x/i, '');
  if (!normalized || !/^[0-9a-f]+$/i.test(normalized)) return null;
  const address = Number.parseInt(normalized, 16);
  return Number.isSafeInteger(address) ? address : null;
}

export function formatElfAddress(address: bigint | number): string {
  const value = typeof address === 'bigint' ? address : BigInt(address);
  if (value < 0n) throw new Error('ELF address must be non-negative');
  return value.toString(16).toUpperCase().padStart(4, '0');
}
