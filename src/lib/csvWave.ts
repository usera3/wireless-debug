/**
 * csvWave.ts
 * 示波器波形数据的 CSV 导出 / 导入工具。
 *
 * CSV 格式：
 *   第一行：表头  time_s, <label1>, <label2>, ...
 *   后续行：每行一个采样点，time_s 为秒，保留 6 位小数（精度 1 µs）
 */

// ─── 导出 ─────────────────────────────────────────────────────────────────────

export function exportCsv(
  labels: string[],
  columns: (number | null)[][],
  sampleIntervalSec: number,
  filename: string,
  startTimeSec = 0,
) {
  const rowCount = columns.reduce((max, col) => Math.max(max, col.length), 0);
  if (rowCount === 0) return;

  const lines: string[] = [];
  lines.push(['time_s', ...labels].join(','));

  for (let i = 0; i < rowCount; i++) {
    const timeSec = (startTimeSec + i * sampleIntervalSec).toFixed(6);
    const row = [timeSec];
    for (const col of columns) {
      const value = i < col.length ? col[i] : null;
      row.push(value != null && Number.isFinite(value) ? String(value) : '');
    }
    lines.push(row.join(','));
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── 导入 ─────────────────────────────────────────────────────────────────────

export interface CsvImportResult {
  /** 列标题（不含 time_s）*/
  labels: string[];
  /** 每列采样值（与 labels 等长）*/
  columns: number[][];
  /**
   * 从相邻行 time_s 差值推断出的采样间隔（秒）。
   * 若文件只有 1 行数据，则返回 null。
   */
  sampleIntervalSec: number | null;
}

export function importCsv(file: File): Promise<CsvImportResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.onload = () => {
      try {
        const text = reader.result as string;
        const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
        if (lines.length < 2) throw new Error('CSV 文件至少需要表头行和一行数据');

        const header = lines[0].split(',').map((h) => h.trim());
        if (header[0].toLowerCase() !== 'time_s') {
          throw new Error('CSV 表头第一列必须是 time_s');
        }
        const labels = header.slice(1);
        const colCount = labels.length;
        const columns: number[][] = Array.from({ length: colCount }, () => []);
        const timeSec: number[] = [];

        for (let i = 1; i < lines.length; i++) {
          const cells = lines[i].split(',');
          timeSec.push(Number(cells[0]));
          for (let c = 0; c < colCount; c++) {
            const raw = cells[c + 1];
            columns[c].push(raw !== undefined && raw !== '' ? Number(raw) : NaN);
          }
        }

        // 推断采样间隔（取前两行 time_s 差，单位已是秒）
        const sampleIntervalSec =
          timeSec.length >= 2 ? timeSec[1] - timeSec[0] : null;

        resolve({ labels, columns, sampleIntervalSec });
      } catch (e) {
        reject(e);
      }
    };
    reader.readAsText(file);
  });
}
