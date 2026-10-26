import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/components/OscChannelConfig.tsx', 'utf8');

function functionSource(name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

const addressHandler = functionSource('handleAddressInput', 'handleElfFileChange');
assert.match(addressHandler, /setRow\(i, \{ varAddrHex: value \}\)/);
assert.doesNotMatch(
  addressHandler,
  /setSuggestionRow/,
  'manual hexadecimal address editing must not open ELF variable suggestions',
);

assert.match(
  source,
  /function handleVariableInput\(i: number, expression: string\)/,
  'the right channel-name field must own variable-expression input',
);
assert.match(
  source,
  /function handleVariableSelect\(i: number, suggestion: VariableSuggestion\)/,
  'selection must distinguish aggregate continuations from scalar values',
);
assert.match(
  source,
  /suggestion\.continuation[\s\S]{0,500}suggestion\.expression[\s\S]{0,500}buildElfChannelPatch/,
  'aggregate clicks must continue indexing while scalar clicks write name and address together',
);

const addressInput = source.indexOf('value={row.varAddrHex}');
const typeInput = source.indexOf('value={row.typeKey}', addressInput);
const variableInput = source.indexOf('value={row.label}', typeInput);
const suggestionDropdown = source.indexOf('suggestionRow === i', addressInput);
assert.ok(addressInput >= 0 && typeInput > addressInput && variableInput > typeInput);
assert.ok(
  suggestionDropdown > variableInput,
  'the suggestion dropdown must render under the right channel-name field, not the left address field',
);

const addressMarkup = source.slice(addressInput, typeInput);
assert.match(addressMarkup, /placeholder="0000"/);
assert.match(addressMarkup, /aria-label=\{`通道 \$\{i \+ 1\} 地址`\}/);
assert.doesNotMatch(addressMarkup, /onFocus=.*setSuggestionRow/);

const variableMarkup = source.slice(variableInput, source.indexOf('</div>', variableInput));
assert.match(variableMarkup, /onChange=\{\(e\) => handleVariableInput\(i, e\.target\.value\)\}/);
assert.match(variableMarkup, /onFocus=\{\(\) => setSuggestionRow\(i\)\}/);
assert.match(variableMarkup, /aria-label=\{`通道 \$\{i \+ 1\} 变量名`\}/);

assert.match(
  source,
  /elfParser\.getSuggestions\(row\.label\)/,
  'suggestions must come from the complete structure/array expression in the channel-name field',
);
assert.match(
  source,
  /buildElfChannelPatch\(suggestion\.expression, result\.address\)/,
  'a scalar selection must always preserve the complete expression and update its address',
);

console.log('elf address picker UI regression passed');
