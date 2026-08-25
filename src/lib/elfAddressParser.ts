import { AddressParser } from './elfParser/address-parser';
import type { AddressResult, VariableSuggestion } from './elfParser/model';

export type ElfAddressParser = Pick<AddressParser, 'getVariableNames' | 'getSuggestions' | 'resolve'>;
export type { AddressResult, VariableSuggestion };

// Parsing retains a compact DWARF type graph, but the browser still needs one
// temporary ArrayBuffer while reading the upload. Keep that peak bounded.
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
  const cappedLimit = Math.min(50, Math.max(0, Math.floor(limit)));
  if (!normalized || cappedLimit <= 0) return [];
  return names
    .filter((name) => name.toLocaleLowerCase().startsWith(normalized))
    .slice(0, cappedLimit);
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

export function buildElfChannelPatch(
  expression: string,
  address: bigint | number,
): { label: string; varAddrHex: string } {
  const value = typeof address === 'bigint' ? address : BigInt(address);
  if (value < 0n || value > 0xffffn) {
    const displayAddress = value < 0n ? value.toString(16).toUpperCase() : formatElfAddress(value);
    throw new Error(`变量地址 ${displayAddress} 超出 16 位示波器地址范围`);
  }
  return {
    label: expression,
    varAddrHex: formatElfAddress(value),
  };
}
