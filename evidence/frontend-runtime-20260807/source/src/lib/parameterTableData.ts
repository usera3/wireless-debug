import type { ParamDef } from '../store/paramStore';

export interface ParameterTableData {
  version: 1;
  name: string;
  pages: string[];
  params: ParamDef[];
}

const MAX_PAGES = 64;
const MAX_PARAMS = 4096;
const MAX_JSON_BYTES = 512 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    if (character.charCodeAt(0) < 0x20) return true;
  }
  return false;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength || containsControlCharacter(value)) {
    throw new Error(`${field} must be a valid string`);
  }
  return value;
}

function nonEmptyString(value: unknown, field: string, maxLength: number): string {
  const result = requiredString(value, field, maxLength).trim();
  if (!result) throw new Error(`${field} must not be empty`);
  return result;
}

function numberValue(value: unknown, field: string, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (integer && !Number.isInteger(value)) throw new Error(`${field} must be an integer`);
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be boolean`);
  return value;
}

function normalizeParam(value: unknown, index: number, pages: Set<string>): ParamDef {
  if (!isRecord(value)) throw new Error(`params[${index}] must be an object`);
  const id = nonEmptyString(value.id, `params[${index}].id`, 16);
  const match = /^(\d{3})-(\d{3})$/.exec(id);
  if (!match) throw new Error(`params[${index}].id must match PPP-NNN`);
  const regAddr = numberValue(value.regAddr, `params[${index}].regAddr`, true);
  const expectedAddr = Number(match[1]) * 256 + Number(match[2]);
  if (regAddr !== expectedAddr) throw new Error(`params[${index}].regAddr must match id`);

  const page = nonEmptyString(value.page, `params[${index}].page`, 64);
  if (!pages.has(page)) throw new Error(`params[${index}].page must be listed in pages`);
  const decimals = numberValue(value.decimals, `params[${index}].decimals`, true);
  if (decimals < 0 || decimals > 16) throw new Error(`params[${index}].decimals out of range`);

  return {
    id,
    regAddr,
    alias: requiredString(value.alias, `params[${index}].alias`, 180),
    name: requiredString(value.name, `params[${index}].name`, 180),
    unit: requiredString(value.unit, `params[${index}].unit`, 180),
    desc: requiredString(value.desc, `params[${index}].desc`, 2000),
    decimals,
    signed: booleanValue(value.signed, `params[${index}].signed`),
    isFloat: booleanValue(value.isFloat, `params[${index}].isFloat`),
    readOnly: booleanValue(value.readOnly, `params[${index}].readOnly`),
    hidden: booleanValue(value.hidden, `params[${index}].hidden`),
    max: numberValue(value.max, `params[${index}].max`),
    min: numberValue(value.min, `params[${index}].min`),
    defaultVal: numberValue(value.defaultVal, `params[${index}].defaultVal`),
    page,
  };
}

export function parseParameterTableData(value: unknown): ParameterTableData {
  if (!isRecord(value)) throw new Error('parameter table must be an object');
  if (value.version !== 1) throw new Error('unsupported parameter table version');

  const name = nonEmptyString(value.name, 'name', 180).replace(/\\/g, '/');
  if (name.includes('/') || name === '.' || name === '..') throw new Error('name must be a file name');

  if (!Array.isArray(value.pages) || value.pages.length === 0 || value.pages.length > MAX_PAGES) {
    throw new Error('pages must be a non-empty array');
  }
  const pages = value.pages.map((page, index) => nonEmptyString(page, `pages[${index}]`, 64));
  if (new Set(pages).size !== pages.length) throw new Error('pages must be unique');

  if (!Array.isArray(value.params) || value.params.length > MAX_PARAMS) {
    throw new Error('params must be an array');
  }
  const pageSet = new Set(pages);
  const params = value.params.map((param, index) => normalizeParam(param, index, pageSet));
  const ids = new Set(params.map((param) => param.id));
  if (ids.size !== params.length) throw new Error('parameter ids must be unique');

  const result: ParameterTableData = { version: 1, name, pages, params };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_JSON_BYTES) {
    throw new Error('parameter table is too large');
  }
  return result;
}

export function buildParameterTableData(
  parsed: Pick<ParameterTableData, 'pages' | 'params'>,
  name = 'ParameterTable.xlsx',
): ParameterTableData {
  return parseParameterTableData({ version: 1, name, pages: parsed.pages, params: parsed.params });
}
