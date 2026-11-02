'use strict';
// Acceptance addition to R18/F2: an outside-root Grok edit is accepted only because the OS
// sandbox refuses it. The turn grant does allow auth.json.lock, so credential files and
// provider homes stay declined.
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../lib/native-provider-tool-policy');

const ROOT = 'D:\\Test\\work\\proj';
const policy = Object.freeze({root: ROOT, modelFlag: 'grok-4.6', commandsApproved: true,
  subagentsApproved: true, mcpTools: ['hub__hub_report']});
const edit = file_path => ({title: 'write', kind: 'edit', rawInput: {file_path}});

test('F2 outside-root edits of credential files and provider homes stay declined', () => {
  for (const target of [
    'C:\\Users\\user\\.grok\\auth.json.lock',
    'C:\\Users\\user\\.grok\\auth.json',
    'c:/users/user/.GROK/bin/grok.exe',
    'C:\\Users\\user\\.claude\\.credentials.json',
    'C:\\Users\\user\\.claude\\settings.json',
    'C:\\Users\\user\\.codex\\config.toml',
    'D:\\backup\\credentials.txt',
    'D:\\x\\hub-owner.json'
  ]) {
    const decision = decide('grok', edit(target), policy);
    assert.ok(decision === 'decline', target + ' -> ' + decision);
  }
});

test('F2 outside-root edits elsewhere are still accepted', () => {
  for (const target of ['D:\\HubTest\\tmp\\x.txt', 'C:\\Users\\Public\\grokker.txt', 'D:\\notes\\.grokignore', 'D:\\a\\codexes\\x.txt']) {
    assert.equal(decide('grok', edit(target), policy), 'accept', target);
  }
});
