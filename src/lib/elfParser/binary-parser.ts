import type { Die, SymbolEntry } from './model';

export interface BinaryParseResult {
  symbols: Map<string, SymbolEntry>;
  dies: Map<number, Die>;
  signatures: Map<string, Die[]>;
}

type Section = { name: string; type: number; offset: number; size: number; link: number; info: number; entrySize: number };
type Abbrev = { tag: string; children: boolean; attrs: [number, number, number?][] };

// Only these DIEs participate in address resolution. Keeping compile units,
// subprograms and lexical blocks multiplies memory use for large firmware ELF
// files without adding any information needed by the channel picker.
const RETAINED_TAGS = new Set([
  'DW_TAG_variable',
  'DW_TAG_member',
  'DW_TAG_structure_type',
  'DW_TAG_union_type',
  'DW_TAG_class_type',
  'DW_TAG_array_type',
  'DW_TAG_base_type',
  'DW_TAG_typedef',
  'DW_TAG_const_type',
  'DW_TAG_volatile_type',
  'DW_TAG_pointer_type',
  'DW_TAG_enumeration_type',
  'DW_TAG_subroutine_type',
  'DW_TAG_inheritance',
]);

const TAGS: Record<number, string> = {
  0x01: "DW_TAG_array_type", 0x02: "DW_TAG_class_type", 0x04: "DW_TAG_enumeration_type", 0x05: "DW_TAG_formal_parameter",
  0x0b: "DW_TAG_lexical_block", 0x0d: "DW_TAG_member", 0x0f: "DW_TAG_pointer_type", 0x11: "DW_TAG_compile_unit",
  0x13: "DW_TAG_structure_type", 0x16: "DW_TAG_typedef", 0x17: "DW_TAG_union_type", 0x24: "DW_TAG_base_type",
  0x26: "DW_TAG_const_type", 0x2e: "DW_TAG_subprogram", 0x2f: "DW_TAG_subroutine_type", 0x30: "DW_TAG_reference_type",
  0x31: "DW_TAG_rvalue_reference_type", 0x1d: "DW_TAG_inheritance", 0x34: "DW_TAG_variable", 0x35: "DW_TAG_common_block", 0x36: "DW_TAG_common_inclusion",
  0x3a: "DW_TAG_volatile_type", 0x41: "DW_TAG_type_unit", 0x42: "DW_TAG_rvalue_reference_type",
};
const ATTRS: Record<number, string> = {
  0x02: "DW_AT_location", 0x03: "DW_AT_name", 0x09: "DW_AT_ordering", 0x0b: "DW_AT_byte_size", 0x0c: "DW_AT_bit_offset",
  0x0d: "DW_AT_bit_size", 0x10: "DW_AT_stmt_list", 0x11: "DW_AT_low_pc", 0x12: "DW_AT_high_pc", 0x13: "DW_AT_language",
  0x1c: "DW_AT_comp_dir", 0x1d: "DW_AT_const_value", 0x1f: "DW_AT_containing_type", 0x25: "DW_AT_producer",
  0x27: "DW_AT_prototyped", 0x31: "DW_AT_abstract_origin", 0x32: "DW_AT_accessibility", 0x37: "DW_AT_sibling",
  0x38: "DW_AT_data_member_location", 0x39: "DW_AT_identifier_case", 0x3a: "DW_AT_declaration", 0x3b: "DW_AT_discr_list",
  0x3c: "DW_AT_discr", 0x3d: "DW_AT_discr_value", 0x40: "DW_AT_start_scope", 0x47: "DW_AT_specification",
  0x49: "DW_AT_type", 0x4a: "DW_AT_return_addr", 0x4b: "DW_AT_calling_convention", 0x4c: "DW_AT_count",
  0x4d: "DW_AT_data_member_location", 0x4e: "DW_AT_decl_column", 0x55: "DW_AT_encoding", 0x58: "DW_AT_external",
  0x59: "DW_AT_endianity", 0x5b: "DW_AT_ranges", 0x5c: "DW_AT_trampoline", 0x5d: "DW_AT_call_column",
  0x5e: "DW_AT_call_file", 0x5f: "DW_AT_call_line", 0x60: "DW_AT_description", 0x67: "DW_AT_signature",
  0x68: "DW_AT_main_subprogram", 0x6e: "DW_AT_linkage_name", 0x2000: "DW_AT_MIPS_has_inlines",
};
const FORMS: Record<number, string> = { 0x01: "addr", 0x03: "block2", 0x04: "block4", 0x05: "data2", 0x06: "data4", 0x07: "data8", 0x08: "string", 0x09: "block", 0x0a: "block1", 0x0b: "data1", 0x0c: "flag", 0x0d: "sdata", 0x0e: "strp", 0x0f: "udata", 0x10: "ref_addr", 0x11: "ref1", 0x12: "ref2", 0x13: "ref4", 0x14: "ref8", 0x15: "ref_udata", 0x16: "indirect", 0x17: "sec_offset", 0x18: "exprloc", 0x19: "flag_present", 0x20: "ref_sig8", 0x21: "implicit_const", 0x22: "loclistx", 0x23: "rnglistx", 0x24: "ref_sup4", 0x25: "strx", 0x26: "addrx", 0x27: "ref_sup8", 0x28: "strp_sup", 0x29: "data16", 0x1f: "line_strp" };

class Reader {
  constructor(readonly bytes: Uint8Array, public pos = 0, readonly little = true) {}
  u8() { return this.bytes[this.pos++]; }
  u16() { const v = this.little ? this.bytes[this.pos] | this.bytes[this.pos + 1] << 8 : this.bytes[this.pos] << 8 | this.bytes[this.pos + 1]; this.pos += 2; return v; }
  u32() { const d = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 4); const v = d.getUint32(0, this.little); this.pos += 4; return v; }
  u64() { const d = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 8); const v = d.getBigUint64(0, this.little); this.pos += 8; return v; }
  uleb() { let v = 0, shift = 0, b; do { b = this.u8(); v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80); return v; }
  sleb() { let v = 0, shift = 0, b; do { b = this.u8(); v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80); return b & 0x40 ? v - 2 ** shift : v; }
  bytesN(n: number) { const v = this.bytes.slice(this.pos, this.pos + n); this.pos += n; return v; }
  cstr() { const start = this.pos; while (this.bytes[this.pos]) this.pos++; const value = new TextDecoder().decode(this.bytes.slice(start, this.pos)); this.pos++; return value; }
}

export function parseElfBinary(input: ArrayBuffer | Uint8Array): BinaryParseResult {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input), h = new Reader(bytes);
  if (h.u8() !== 0x7f || h.u8() !== 0x45 || h.u8() !== 0x4c || h.u8() !== 0x46) throw new Error("Not an ELF file");
  const cls = h.u8(), data = h.u8(); if (cls !== 1) throw new Error("Only ELF32 fixtures are supported"); if (data !== 1) throw new Error("Only little-endian ELF fixtures are supported");
  h.pos = 0x20; const shoff = h.u32(); h.pos = 0x2e; const shentsize = h.u16(), shnum = h.u16(), shstrndx = h.u16();
  const sections: Section[] = []; for (let i = 0; i < shnum; i++) { const r = new Reader(bytes, shoff + i * shentsize); const name = r.u32(), type = r.u32(); r.u32(); r.u32(); const offset = r.u32(), size = r.u32(), link = r.u32(), info = r.u32(); r.u32(); const entrySize = r.u32(); sections.push({ name: String(name), type, offset, size, link, info, entrySize }); }
  const shstr = sectionData(bytes, sections[shstrndx]); const readName = (offset: number) => cstr(shstr, offset); for (const s of sections) s.name = readName(Number(s.name));
  const get = (name: string) => sections.find(s => s.name === name); const symbols = parseSymbols(bytes, get(".symtab"), get(".strtab"));
  const dies = new Map<number, Die>(), signatures = new Map<string, Die[]>(); const abbrev = sectionData(bytes, get(".debug_abbrev"));
  for (const name of [".debug_info", ".debug_types"]) { const section = get(name); if (section) parseUnits(bytes, sectionData(bytes, section), abbrev, get(".debug_str"), get(".debug_line_str"), name === ".debug_types", section.offset, dies, signatures); }
  return { symbols, dies, signatures };
}

function sectionData(bytes: Uint8Array, section?: Section) {
  return section ? bytes.subarray(section.offset, section.offset + section.size) : new Uint8Array();
}
function cstr(bytes: Uint8Array, offset: number) { let end = offset; while (end < bytes.length && bytes[end]) end++; return new TextDecoder().decode(bytes.slice(offset, end)); }

function parseSymbols(bytes: Uint8Array, symtab?: Section, strtab?: Section) {
  const result = new Map<string, SymbolEntry>(); if (!symtab || !strtab) return result; const strings = sectionData(bytes, strtab), data = sectionData(bytes, symtab);
  for (let p = 0; p + 16 <= data.length; p += symtab.entrySize || 16) {
    const r = new Reader(data, p), name = r.u32(), value = r.u32(), size = r.u32(), info = r.u8();
    r.u8(); r.u16();
    const kind = info & 0xf;
    // Keep data symbols and vendor toolchains' untyped data symbols. Function
    // and section symbols only pollute the variable autocomplete list.
    if (kind !== 0 && kind !== 1) continue;
    const symbolName = cstr(strings, name);
    if (!symbolName || !value) continue;
    const entry = { name: symbolName, address: BigInt(value), size: BigInt(size), type: kind === 1 ? "OBJECT" : "NOTYPE", bind: String(info >> 4) };
    if (!result.has(symbolName)) result.set(symbolName, entry);
  }
  return result;
}

function parseUnits(bytes: Uint8Array, data: Uint8Array, abbrevData: Uint8Array, strSection: Section | undefined, lineStrSection: Section | undefined, typeUnit: boolean, sectionOffset: number, dies: Map<number, Die>, signatures: Map<string, Die[]>) {
  const strings = sectionData(bytes, strSection);
  const lineStrings = lineStrSection ? sectionData(bytes, lineStrSection) : strings;
  let unitPos = 0;
  while (unitPos + 4 <= data.length) { const start = unitPos, length = new DataView(data.buffer, data.byteOffset + unitPos, 4).getUint32(0, true); unitPos += 4; if (!length || unitPos + length > data.length) break; const end = unitPos + length, r = new Reader(data, unitPos); r.u16(); const abbrevOffset = r.u32(), addressSize = r.u8(); let signature = "";
    if (typeUnit) { signature = [...r.bytesN(8)].reverse().map(x => x.toString(16).padStart(2, "0")).join(""); r.u32(); }
    const table = readAbbrevs(abbrevData, abbrevOffset);
    const stack: Array<{ die: Die | null }> = [];
    while (r.pos < end) {
      const codePos = r.pos;
      const code = r.uleb();
      if (!code) {
        stack.pop();
        continue;
      }
      const spec = table.get(code);
      if (!spec) throw new Error(`Unsupported DWARF abbreviation ${code}`);

      const keep = RETAINED_TAGS.has(spec.tag) || spec.tag.startsWith('User TAG value:');
      const parent = [...stack].reverse().find((frame) => frame.die)?.die;
      const die = keep
        ? { offset: codePos, unit: sectionOffset + start, unitBase: start, tag: spec.tag, attrs: new Map(), children: [] }
        : null;
      if (die && parent) parent.children.push(die);
      if (spec.children) stack.push({ die });

      for (const [attr, formCode, implicitValue] of spec.attrs) {
        const value = readForm(r, formCode, addressSize, strings, lineStrings, start, end, implicitValue);
        if (die && value !== undefined) die.attrs.set(ATTRS[attr] ?? `DW_AT_0x${attr.toString(16)}`, value);
      }

      if (die) {
        let key = die.offset;
        while (dies.has(key)) key += 0x100000000;
        dies.set(key, die);
        if (signature && typeUnit && !signatures.has(signature)) signatures.set(signature, [die]);
      }
    }
    unitPos = end;
  }
}

function readAbbrevs(data: Uint8Array, offset: number) { const r = new Reader(data, offset), result = new Map<number, Abbrev>(); while (r.pos < data.length) { const code = r.uleb(); if (!code) break; const tag = TAGS[r.uleb()] ?? `User TAG value: ${code}`; const children = r.u8() !== 0, attrs: [number, number, number?][] = []; while (true) { const attr = r.uleb(), form = r.uleb(); if (!attr && !form) break; attrs.push([attr, form, form === 0x21 ? r.sleb() : undefined]); } result.set(code, { tag, children, attrs }); } return result; }

function readForm(r: Reader, formCode: number, addressSize: number, strings: Uint8Array, lineStrings: Uint8Array, unitStart: number, unitEnd: number, implicitValue?: number): string | number | undefined {
  if (formCode === 0x21) return implicitValue;
  if (formCode === 0x16) return readForm(r, r.uleb(), addressSize, strings, lineStrings, unitStart, unitEnd);
  switch (FORMS[formCode]) { case "addr": { const value = addressSize === 8 ? r.u64() : BigInt(r.u32()); return `DW_OP_addr: ${value.toString(16)}`; } case "string": return r.cstr(); case "strp": return cstr(strings, r.u32()); case "line_strp": return cstr(lineStrings, r.u32()); case "data1": return r.u8(); case "data2": return r.u16(); case "data4": return r.u32(); case "data8": return Number(r.u64()); case "udata": return r.uleb(); case "sdata": return r.sleb(); case "flag": return r.u8(); case "flag_present": return 1; case "ref1": return unitStart + r.u8(); case "ref2": return unitStart + r.u16(); case "ref4": return unitStart + r.u32(); case "ref8": return unitStart + Number(r.u64()); case "ref_udata": return unitStart + r.uleb(); case "ref_addr": return r.u32(); case "ref_sig8": return `signature:${r.u64().toString(16).padStart(16, "0")}`; case "sec_offset": return r.u32(); case "block1": return readLocation(r.bytesN(r.u8())); case "block2": return readLocation(r.bytesN(r.u16())); case "block4": return readLocation(r.bytesN(r.u32())); case "block": return readLocation(r.bytesN(r.uleb())); case "exprloc": return readLocation(r.bytesN(r.uleb())); case "ref_sup4": return r.u32(); default: if (formCode === 0x08) return r.cstr(); throw new Error(`Unsupported DWARF form ${FORMS[formCode] ?? `0x${formCode.toString(16)}`} at ${unitEnd}`); }
}
function readLocation(bytes: Uint8Array) { if (bytes[0] === 0x23) { const r = new Reader(bytes, 1); return `DW_OP_plus_uconst: ${r.uleb()}`; } return bytes.length ? `DWARF block: ${[...bytes].map(x => x.toString(16).padStart(2, "0")).join(" ")}` : ""; }
