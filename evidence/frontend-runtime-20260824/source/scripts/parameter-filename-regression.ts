import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ESP_PARAMETER_FILENAME_MAX_BYTES,
  getEspParameterFilenameTransportLength,
  isEspParameterFilenameSupported,
} from '../src/lib/parameterFilename';

const componentPath = resolve(process.cwd(), 'src/components/EspFilePicker.tsx');
const source = readFileSync(componentPath, 'utf8');

assert.equal(ESP_PARAMETER_FILENAME_MAX_BYTES, 24);
assert.equal(getEspParameterFilenameTransportLength('a'.repeat(24)), 24);
assert.equal(isEspParameterFilenameSupported('a'.repeat(24)), true);
assert.equal(isEspParameterFilenameSupported('a'.repeat(25)), false);
assert.equal(isEspParameterFilenameSupported('ParameterTable.xlsx'), true);
assert.equal(isEspParameterFilenameSupported('中文参数表.xlsx'), false);
assert.doesNotMatch(source, /file\.name\.length\s*>\s*16/);
assert.match(source, /isEspParameterFilenameSupported/);
assert.match(source, /if \(!isCloud && !isEspParameterFilenameSupported/);
assert.match(source, /isCloud/);

console.log('parameter filename regression passed');
