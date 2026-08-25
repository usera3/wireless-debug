import type {
  AddressResult,
  Die,
  SymbolEntry,
  VariableSuggestion,
  VariableSuggestionKind,
} from './model';
import { parseElfBinary } from './binary-parser';

const WRAPPER_TAGS = new Set([
  'DW_TAG_typedef',
  'DW_TAG_const_type',
  'DW_TAG_volatile_type',
  'DW_TAG_reference_type',
  'DW_TAG_rvalue_reference_type',
]);
const MAX_SUGGESTIONS = 50;

interface TypeCursor {
  die: Die;
  dimension: number;
}

interface ArrayDimension {
  lower: number;
  upper?: number;
}

interface TraversalResult {
  symbol: SymbolEntry;
  address: bigint;
  cursor?: TypeCursor;
}

export class AddressParser {
  private readonly variables = new Map<string, Die>();
  private readonly diesByUnitOffset = new Map<string, Die>();
  private readonly variablesByAddress = new Map<string, Die>();
  private readonly signatures = new Map<string, Die[]>();
  private readonly variableNames: string[];
  constructor(private readonly symbols: Map<string, SymbolEntry>, private readonly dies: Map<number, Die>, signatures = new Map<string, Die[]>()) {
    this.signatures = signatures;
    this.variableNames = [...symbols.keys()].sort();
    for (const die of dies.values()) {
      this.diesByUnitOffset.set(`${die.unit}:${die.offset}`, die);
      if (die.tag !== "DW_TAG_variable") continue;
      const name = normalizedName(die.attrs.get("DW_AT_name"));
      const location = die.attrs.get("DW_AT_location");
      const address = locationAddress(location);
      if (address) this.variablesByAddress.set(address, die);
      if (typeof name === "string") {
        const existing = this.variables.get(name);
        if (!existing || (typeof location === "string" && location.includes("DW_OP_addr"))) this.variables.set(name, die);
      }
    }
    for (const [name, symbol] of symbols) {
      const address = symbol.address.toString(16);
      const variable = this.variablesByAddress.get(address) ?? this.variables.get(name);
      if (variable) this.variables.set(name, variable);
    }
  }

  static fromText(symbolText: string, dwarfText: string): AddressParser {
    const parsed = parseDwarfLocal(dwarfText);
    return new AddressParser(parseSymbolsLocal(symbolText), parsed.dies, parsed.signatures);
  }

  static fromBinary(input: ArrayBuffer | Uint8Array): AddressParser {
    const parsed = parseElfBinary(input);
    return new AddressParser(parsed.symbols, parsed.dies, parsed.signatures);
  }

  getVariableNames(): string[] { return [...this.variableNames]; }

  getSuggestions(query: string, limit = MAX_SUGGESTIONS): VariableSuggestion[] {
    const clean = query.replace(/\s+/g, '');
    const cappedLimit = normalizeSuggestionLimit(limit);
    if (!clean || cappedLimit === 0) return [];

    const arrayContext = clean.match(/^(.*)\[([0-9]*)$/);
    if (arrayContext?.[1]) {
      return this.suggestArrayIndices(arrayContext[1], arrayContext[2], cappedLimit);
    }

    const memberSeparator = clean.lastIndexOf('.');
    if (memberSeparator >= 0) {
      const parent = clean.slice(0, memberSeparator);
      const memberPrefix = clean.slice(memberSeparator + 1);
      if (parent && /^[^.[\]]*$/.test(memberPrefix)) {
        return this.suggestMembers(parent, memberPrefix, cappedLimit);
      }
    } else if (!clean.includes('[')) {
      const normalized = clean.toLocaleLowerCase();
      return this.variableNames
        .filter((name) => name.toLocaleLowerCase().startsWith(normalized))
        .slice(0, cappedLimit)
        .map((name) => this.suggestionFor(name, this.variableCursor(name)));
    }

    try {
      const state = this.traverse(clean);
      return [this.suggestionFor(clean, state.cursor)];
    } catch {
      return [];
    }
  }

  resolve(expression: string): AddressResult {
    const clean = expression.replace(/\s+/g, '');
    const state = this.traverse(clean);
    return {
      expression: clean,
      address: state.address,
      type: state.cursor ? this.displayType(this.currentType(state.cursor)) : undefined,
      offset: state.address - state.symbol.address,
    };
  }

  private traverse(expression: string): TraversalResult {
    const parts = expression.split('.');
    const rootPart = parts.shift();
    if (!rootPart) throw new Error(`Invalid variable expression: ${expression}`);
    const root = parseExpressionPart(rootPart, `Invalid variable expression: ${expression}`);
    const symbol = this.symbols.get(root.name);
    if (!symbol) throw new Error(`Variable not found: ${root.name}`);

    let address = symbol.address;
    let cursor = this.variableCursor(root.name);
    if ((root.indices.length > 0 || parts.length > 0) && !cursor) {
      throw new Error(`DWARF type information is unavailable for ${root.name}`);
    }
    for (const index of root.indices) {
      const indexed = this.consumeIndex(cursor!, index, root.name);
      address += indexed.offset;
      cursor = indexed.cursor;
    }

    for (const part of parts) {
      const parsed = parseExpressionPart(part, `Invalid member: ${part}`);
      if (!cursor) throw new Error(`DWARF type information is unavailable for ${root.name}`);
      const structure = this.currentType(cursor);
      if (!isStructure(structure)) throw new Error(`${parts[0] ?? root.name} is not a structure or union`);
      const member = structure.children.find(
        (candidate) => candidate.tag === 'DW_TAG_member'
          && candidate.attrs.get('DW_AT_name') === parsed.name,
      );
      if (!member) throw new Error(`Member not found: ${parsed.name}`);
      address += BigInt(this.location(member.attrs.get('DW_AT_data_member_location')));
      cursor = { die: this.ref(member), dimension: 0 };
      for (const index of parsed.indices) {
        const indexed = this.consumeIndex(cursor, index, parsed.name);
        address += indexed.offset;
        cursor = indexed.cursor;
      }
    }

    return { symbol, address, cursor };
  }

  private suggestMembers(parent: string, prefix: string, limit: number): VariableSuggestion[] {
    try {
      const state = this.traverse(parent);
      if (!state.cursor) return [];
      const structure = this.currentType(state.cursor);
      if (!isStructure(structure)) return [];
      const normalized = prefix.toLocaleLowerCase();
      return structure.children
        .filter((member) => member.tag === 'DW_TAG_member')
        .filter((member) => {
          const name = String(member.attrs.get('DW_AT_name') ?? '');
          return name && name.toLocaleLowerCase().startsWith(normalized);
        })
        .sort((left, right) => String(left.attrs.get('DW_AT_name')).localeCompare(String(right.attrs.get('DW_AT_name'))))
        .slice(0, limit)
        .map((member) => {
          const name = String(member.attrs.get('DW_AT_name'));
          return this.suggestionFor(`${parent}.${name}`, { die: this.ref(member), dimension: 0 });
        });
    } catch {
      return [];
    }
  }

  private suggestArrayIndices(parent: string, prefix: string, limit: number): VariableSuggestion[] {
    try {
      const state = this.traverse(parent);
      if (!state.cursor) return [];
      const array = this.currentType(state.cursor);
      if (array.tag !== 'DW_TAG_array_type') return [];
      const range = this.arrayDimension(array, state.cursor.dimension);
      if (range.upper === undefined) return [];
      return matchingIndices(range.lower, range.upper, prefix, limit).map((index) => {
        const indexed = this.consumeIndex(state.cursor!, index, parent);
        return this.suggestionFor(`${parent}[${index}]`, indexed.cursor);
      });
    } catch {
      return [];
    }
  }

  private suggestionFor(expression: string, cursor?: TypeCursor): VariableSuggestion {
    const kind = this.suggestionKind(cursor);
    return {
      expression,
      kind,
      continuation: kind === 'array' ? '[' : kind === 'structure' || kind === 'union' ? '.' : '',
    };
  }

  private suggestionKind(cursor?: TypeCursor): VariableSuggestionKind {
    if (!cursor) return 'value';
    const type = this.currentType(cursor);
    if (type.tag === 'DW_TAG_array_type') return 'array';
    if (type.tag === 'DW_TAG_union_type') return 'union';
    if (type.tag === 'DW_TAG_structure_type' || type.tag === 'DW_TAG_class_type') return 'structure';
    return 'value';
  }

  private variableCursor(name: string): TypeCursor | undefined {
    try {
      return { die: this.variableType(name), dimension: 0 };
    } catch {
      return undefined;
    }
  }

  private currentType(cursor: TypeCursor): Die {
    return this.unwrap(cursor.die);
  }

  private consumeIndex(cursor: TypeCursor, index: number, label: string): { cursor: TypeCursor; offset: bigint } {
    const array = this.currentType(cursor);
    if (array.tag !== 'DW_TAG_array_type') throw new Error(`${label} is not an array`);
    const dimensions = this.arrayDimensions(array);
    const range = this.arrayDimension(array, cursor.dimension);
    if (index < range.lower || (range.upper !== undefined && index > range.upper)) {
      throw new Error(`Array index ${index} is out of range for ${label}`);
    }
    const offset = BigInt(index - range.lower) * BigInt(this.arrayStride(array, dimensions, cursor.dimension));
    const next = cursor.dimension + 1;
    return {
      cursor: next < dimensions.length
        ? { die: array, dimension: next }
        : { die: this.ref(array), dimension: 0 },
      offset,
    };
  }

  private arrayDimensions(array: Die): ArrayDimension[] {
    const dimensions = array.children
      .filter((child) => child.tag === 'DW_TAG_subrange_type')
      .map((child) => {
        const lower = numberValue(child.attrs.get('DW_AT_lower_bound')) ?? 0;
        const count = numberValue(child.attrs.get('DW_AT_count'));
        const explicitUpper = numberValue(child.attrs.get('DW_AT_upper_bound'));
        return {
          lower,
          upper: explicitUpper ?? (count === undefined ? undefined : lower + count - 1),
        };
      });
    if (dimensions.length > 0) return dimensions;

    const totalSize = numberValue(array.attrs.get('DW_AT_byte_size'));
    const elementSize = this.byteSize(this.ref(array));
    if (totalSize !== undefined && elementSize !== undefined && elementSize > 0) {
      return [{ lower: 0, upper: Math.max(0, Math.floor(totalSize / elementSize) - 1) }];
    }
    return [{ lower: 0 }];
  }

  private arrayDimension(array: Die, index: number): ArrayDimension {
    return this.arrayDimensions(array)[index] ?? { lower: 0 };
  }

  private arrayStride(array: Die, dimensions: ArrayDimension[], dimension: number): number {
    const elementSize = this.byteSize(this.ref(array));
    if (elementSize === undefined) throw new Error('Array element size is unavailable');
    let stride = elementSize;
    for (const remaining of dimensions.slice(dimension + 1)) {
      if (remaining.upper === undefined) throw new Error('Array bounds are unavailable');
      stride *= remaining.upper - remaining.lower + 1;
    }
    if (!Number.isSafeInteger(stride) || stride < 0) throw new Error('Array stride is invalid');
    return stride;
  }

  private byteSize(die: Die): number | undefined {
    return numberValue(this.unwrap(die).attrs.get('DW_AT_byte_size'));
  }

  private variableType(name: string): Die {
    const variable = this.variables.get(name);
    if (!variable) throw new Error(`DWARF type information is unavailable for ${name}`);
    return this.ref(variable);
  }
  private ref(die: Die): Die {
    const ref = die.attrs.get("DW_AT_type");
    if (typeof ref === "string" && ref.startsWith("signature:")) {
      const candidates = this.signatures.get(ref.slice(10));
      if (!candidates?.length) throw new Error(`Missing DWARF type signature ${ref.slice(10)}`);
      return candidates[0];
    }
    if (typeof ref !== "number") throw new Error(`DIE ${die.offset.toString(16)} has no type`);
    return this.diesByUnitOffset.get(`${die.unit}:${ref}`) ?? this.dies.get(ref) ?? (() => { throw new Error(`Missing DIE 0x${ref.toString(16)} in unit ${die.unit}`); })();
  }
  private unwrap(die: Die): Die { let current = die, guard = 0; while ((WRAPPER_TAGS.has(current.tag) || current.tag.startsWith('User TAG value:')) && guard++ < 32) { if (!current.attrs.has('DW_AT_type')) break; current = this.ref(current); } return current; }
  private location(value: string | number | undefined): number { if (typeof value === "number") return value; const op = value?.match(/DW_OP_plus_uconst:\s*(\d+)/); if (op) return Number(op[1]); const n = value?.match(/\d+/); if (!n) return 0; return Number(n[0]); }
  private displayType(die: Die): string | undefined { return String(die.attrs.get("DW_AT_name") ?? die.tag); }
}

function normalizedName(value: string | number | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/:\s*([^:]+)$/);
  return (match ? match[1] : value).trim();
}

function locationAddress(value: string | number | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/DW_OP_addr:\s*(?:0x)?([0-9a-f]+)/i);
  return match ? BigInt(`0x${match[1]}`).toString(16) : undefined;
}

function numberValue(value: string | number | undefined): number | undefined { if (typeof value === "number") return value; const m = value?.match(/0x[0-9a-f]+|\d+/i); return m ? Number(m[0]) : undefined; }

function parseExpressionPart(value: string, error: string): { name: string; indices: number[] } {
  const match = value.match(/^([^.[\]]+)((?:\[\d+\])*)$/);
  if (!match) throw new Error(error);
  return {
    name: match[1],
    indices: [...match[2].matchAll(/\[(\d+)\]/g)].map((item) => Number(item[1])),
  };
}

function isStructure(die: Die): boolean {
  return die.tag === 'DW_TAG_structure_type'
    || die.tag === 'DW_TAG_union_type'
    || die.tag === 'DW_TAG_class_type';
}

function normalizeSuggestionLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(MAX_SUGGESTIONS, Math.floor(limit));
}

function matchingIndices(lower: number, upper: number, prefix: string, limit: number): number[] {
  if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper) || upper < lower || limit <= 0) return [];
  const first = Math.max(0, lower);
  if (!prefix) {
    const count = Math.min(limit, Math.max(0, upper - first + 1));
    return Array.from({ length: count }, (_, index) => first + index);
  }
  if (prefix.startsWith('0')) return prefix === '0' && first === 0 ? [0] : [];

  const prefixValue = Number(prefix);
  if (!Number.isSafeInteger(prefixValue)) return [];
  const result: number[] = [];
  for (let scale = 1; result.length < limit; scale *= 10) {
    const intervalStart = prefixValue * scale;
    if (!Number.isSafeInteger(intervalStart) || intervalStart > upper) break;
    const intervalEnd = Math.min(upper, (prefixValue + 1) * scale - 1);
    const start = Math.max(first, intervalStart);
    for (let value = start; value <= intervalEnd && result.length < limit; value += 1) {
      result.push(value);
    }
    if (scale > Number.MAX_SAFE_INTEGER / 10) break;
  }
  return result;
}
function parseSymbolsLocal(text: string): Map<string, SymbolEntry> { const result = new Map<string, SymbolEntry>(); for (const line of text.split(/\r?\n/)) { const m = line.match(/^\s*\d+:\s*([0-9a-f]+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(?:\S+)\s+(\S+)\s*$/i); if (m && ["OBJECT", "NOTYPE"].includes(m[3]) && !["UND", "ABS"].includes(m[6])) result.set(m[6], { name: m[6], address: BigInt(`0x${m[1]}`), size: BigInt(m[2]), type: m[3], bind: m[4] }); } return result; }
function parseDwarfLocal(text: string): { dies: Map<number, Die>; signatures: Map<string, Die[]> } {
  const dies = new Map<number, Die>(), signatures = new Map<string, Die[]>(), stack: Die[] = [];
  let unit = 0, unitBase = 0, currentSignature: string | undefined, typeOffset: number | undefined, pendingSignatureKey: string | undefined, pendingUnitSignature = false;
  for (const line of text.split(/\r?\n/)) {
    const cu = line.match(/^\s*Compilation Unit @ offset\s+(0x)?([0-9a-f]+)/i);
    if (cu) { unit++; unitBase = parseInt(cu[2], 16); currentSignature = undefined; typeOffset = undefined; pendingSignatureKey = undefined; pendingUnitSignature = false; stack.length = 0; continue; }
    const sig = line.match(/^\s*Signature:\s*0x([0-9a-f]+)/i);
    if (sig) { currentSignature = sig[1].toLowerCase(); pendingUnitSignature = true; continue; }
    if (pendingUnitSignature && /^\s*[0-9a-f]+\s*$/i.test(line)) { currentSignature += line.trim().toLowerCase(); pendingUnitSignature = false; continue; }
    const to = line.match(/^\s*Type Offset:\s*0x([0-9a-f]+)/i);
    if (to) { typeOffset = parseInt(to[1], 16); continue; }
    const h = line.match(/^\s*<(\d+)><([0-9a-f]+)>:\s+Abbrev Number:\s+\d+\s+\(([^)]+)\)/i);
    if (h) {
      const depth = Number(h[1]); while (stack.length > depth) stack.pop();
      const die: Die = { offset: parseInt(h[2], 16), unit, unitBase, tag: h[3], attrs: new Map(), children: [] };
      if (stack.length) stack[stack.length - 1].children.push(die); stack.push(die);
      let key = die.offset;
      while (dies.has(key)) key += 0x100000000;
      dies.set(key, die);
      if (currentSignature && typeOffset !== undefined && unitBase + typeOffset === die.offset) {
        const candidates = signatures.get(currentSignature) ?? [];
        candidates.push(die);
        signatures.set(currentSignature, candidates);
      }
      continue;
    }
    const attr = line.match(/DW_AT_([a-z0-9_]+)\s*:\s*(.*)$/i);
    if (attr && stack.length) {
      const key = `DW_AT_${attr[1]}`, raw = attr[2].trim();
      const ref = raw.match(/<0x([0-9a-f]+)>/i), signature = raw.match(/signature:\s*0x([0-9a-f]+)/i), numeric = raw.match(/^-?\d+$/);
      if (signature) { stack[stack.length - 1].attrs.set(key, `signature:${signature[1].toLowerCase()}`); pendingSignatureKey = key; }
      else stack[stack.length - 1].attrs.set(key, ref ? parseInt(ref[1], 16) : numeric ? Number(raw) : raw.replace(/^\(indirect string, offset: [^)]+\):\s*/, ""));
    }
    else if (pendingSignatureKey && stack.length && /^\s*[0-9a-f]+\s*$/i.test(line)) {
      const previous = stack[stack.length - 1].attrs.get(pendingSignatureKey);
      if (typeof previous === "string" && previous.startsWith("signature:")) stack[stack.length - 1].attrs.set(pendingSignatureKey, `${previous}${line.trim().toLowerCase()}`);
      pendingSignatureKey = undefined;
    }
  }
  return { dies, signatures };
}
