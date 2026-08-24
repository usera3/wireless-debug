import type { ParamDef } from '../store/paramStore';

function idToRegAddr(id: string): number {
  const [page, idx] = id.split('-').map(Number);
  return page * 256 + idx;
}

/**
 * 读取单元格的数值，能处理三种情况：
 * 1. 有缓存值（cell.v）→ 直接用
 * 2. 公式 =-ColRow（同 sheet 本行取反）→ 读同 sheet 对应单元格再取反
 * 3. 公式 =Sheet!ColRow（跨 sheet 引用）→ 读目标 sheet 对应单元格
 */
function getCellNumber(
  XLSX: typeof import('xlsx'),
  wb: import('xlsx').WorkBook,
  ws: import('xlsx').WorkSheet,
  rowIdx: number,
  colIdx: number,
  fallback: number,
): number {
  const addr = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx });
  const cell = ws[addr] as { v?: unknown; f?: string } | undefined;
  if (!cell) return fallback;

  // 有缓存值直接用
  if (cell.v !== undefined && cell.v !== null) return Number(cell.v);

  // 没有缓存值，尝试解析公式
  if (!cell.f) return fallback;
  const formula = cell.f.trim();

  // 模式 1：-ColRow（同 sheet 取反，如 -L5）
  // 被引用的单元格本身也可能是无缓存的公式，递归解析一层（跨 sheet）
  const negMatch = formula.match(/^-([A-Z]+\d+)$/);
  if (negMatch) {
    const refAddr = negMatch[1];
    const ref = ws[refAddr] as { v?: unknown; f?: string } | undefined;
    if (ref?.v !== undefined && ref.v !== null) return -Number(ref.v);
    // 被引用单元格也无缓存，尝试解析其公式（仅支持跨 sheet 引用）
    if (ref?.f) {
      const refCross = ref.f.trim().match(/^'?([^'!]+)'?!([A-Z]+\d+)$/);
      if (refCross) {
        const refWs2 = wb.Sheets[refCross[1]];
        if (refWs2) {
          const ref2 = refWs2[refCross[2]] as { v?: unknown } | undefined;
          if (ref2?.v !== undefined && ref2.v !== null) return -Number(ref2.v);
        }
      }
    }
  }

  // 模式 2：Sheet!ColRow 或 'Sheet'!ColRow（跨 sheet，如 MOTOR0!N15）
  const crossMatch = formula.match(/^'?([^'!]+)'?!([A-Z]+\d+)$/);
  if (crossMatch) {
    const refWs = wb.Sheets[crossMatch[1]];
    if (refWs) {
      const ref = refWs[crossMatch[2]] as { v?: unknown } | undefined;
      if (ref?.v !== undefined && ref.v !== null) return Number(ref.v);
    }
  }

  return fallback;
}

function parseSheet(
  XLSX: typeof import('xlsx'),
  wb: import('xlsx').WorkBook,
  sheetName: string,
): ParamDef[] {
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });
  const params: ParamDef[] = [];
  for (let i = 3; i < rows.length; i++) {
    const row = rows[i] as unknown[];
    const id = row[0];
    if (!id || id === 'Page End') break;
    if (typeof id !== 'string' || !/^\d{3}-\d{3}$/.test(id)) continue;
    params.push({
      id,
      regAddr: idToRegAddr(id),
      hidden: !!row[1],
      readOnly: !!row[2],
      decimals: Number(row[7]) || 0,
      signed: !!row[8],
      isFloat: !!row[9],
      max: getCellNumber(XLSX, wb, ws, i, 11, 65535),
      min: getCellNumber(XLSX, wb, ws, i, 12, 0),
      defaultVal: row[13] != null ? Number(row[13]) : 0,
      alias: String(row[14] ?? ''),
      name: String(row[15] ?? ''),
      unit: String(row[16] ?? ''),
      desc: String(row[17] ?? ''),
      page: sheetName,
    });
  }
  return params;
}

export async function parseParameterTable(
  file: File,
): Promise<{ params: ParamDef[]; pages: string[] }> {
  const XLSX = await import('xlsx'); // 动态加载，仅在用户触发时才下载
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array' });
        const skipSheets = new Set(['Settings']);
        const pages = wb.SheetNames.filter((s) => !skipSheets.has(s));
        const params = pages.flatMap((s) => parseSheet(XLSX, wb, s));
        resolve({ params, pages });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}
