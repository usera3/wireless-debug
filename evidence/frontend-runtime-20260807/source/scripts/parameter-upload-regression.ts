import assert from 'node:assert/strict';
import { buildParameterUploadRequest } from '../src/lib/parameterFileUpload';

const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
const file = new File([bytes], 'ParameterTable.xlsx', {
  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});
const request = await buildParameterUploadRequest('/api/excel/upload', file);

assert.equal(request.url, '/api/excel/upload');
assert.equal(request.method, 'POST');
assert.deepEqual(request.headers, {});

const uploaded = request.body.get('file');
assert.ok(uploaded instanceof File);
assert.equal(uploaded.name, file.name);
assert.equal(uploaded.type, file.type);
assert.deepEqual([...new Uint8Array(await uploaded.arrayBuffer())], [...bytes]);

console.log('parameter upload regression passed');
