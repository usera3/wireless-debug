import { strict as assert } from 'node:assert';
import {
  buildParamReadBatches,
  decodeParamBatchValues,
} from '../src/lib/paramBatchRead';
import type { ParamDef } from '../src/store/paramStore';

function param(alias: string, regAddr: number, options: Partial<ParamDef> = {}): ParamDef {
  return {
    id: alias,
    regAddr,
    alias,
    name: alias,
    unit: '',
    desc: '',
    decimals: 0,
    signed: false,
    isFloat: false,
    readOnly: false,
    hidden: false,
    max: 0,
    min: 0,
    defaultVal: 0,
    page: 'MOTOR0',
    ...options,
  };
}

{
  const params = [
    param('JD', 0x0100),
    param('INNER_RATE', 0x0101),
    param('POLE_PAIRS', 0x0102),
    param('RS_OHM', 0x0103, { decimals: 2 }),
    param('LD_MH', 0x0104, { decimals: 2 }),
  ];
  const batches = buildParamReadBatches(params);

  assert.equal(batches.length, 1, 'contiguous current page registers should be read in one request');
  assert.equal(batches[0].startAddr, 0x0100);
  assert.equal(batches[0].count, 5);
  assert.deepEqual(batches[0].params.map((item) => item.alias), [
    'JD',
    'INNER_RATE',
    'POLE_PAIRS',
    'RS_OHM',
    'LD_MH',
  ]);

  const values = decodeParamBatchValues(batches[0], [13400, 1, 4, 39, 172]);
  assert.deepEqual(values, [
    ['JD', 13400],
    ['INNER_RATE', 1],
    ['POLE_PAIRS', 4],
    ['RS_OHM', 0.39],
    ['LD_MH', 1.72],
  ]);
}

{
  const params = [
    param('A', 0x0200),
    param('FLOAT_B', 0x0201, { isFloat: true }),
    param('SIGNED_C', 0x0203, { signed: true }),
    param('GAP_D', 0x0210),
  ];
  const batches = buildParamReadBatches(params);

  assert.equal(batches.length, 2, 'address gaps should split read batches');
  assert.equal(batches[0].startAddr, 0x0200);
  assert.equal(batches[0].count, 4, 'float params should reserve two registers');
  assert.equal(batches[1].startAddr, 0x0210);
  assert.equal(batches[1].count, 1);

  const values = decodeParamBatchValues(batches[0], [7, 0x4120, 0x0000, 0xfffe]);
  assert.deepEqual(values, [
    ['A', 7],
    ['FLOAT_B', 10],
    ['SIGNED_C', -2],
  ]);
}
