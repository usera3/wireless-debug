export type DieTag = string;

export interface Die {
  offset: number;
  unit: number;
  unitBase?: number;
  tag: DieTag;
  attrs: Map<string, string | number>;
  children: Die[];
}

export interface SymbolEntry { name: string; address: bigint; size: bigint; type: string; bind: string; }

export interface AddressResult {
  expression: string;
  address: bigint;
  type?: string;
  offset: bigint;
}
