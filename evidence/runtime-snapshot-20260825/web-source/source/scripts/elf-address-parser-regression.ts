import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildElfChannelPatch,
  createElfAddressParser,
  filterElfVariableNames,
  formatElfAddress,
  MAX_ELF_FILE_BYTES,
  parseManualAddress,
} from '../src/lib/elfAddressParser';
import { AddressParser } from '../src/lib/elfParser/address-parser';

const fixture = resolve(
  process.env.ELF_FIXTURE ?? '/mnt/d/Users/sunqi39/Downloads/addr_parser/elf_example/test_platform_c2000.out',
);
const iarFixture = resolve(
  process.env.IAR_ELF_FIXTURE ?? '/mnt/d/Users/sunqi39/Downloads/addr_parser/elf_example/ecm_out_fan_iar.out',
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
  assert.equal(parser.resolve('iRtMcBoardList[0].PwmSampleCmp[2]').address, 0xc93dn);

  assert.equal(
    typeof parser.getSuggestions,
    'function',
    'the ELF parser must expose lazy aggregate suggestions',
  );

  assert.deepEqual(
    parser.getSuggestions('McStat').map((item) => item.expression),
    ['McStatus1'],
    'root suggestions must use a strict prefix',
  );
  assert.deepEqual(
    parser.getSuggestions('McStatus1.P').map((item) => item.expression),
    ['McStatus1.Pu'],
    'a structure path such as animal.dog must index only direct matching members',
  );
  assert.deepEqual(
    parser.getSuggestions('McStatus1.P'),
    [{ expression: 'McStatus1.Pu', kind: 'structure', continuation: '.' }],
    'selecting a structure member must continue with a dot instead of resolving too early',
  );
  const nestedMembers = parser
    .getSuggestions('McStatus1.Pu.I')
    .map((item) => item.expression);
  assert.ok(
    nestedMembers.includes('McStatus1.Pu.Ia')
      && nestedMembers.includes('McStatus1.Pu.Ib')
      && nestedMembers.includes('McStatus1.Pu.Ic'),
    'nested structure members must remain searchable at every dot-separated level',
  );
  assert.ok(
    nestedMembers.every((name) => name.startsWith('McStatus1.Pu.I')),
    'nested member suggestions must reject unrelated fields',
  );
  assert.deepEqual(
    parser.getSuggestions('iRtMcBoardList[').map((item) => item.expression),
    ['iRtMcBoardList[0]'],
    'array suggestions must honor the DWARF upper bound',
  );
  assert.deepEqual(
    parser.getSuggestions('iRtMcBoardList'),
    [{ expression: 'iRtMcBoardList', kind: 'array', continuation: '[' }],
    'selecting an array variable must continue with an index bracket',
  );
  assert.deepEqual(
    parser.getSuggestions('iRtMcBoardList[1').map((item) => item.expression),
    [],
    'indices outside the DWARF bounds must not be suggested',
  );
  assert.deepEqual(
    parser.getSuggestions('iRtMcBoardList[0].Pwm').map((item) => item.expression),
    ['iRtMcBoardList[0].PwmSampleCmp'],
    'an array element that is a structure must continue with member indexing',
  );
  assert.deepEqual(
    parser.getSuggestions('iRtMcBoardList[0].PwmSampleCmp[').map((item) => item.expression),
    [
      'iRtMcBoardList[0].PwmSampleCmp[0]',
      'iRtMcBoardList[0].PwmSampleCmp[1]',
      'iRtMcBoardList[0].PwmSampleCmp[2]',
    ],
    'an array nested inside a structure must expose each valid element',
  );
  assert.deepEqual(
    parser.getSuggestions('iRtMcBoardList[0].PwmSampleCmp[2]'),
    [{
      expression: 'iRtMcBoardList[0].PwmSampleCmp[2]',
      kind: 'value',
      continuation: '',
    }],
    'only a scalar leaf may be selected for address writeback',
  );
  assert.deepEqual(
    parser.getSuggestions('iRtMcBoardList[0].PwmSampleCmp[3'),
    [],
    'a nested array must not expose an out-of-range index',
  );

  const broadArraySuggestions = parser.getSuggestions('pr_value[');
  assert.equal(broadArraySuggestions.length, 50, 'large arrays must be capped without eager expansion');
  assert.ok(
    broadArraySuggestions.every((item) => item.expression.startsWith('pr_value[')),
    'array suggestions must retain the exact expression prefix',
  );
  assert.deepEqual(
    parser.getSuggestions('pr_value[199').map((item) => item.expression),
    ['pr_value[199]'],
    'a later numeric prefix must be reachable without pre-expanding the whole array',
  );
  assert.deepEqual(
    parser.getSuggestions(''),
    [],
    'an empty channel-name query must not populate the suggestion DOM',
  );
  assert.ok(
    parser.getSuggestions('M', 500).length <= 50,
    'callers cannot bypass the 50-item memory and DOM limit',
  );
  assert.throws(
    () => parser.resolve('iRtMcBoardList[1]'),
    /out of range/,
    'manual expressions must use the same DWARF bounds as suggestions',
  );
  const originalGetVariableNames = parser.getVariableNames.bind(parser);
  (parser as unknown as { getVariableNames: () => string[] }).getVariableNames = () => {
    throw new Error('root suggestions must use the parser cache');
  };
  assert.deepEqual(
    parser.getSuggestions('cnt_tbs').map((item) => item.expression),
    ['cnt_tbs'],
    'typing must not rebuild and sort the complete root-variable array on every keypress',
  );
  (parser as unknown as { getVariableNames: () => string[] }).getVariableNames = originalGetVariableNames;

  const synthetic = AddressParser.fromText(
    [
      '1: 00001000 28 OBJECT GLOBAL DEFAULT 1 animal',
    ].join('\n'),
    `
Compilation Unit @ offset 0:
 <1><10>: Abbrev Number: 1 (DW_TAG_variable)
    DW_AT_location : DW_OP_addr: 1000
    DW_AT_name : animal
    DW_AT_type : <0x20>
 <1><20>: Abbrev Number: 2 (DW_TAG_structure_type)
    DW_AT_name : Animal
    DW_AT_byte_size : 28
 <2><30>: Abbrev Number: 3 (DW_TAG_member)
    DW_AT_name : dog
    DW_AT_data_member_location : 0
    DW_AT_type : <0x80>
 <2><40>: Abbrev Number: 3 (DW_TAG_member)
    DW_AT_name : dogs
    DW_AT_data_member_location : 4
    DW_AT_type : <0x90>
 <2><50>: Abbrev Number: 3 (DW_TAG_member)
    DW_AT_name : matrix
    DW_AT_data_member_location : 16
    DW_AT_type : <0xa0>
 <1><60>: Abbrev Number: 4 (DW_TAG_base_type)
    DW_AT_name : uint16_t
    DW_AT_byte_size : 2
 <1><80>: Abbrev Number: 2 (DW_TAG_structure_type)
    DW_AT_name : Dog
    DW_AT_byte_size : 4
 <2><81>: Abbrev Number: 3 (DW_TAG_member)
    DW_AT_name : age
    DW_AT_data_member_location : 0
    DW_AT_type : <0x60>
 <1><90>: Abbrev Number: 5 (DW_TAG_array_type)
    DW_AT_byte_size : 12
    DW_AT_type : <0x80>
 <2><91>: Abbrev Number: 6 (DW_TAG_subrange_type)
    DW_AT_lower_bound : 0
    DW_AT_upper_bound : 2
 <1><a0>: Abbrev Number: 5 (DW_TAG_array_type)
    DW_AT_byte_size : 12
    DW_AT_type : <0x60>
 <2><a1>: Abbrev Number: 6 (DW_TAG_subrange_type)
    DW_AT_lower_bound : 0
    DW_AT_upper_bound : 1
 <2><a2>: Abbrev Number: 6 (DW_TAG_subrange_type)
    DW_AT_lower_bound : 0
    DW_AT_upper_bound : 2
`,
  );
  assert.deepEqual(
    synthetic.getSuggestions('animal.d').map((item) => item.expression),
    ['animal.dog', 'animal.dogs'],
    'a structure must support member indexing such as animal.dog',
  );
  assert.deepEqual(
    synthetic.getSuggestions('animal.dog.a').map((item) => item.expression),
    ['animal.dog.age'],
  );
  assert.equal(synthetic.resolve('animal.dogs[2].age').address, 0x100cn);
  assert.equal(synthetic.resolve('animal.matrix[1][2]').address, 0x101an);
  assert.deepEqual(
    synthetic.getSuggestions('animal.matrix[1][').map((item) => item.expression),
    ['animal.matrix[1][0]', 'animal.matrix[1][1]', 'animal.matrix[1][2]'],
    'multi-dimensional arrays must expose one bounded dimension at a time',
  );

  assert.equal(parseManualAddress('0xC42C'), 0xc42c);
  assert.equal(parseManualAddress('c42c'), 0xc42c);
  assert.equal(parseManualAddress('not-an-address'), null);
  assert.equal(formatElfAddress(0xc42cn), 'C42C');
  assert.deepEqual(
    filterElfVariableNames(['prefix_cnt', 'cnt_tbc', 'cnt_tbs', '$C$FSL8'], 'CNT'),
    ['cnt_tbc', 'cnt_tbs'],
  );

  assert.equal(
    typeof buildElfChannelPatch,
    'function',
    'scalar selection must use a testable channel-row patch helper',
  );
  assert.deepEqual(
    buildElfChannelPatch('animal.dog.age', 0xc534n),
    { label: 'animal.dog.age', varAddrHex: 'C534' },
    'the complete structure expression must remain visible beside its waveform',
  );
  assert.throws(
    () => buildElfChannelPatch('tooFar', 0x10000n),
    /超出 16 位示波器地址范围/,
    'the UI must reject addresses that the 16-bit channel protocol cannot encode',
  );

  const binaryParserSource = readFileSync('src/lib/elfParser/binary-parser.ts', 'utf8');
  assert.match(
    binaryParserSource,
    /function sectionData[\s\S]{0,180}bytes\.subarray\(section\.offset, section\.offset \+ section\.size\)/,
    'ELF sections must remain zero-copy Uint8Array views',
  );
  assert.doesNotMatch(
    binaryParserSource,
    /function sectionData[\s\S]{0,180}bytes\.slice\(section\.offset/,
    'large ELF sections must never be duplicated with slice()',
  );
  const retainedTags = binaryParserSource.slice(
    binaryParserSource.indexOf('const RETAINED_TAGS'),
    binaryParserSource.indexOf('const TAGS'),
  );
  assert.doesNotMatch(retainedTags, /DW_TAG_(?:compile_unit|subprogram|lexical_block)/);

  const oversized = { size: MAX_ELF_FILE_BYTES + 1, arrayBuffer: async () => { throw new Error('must not read oversized file'); } } as unknown as Blob;
  await assert.rejects(createElfAddressParser(oversized), /不超过 64 MB/);

  await assert.rejects(
    createElfAddressParser(new Blob([new Uint8Array([0, 1, 2, 3])])),
    /Not an ELF file/,
  );

  if (existsSync(iarFixture)) {
    const iarParser = await createElfAddressParser(new Blob([readFileSync(iarFixture)]));
    assert.equal(iarParser.resolve('McStatus1.Pu.swIa').address, 0x2000136cn);
    assert.ok(
      iarParser
        .getSuggestions('McStatus1.Pu.swI')
        .some((item) => item.expression === 'McStatus1.Pu.swIa'),
      'the lazy structure index must work for a different toolchain and changing variable set',
    );
  }

  console.log('elf address parser regression passed');
}
