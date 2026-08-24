import type { AddressResult, Die, SymbolEntry } from './model';
import { parseElfBinary } from './binary-parser';

const TYPE_TAGS = new Set(["DW_TAG_structure_type", "DW_TAG_union_type", "DW_TAG_base_type", "DW_TAG_array_type", "DW_TAG_typedef", "DW_TAG_const_type", "DW_TAG_volatile_type", "DW_TAG_pointer_type", "DW_TAG_enumeration_type"]);

export class AddressParser {
  private readonly variables = new Map<string, Die>();
  private readonly signatures = new Map<string, Die[]>();
  constructor(private readonly symbols: Map<string, SymbolEntry>, private readonly dies: Map<number, Die>, signatures = new Map<string, Die[]>()) {
    this.signatures = signatures;
    for (const die of dies.values()) if (die.tag === "DW_TAG_variable") {
      const name = normalizedName(die.attrs.get("DW_AT_name"));
      if (typeof name === "string") {
        const location = die.attrs.get("DW_AT_location");
        const existing = this.variables.get(name);
        if (!existing || (typeof location === "string" && location.includes("DW_OP_addr"))) this.variables.set(name, die);
      }
    }
    for (const [name, symbol] of symbols) {
      const address = symbol.address.toString(16);
      const variable = [...dies.values()].find(die => die.tag === "DW_TAG_variable" && locationAddress(die.attrs.get("DW_AT_location")) === address) ?? [...dies.values()].find(die => die.tag === "DW_TAG_variable" && normalizedName(die.attrs.get("DW_AT_name")) === name);
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

  getVariableNames(): string[] { return [...this.symbols.keys()].sort(); }

  resolve(expression: string): AddressResult {
    const clean = expression.replace(/\s+/g, "");
    const parts = clean.split(".");
    const root = parts.shift()!;
    const match = root.match(/^([^[]+)((?:\[\d+\])*)$/);
    if (!match) throw new Error(`Invalid variable expression: ${expression}`);
    const symbol = this.symbols.get(match[1]);
    if (!symbol) throw new Error(`Variable not found: ${match[1]}`);
    let address = symbol.address;
    if (!match[2] && parts.length === 0) return { expression: clean, address, offset: 0n };
    let type = this.variableType(match[1]);
    for (const index of indices(match[2])) { const array = this.unwrap(type); if (array.tag !== "DW_TAG_array_type") throw new Error(`${match[1]} is not an array`); address += BigInt(index * this.elementSize(array)); type = this.ref(array); }
    for (const part of parts) {
      const memberArray = part.match(/^([^[]+)((?:\[\d+\])*)$/); if (!memberArray) throw new Error(`Invalid member: ${part}`);
      const structure = this.unwrap(type), member = structure.children.find(x => x.tag === "DW_TAG_member" && x.attrs.get("DW_AT_name") === memberArray[1]);
      if (!member) throw new Error(`Member not found: ${memberArray[1]}`);
      address += BigInt(this.location(member.attrs.get("DW_AT_data_member_location")));
      type = this.ref(member);
      for (const index of indices(memberArray[2])) { const array = this.unwrap(type); if (array.tag !== "DW_TAG_array_type") throw new Error(`${memberArray[1]} is not an array`); address += BigInt(index * this.elementSize(array)); type = this.ref(array); }
    }
    return { expression: clean, address, type: this.displayType(this.unwrap(type)), offset: address - symbol.address };
  }

  private variableType(name: string): Die {
    const variable = this.variables.get(name);
    if (!variable) throw new Error(`DWARF variable not found: ${name} (variables=${this.variables.size}, dies=${this.dies.size}, candidates=${[...this.dies.values()].filter(die => die.tag === "DW_TAG_variable" && String(die.attrs.get("DW_AT_name")).toLowerCase().includes(name.toLowerCase())).length}, near=${[...this.dies.values()].filter(die => die.offset >= 0x477c && die.offset <= 0x4792).map(die => `${die.tag}:${String(die.attrs.get("DW_AT_name"))}`).join(",")})`);
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
    return [...this.dies.values()].find(candidate => candidate.unit === die.unit && candidate.offset === ref) ?? this.dies.get(ref) ?? (() => { throw new Error(`Missing DIE 0x${ref.toString(16)} in unit ${die.unit}`); })();
  }
  private unwrap(die: Die): Die { let current = die, guard = 0; while ((TYPE_TAGS.has(current.tag) || current.tag.startsWith("User TAG value:")) && current.tag !== "DW_TAG_structure_type" && current.tag !== "DW_TAG_union_type" && current.tag !== "DW_TAG_array_type" && guard++ < 32) { if (!current.attrs.has("DW_AT_type")) break; current = this.ref(current); } return current; }
  private elementSize(array: Die): number { const base = this.unwrap(this.ref(array)), size = numberValue(base.attrs.get("DW_AT_byte_size")); if (size === undefined) throw new Error(`Array element size is unavailable`); return size; }
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

function indices(value: string): number[] { return [...value.matchAll(/\[(\d+)\]/g)].map(x => Number(x[1])); }
function numberValue(value: string | number | undefined): number | undefined { if (typeof value === "number") return value; const m = value?.match(/0x[0-9a-f]+|\d+/i); return m ? Number(m[0]) : undefined; }
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
