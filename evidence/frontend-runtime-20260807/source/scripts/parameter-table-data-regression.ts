import assert from 'node:assert/strict';
import {
  buildParameterTableData,
  parseParameterTableData,
} from '../src/lib/parameterTableData';

const params = [{
  id: '000-001',
  regAddr: 1,
  alias: 'VBASE',
  name: 'VBASE',
  unit: '0.1V',
  desc: '',
  decimals: 0,
  signed: false,
  isFloat: false,
  readOnly: false,
  hidden: false,
  max: 65535,
  min: 0,
  defaultVal: 6666,
  page: 'BASE',
}];

const table = buildParameterTableData({ pages: ['BASE'], params }, 'ParameterTable.xlsx');
assert.deepEqual(table, {
  version: 1,
  name: 'ParameterTable.xlsx',
  pages: ['BASE'],
  params,
});

const encoded = JSON.stringify(table);
assert.equal(encoded.includes('data_base64'), false);
assert.equal(encoded.includes('multipart'), false);
assert.deepEqual(parseParameterTableData(JSON.parse(encoded)), table);

assert.throws(
  () => parseParameterTableData({ ...table, params: [{ ...params[0], page: 'MISSING' }] }),
  /page must be listed in pages/,
);
assert.throws(
  () => parseParameterTableData({ ...table, params: [{ ...params[0], regAddr: 2 }] }),
  /regAddr must match id/,
);
assert.throws(
  () => parseParameterTableData({ ...table, name: 'Parameter\nTable.xlsx' }),
  /name must be a valid string/,
);

console.log('parameter table structured-data regression passed');
