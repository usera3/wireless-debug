import assert from 'node:assert/strict';
import { parameterSourcePolicy } from '../src/lib/parameterSourcePolicy';

const cloud = parameterSourcePolicy('cloud');
assert.equal(cloud.showLocalFilePicker, true, 'cloud users on phones and personal computers need local file access');
assert.equal(cloud.allowRemoteUpload, true, 'cloud users must be able to publish a parameter table');
assert.equal(cloud.allowRemoteDelete, true, 'cloud users must be able to manage server parameter tables');
assert.equal(
  'autoLoadSingleRemoteFile' in cloud,
  false,
  'the server table dialog must not contain a single-file auto-load path',
);
assert.equal(cloud.remoteButtonLabel, '服务器参数表');

const local = parameterSourcePolicy('local');
assert.equal(local.showLocalFilePicker, true);
assert.equal(local.allowRemoteUpload, true);
assert.equal(local.allowRemoteDelete, true);
assert.equal('autoLoadSingleRemoteFile' in local, false);
assert.equal(local.remoteButtonLabel, '设备参数表');

console.log('parameter source policy regression passed');
