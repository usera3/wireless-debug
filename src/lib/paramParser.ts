import type { ParamDef } from '../store/paramStore';

function idToRegAddr(id: string): number {
  const [page, idx] = id.split('-').map(Number);
  return page * 256 + idx;
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
      max: row[11] != null ? Number(row[11]) : 65535,
      min: row[12] != null ? Number(row[12]) : 0,
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
        const skipSheets = new Set(['Settings', 'BASE']);
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
