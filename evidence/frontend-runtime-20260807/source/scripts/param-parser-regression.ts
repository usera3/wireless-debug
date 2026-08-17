import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseParameterTable } from '../src/lib/paramParser';

class NodeFileReader {
  result: string | ArrayBuffer | null = null;
  error: DOMException | null = null;
  onload: FileReader['onload'] = null;
  onerror: FileReader['onerror'] = null;

  readAsArrayBuffer(file: Blob) {
    file.arrayBuffer().then(
      (buffer) => {
        this.result = buffer;
        this.onload?.call(
          this as unknown as FileReader,
          { target: this } as unknown as ProgressEvent<FileReader>,
        );
      },
      (error: DOMException) => {
        this.error = error;
        this.onerror?.call(
          this as unknown as FileReader,
          { target: this } as unknown as ProgressEvent<FileReader>,
        );
      },
    );
  }
}

globalThis.FileReader = NodeFileReader as unknown as typeof FileReader;

const workbookBytes = await readFile(
  resolve('reference/ParameterTable.xlsx'),
);
const file = new File([workbookBytes], 'ParameterTable.xlsx', {
  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});
const result = await parseParameterTable(file);

assert.equal(result.pages.includes('Settings'), false, 'Settings is workbook metadata, not a parameter page');
assert.deepEqual(
  result.pages.slice(0, 2),
  ['BASE', 'MOTOR0'],
  'BASE should be the first editable parameter page',
);

const baseParams = result.params.filter((param) => param.page === 'BASE');
assert.deepEqual(
  baseParams.map(({ id, regAddr, alias }) => ({ id, regAddr, alias })),
  [
    { id: '000-000', regAddr: 0x0000, alias: 'POLEPAIRS_BASE' },
    { id: '000-001', regAddr: 0x0001, alias: 'VBASE' },
    { id: '000-002', regAddr: 0x0002, alias: 'IBASE' },
    { id: '000-003', regAddr: 0x0003, alias: 'FBASE' },
  ],
  'all BASE parameters should be parsed with their Modbus register addresses',
);

console.log('parameter parser regression passed');
