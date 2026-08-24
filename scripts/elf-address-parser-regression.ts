import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createElfAddressParser,
  filterElfVariableNames,
  formatElfAddress,
  MAX_ELF_FILE_BYTES,
  parseManualAddress,
} from '../src/lib/elfAddressParser';

const fixture = resolve(
  process.env.ELF_FIXTURE ?? '/mnt/d/Users/sunqi39/Downloads/addr_parser/elf_example/test_platform_c2000.out',
);

if (!existsSync(fixture)) {
  console.log(`elf address parser regression skipped; fixture not found: ${fixture}`);
} else {
  const parser = await createElfAddressParser(new Blob([readFileSync(fixture)]));
  const names = parser.getVariableNames();

  assert.ok(names.includes('cnt_tbs'), 'top-level variables should be searchable');
  assert.ok(names.includes('McStatus1'), 'structure roots should be searchable');
  assert.equal(parser.resolve('cnt_tbs').address, 0xc42cn);
  assert.equal(parser.resolve('McStatus1.Pu.Ia').address, 0xc534n);
  assert.equal(parser.resolve('iRtMcBoardList[0]').address, 0xc938n);

  assert.equal(parseManualAddress('0xC42C'), 0xc42c);
  assert.equal(parseManualAddress('c42c'), 0xc42c);
  assert.equal(parseManualAddress('not-an-address'), null);
  assert.equal(formatElfAddress(0xc42cn), 'C42C');
  assert.deepEqual(
    filterElfVariableNames(['prefix_cnt', 'cnt_tbc', 'cnt_tbs', '$C$FSL8'], 'CNT'),
    ['cnt_tbc', 'cnt_tbs'],
  );

  const oversized = { size: MAX_ELF_FILE_BYTES + 1, arrayBuffer: async () => { throw new Error('must not read oversized file'); } } as unknown as Blob;
  await assert.rejects(createElfAddressParser(oversized), /不超过 64 MB/);

  await assert.rejects(
    createElfAddressParser(new Blob([new Uint8Array([0, 1, 2, 3])])),
    /Not an ELF file/,
  );

  console.log('elf address parser regression passed');
}
