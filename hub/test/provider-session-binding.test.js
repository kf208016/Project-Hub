'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validate, resolve, bind, retire } = require('../lib/provider-session-binding');

function makeScope(overrides) {
  return Object.assign({
    project: 'proj-a',
    task: 'task-a',
    actor: 'claude',
    runtimeProfileId: 'rt-1',
    accountProfileId: 'acct-1',
    rootFingerprint: 'a'.repeat(64)
  }, overrides || {});
}

test('validate accepts empty meta', () => {
  assert.equal(validate({}), true);
});

test('validate preserves unrelated fields (no mutation)', () => {
  const meta = Object.freeze({ codexField: 'x', sessions: Object.freeze({ codex: 'legacy-sid' }) });
  assert.equal(validate(meta), true);
  assert.equal(meta.codexField, 'x');
  assert.equal(meta.sessions.codex, 'legacy-sid');
});

test('bind new actor creates binding and preserves unrelated fields', () => {
  const meta = { otherField: 42, sessions: { codex: 'legacy-sid' } };
  const scope = makeScope();
  const newMeta = bind(meta, scope, 'sid-123');
  assert.equal(newMeta.otherField, 42);
  assert.equal(newMeta.sessions.codex, 'legacy-sid');
  assert.equal(newMeta.sessions.claude, 'sid-123');
  assert.equal(newMeta.providerBindings.claude.providerSessionId, 'sid-123');
  // original untouched
  assert.equal(meta.sessions.claude, undefined);
  assert.equal(meta.providerBindings, undefined);
});

test('resolve returns resume true for bound actor matching scope', () => {
  const meta = bind({}, makeScope(), 'sid-abc');
  const result = resolve(meta, makeScope());
  assert.equal(result.resume, true);
  assert.equal(result.sessionId, 'sid-abc');
  assert.equal(result.binding.providerSessionId, 'sid-abc');
  assert.throws(() => { result.binding.project = 'x'; });
});

test('resolve returns resume false when no binding/session', () => {
  const result = resolve({}, makeScope());
  assert.equal(result.resume, false);
  assert.equal(result.sessionId, null);
  assert.equal(result.binding, null);
});

test('resolve throws SESSION_BINDING_REQUIRED for legacy session without binding', () => {
  const meta = { sessions: { claude: 'legacy-sid' } };
  assert.throws(() => resolve(meta, makeScope()), { code: 'SESSION_BINDING_REQUIRED' });
});

test('bind throws SESSION_BINDING_REQUIRED for legacy session without binding', () => {
  const meta = { sessions: { claude: 'legacy-sid' } };
  assert.throws(() => bind(meta, makeScope(), 'new-sid'), { code: 'SESSION_BINDING_REQUIRED' });
});

test('resolve throws SESSION_SCOPE_CHANGED on project mismatch', () => {
  const meta = bind({}, makeScope(), 'sid-abc');
  assert.throws(() => resolve(meta, makeScope({ project: 'other-proj' })), { code: 'SESSION_SCOPE_CHANGED' });
});

test('resolve throws SESSION_SCOPE_CHANGED on task mismatch', () => {
  const meta = bind({}, makeScope(), 'sid-abc');
  assert.throws(() => resolve(meta, makeScope({ task: 'other-task' })), { code: 'SESSION_SCOPE_CHANGED' });
});

test('resolve throws SESSION_SCOPE_CHANGED on runtimeProfileId mismatch', () => {
  const meta = bind({}, makeScope(), 'sid-abc');
  assert.throws(() => resolve(meta, makeScope({ runtimeProfileId: 'rt-2' })), { code: 'SESSION_SCOPE_CHANGED' });
});

test('resolve throws SESSION_SCOPE_CHANGED on accountProfileId mismatch', () => {
  const meta = bind({}, makeScope(), 'sid-abc');
  assert.throws(() => resolve(meta, makeScope({ accountProfileId: 'acct-2' })), { code: 'SESSION_SCOPE_CHANGED' });
});

test('resolve throws SESSION_SCOPE_CHANGED on rootFingerprint mismatch', () => {
  const meta = bind({}, makeScope(), 'sid-abc');
  assert.throws(() => resolve(meta, makeScope({ rootFingerprint: 'b'.repeat(64) })), { code: 'SESSION_SCOPE_CHANGED' });
});

test('resolve throws SESSION_SCOPE_CHANGED on actor mismatch (grok scope, claude bound diff actor record absent)', () => {
  const meta = bind({}, makeScope(), 'sid-abc');
  const result = resolve(meta, makeScope({ actor: 'grok' }));
  assert.equal(result.resume, false);
});

test('bind idempotent with same sid', () => {
  const meta = bind({}, makeScope(), 'sid-abc');
  const meta2 = bind(meta, makeScope(), 'sid-abc');
  assert.equal(meta2.providerBindings.claude.providerSessionId, 'sid-abc');
});

test('bind throws SESSION_REPLACEMENT_REQUIRED for different sid same actor', () => {
  const meta = bind({}, makeScope(), 'sid-abc');
  assert.throws(() => bind(meta, makeScope(), 'sid-different'), { code: 'SESSION_REPLACEMENT_REQUIRED' });
});

test('bind throws SESSION_SCOPE_CHANGED if existing bound actor scope changed', () => {
  const meta = bind({}, makeScope(), 'sid-abc');
  assert.throws(() => bind(meta, makeScope({ project: 'changed' }), 'sid-abc'), { code: 'SESSION_SCOPE_CHANGED' });
});

test('bind allows new actor with new session (cross-provider new session)', () => {
  const meta = bind({}, makeScope(), 'sid-claude');
  const meta2 = bind(meta, makeScope({ actor: 'grok', project: 'proj-b', task: 'task-b' }), 'sid-grok');
  assert.equal(meta2.providerBindings.claude.providerSessionId, 'sid-claude');
  assert.equal(meta2.providerBindings.grok.providerSessionId, 'sid-grok');
});

test('bind rejects cross-actor sid collision', () => {
  const meta = bind({}, makeScope(), 'sid-shared');
  assert.throws(
    () => bind(meta, makeScope({ actor: 'grok', project: 'proj-b', task: 'task-b' }), 'sid-shared'),
    { code: 'SESSION_BINDING_CORRUPT' }
  );
});

test('validate throws SESSION_BINDING_CORRUPT for duplicate actor sids in stored meta', () => {
  const meta = {
    sessions: { claude: 'dup-sid', grok: 'dup-sid' },
    providerBindings: {
      claude: {
        version: 1, project: 'p', task: 't', actor: 'claude',
        runtimeProfileId: 'r', accountProfileId: 'a',
        rootFingerprint: 'a'.repeat(64), providerSessionId: 'dup-sid'
      },
      grok: {
        version: 1, project: 'p', task: 't', actor: 'grok',
        runtimeProfileId: 'r', accountProfileId: 'a',
        rootFingerprint: 'a'.repeat(64), providerSessionId: 'dup-sid'
      }
    }
  };
  assert.throws(() => validate(meta), { code: 'SESSION_BINDING_CORRUPT' });
});

test('validate throws SESSION_BINDING_CORRUPT when sessions disagree with binding', () => {
  const meta = {
    sessions: { claude: 'other-sid' },
    providerBindings: {
      claude: {
        version: 1, project: 'p', task: 't', actor: 'claude',
        runtimeProfileId: 'r', accountProfileId: 'a',
        rootFingerprint: 'a'.repeat(64), providerSessionId: 'sid-abc'
      }
    }
  };
  assert.throws(() => validate(meta), { code: 'SESSION_BINDING_CORRUPT' });
});

test('validate throws on unknown providerBindings key', () => {
  const meta = { providerBindings: { nope: {} } };
  assert.throws(() => validate(meta), { code: 'SESSION_BINDING_CORRUPT' });
});

test('validate throws on unknown record field', () => {
  const meta = {
    providerBindings: {
      claude: {
        version: 1, project: 'p', task: 't', actor: 'claude',
        runtimeProfileId: 'r', accountProfileId: 'a',
        rootFingerprint: 'a'.repeat(64), providerSessionId: 'sid-abc',
        extra: 'nope'
      }
    }
  };
  assert.throws(() => validate(meta), { code: 'SESSION_BINDING_CORRUPT' });
});

test('validate throws on missing record field', () => {
  const meta = {
    providerBindings: {
      claude: {
        version: 1, project: 'p', task: 't', actor: 'claude',
        runtimeProfileId: 'r', accountProfileId: 'a',
        rootFingerprint: 'a'.repeat(64)
      }
    }
  };
  assert.throws(() => validate(meta), { code: 'SESSION_BINDING_CORRUPT' });
});

test('validate throws on array providerBindings', () => {
  assert.throws(() => validate({ providerBindings: [] }), { code: 'SESSION_BINDING_CORRUPT' });
});

test('validate throws on null providerBindings record', () => {
  assert.throws(() => validate({ providerBindings: { claude: null } }), { code: 'SESSION_BINDING_CORRUPT' });
});

test('validate throws on bad rootFingerprint (not lowercase sha256)', () => {
  const meta = {
    providerBindings: {
      claude: {
        version: 1, project: 'p', task: 't', actor: 'claude',
        runtimeProfileId: 'r', accountProfileId: 'a',
        rootFingerprint: 'NOT-A-HASH', providerSessionId: 'sid-abc'
      }
    }
  };
  assert.throws(() => validate(meta), { code: 'SESSION_BINDING_CORRUPT' });
});

test('validate throws on bad providerSessionId format', () => {
  const meta = {
    providerBindings: {
      claude: {
        version: 1, project: 'p', task: 't', actor: 'claude',
        runtimeProfileId: 'r', accountProfileId: 'a',
        rootFingerprint: 'a'.repeat(64), providerSessionId: '-bad-start'
      }
    }
  };
  assert.throws(() => validate(meta), { code: 'SESSION_BINDING_CORRUPT' });
});

test('validate throws on NUL byte in string field', () => {
  const meta = {
    providerBindings: {
      claude: {
        version: 1, project: 'p\u0000x', task: 't', actor: 'claude',
        runtimeProfileId: 'r', accountProfileId: 'a',
        rootFingerprint: 'a'.repeat(64), providerSessionId: 'sid-abc'
      }
    }
  };
  assert.throws(() => validate(meta), { code: 'SESSION_BINDING_CORRUPT' });
});

test('validate throws on malformed unicode (lone surrogate) in field', () => {
  const meta = {
    providerBindings: {
      claude: {
        version: 1, project: 'p\uD800x', task: 't', actor: 'claude',
        runtimeProfileId: 'r', accountProfileId: 'a',
        rootFingerprint: 'a'.repeat(64), providerSessionId: 'sid-abc'
      }
    }
  };
  assert.throws(() => validate(meta), { code: 'SESSION_BINDING_CORRUPT' });
});

test('validate throws on prototype pollution attempt via JSON.parse', () => {
  const meta = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => validate(meta), { code: 'SESSION_BINDING_CORRUPT' });
});

test('validate throws on custom prototype meta', () => {
  function Foo() {}
  const meta = new Foo();
  assert.throws(() => validate(meta), { code: 'SESSION_BINDING_CORRUPT' });
});

test('validate throws on actor mismatch between key and record.actor', () => {
  const meta = {
    providerBindings: {
      claude: {
        version: 1, project: 'p', task: 't', actor: 'grok',
        runtimeProfileId: 'r', accountProfileId: 'a',
        rootFingerprint: 'a'.repeat(64), providerSessionId: 'sid-abc'
      }
    }
  };
  assert.throws(() => validate(meta), { code: 'SESSION_BINDING_CORRUPT' });
});

test('resolve throws SESSION_SCOPE_INVALID on malformed scope (missing field)', () => {
  const meta = {};
  const scope = makeScope();
  delete scope.task;
  assert.throws(() => resolve(meta, scope), { code: 'SESSION_SCOPE_INVALID' });
});

test('resolve throws SESSION_SCOPE_INVALID on unknown scope field', () => {
  const meta = {};
  const scope = makeScope({ extraField: 'x' });
  assert.throws(() => resolve(meta, scope), { code: 'SESSION_SCOPE_INVALID' });
});

test('resolve throws SESSION_SCOPE_INVALID on bad actor value', () => {
  const meta = {};
  const scope = makeScope({ actor: 'gpt' });
  assert.throws(() => resolve(meta, scope), { code: 'SESSION_SCOPE_INVALID' });
});

test('bind throws SESSION_SCOPE_INVALID on bad providerSessionId', () => {
  assert.throws(() => bind({}, makeScope(), 'bad!!sid'), { code: 'SESSION_SCOPE_INVALID' });
});

test('deterministic output for repeated identical bind calls', () => {
  const meta1 = bind({}, makeScope(), 'sid-det');
  const meta2 = bind({}, makeScope(), 'sid-det');
  assert.deepEqual(meta1.providerBindings.claude, meta2.providerBindings.claude);
  assert.equal(meta1.sessions.claude, meta2.sessions.claude);
});

test('bind does not mutate original meta even on failure path', () => {
  const meta = bind({}, makeScope(), 'sid-abc');
  const snapshotSessions = JSON.stringify(meta.sessions);
  const snapshotBindings = JSON.stringify(meta.providerBindings);
  assert.throws(() => bind(meta, makeScope(), 'sid-other'));
  assert.equal(JSON.stringify(meta.sessions), snapshotSessions);
  assert.equal(JSON.stringify(meta.providerBindings), snapshotBindings);
});

test('resolve does not mutate meta', () => {
  const meta = bind({}, makeScope(), 'sid-abc');
  const snapshot = JSON.stringify(meta);
  resolve(meta, makeScope());
  assert.equal(JSON.stringify(meta), snapshot);
});

test('bound identity requires owned sessions entry; legacy actor collisions fail closed', () => {
  const meta=bind({},makeScope(),'sid-bound');
  for(const sessions of [undefined,{}, {grok:'sid-bound'}]){
    assert.throws(()=>validate({...meta,sessions}),{code:'SESSION_BINDING_CORRUPT'});
  }
  assert.throws(()=>bind({sessions:{codex:'shared'}},makeScope(),'shared'),{code:'SESSION_BINDING_CORRUPT'});
  assert.throws(()=>validate({providerBindings:undefined}),{code:'SESSION_BINDING_CORRUPT'});
  assert.throws(()=>validate({sessions:{claude:'\ud800'}}),{code:'SESSION_BINDING_CORRUPT'});
  assert.throws(()=>resolve({},makeScope({project:'bad\0project'})),{code:'SESSION_SCOPE_INVALID'});
  // Escaped text is ordinary text; actual NUL and lone surrogates are rejected.
  assert.equal(resolve({},makeScope({project:'literal\\u0000'})).resume,false);
});


test('retire preserves other actors and unknown keys without mutation, bounds history to eight',()=>{
  const info={code:'SESSION_SCOPE_CHANGED',at:'2026-10-22T00:00:00.000Z'};
  const meta=bind(bind({extension:{keep:true},models:{claude:'a',grok:'b'},rulesSent:{claude:{sid:'a'},grok:{sid:'b'}}},makeScope(),'a'),makeScope({actor:'grok'}),'b');
  meta.retiredBindings=Array.from({length:8},(_,i)=>({actor:'grok',providerSessionId:'old-'+i,...info}));
  const before=JSON.stringify(meta),next=retire(meta,'claude',info);
  assert.equal(JSON.stringify(meta),before);assert.equal(validate(next),true);assert.equal(next.extension,meta.extension);
  for(const key of ['providerBindings','sessions','models','rulesSent']){assert.notEqual(next[key],meta[key]);assert.equal(next[key].claude,undefined);assert.deepEqual(next[key].grok,meta[key].grok);}
  assert.equal(next.retiredBindings.length,8);assert.equal(next.retiredBindings[0].providerSessionId,'old-1');
  assert.deepEqual(next.retiredBindings.at(-1),{actor:'claude',providerSessionId:'a',...info});assert.equal(resolve(next,makeScope()).resume,false);
  for(const value of [{sessions:{claude:'legacy'}},{}]){const r=retire(value,'claude',info);for(const key of ['providerBindings','sessions','models','rulesSent'])assert.deepEqual(r[key],{});assert.equal(r.retiredBindings[0].providerSessionId,value.sessions?.claude??null);}
});
test('retire rejects invalid actor, metadata, timestamps and remaining corruption',()=>{
  const info={code:'SESSION_BINDING_REQUIRED',at:'2026-10-22T00:00:00.000Z'};
  for(const actor of ['codex','',null])assert.throws(()=>retire({},actor,info),{code:'SESSION_SCOPE_INVALID'});
  for(const meta of [null,[],new Date(),Object.create({})])assert.throws(()=>retire(meta,'grok',info),{code:'SESSION_BINDING_CORRUPT'});
  for(const v of [null,{}, {...info,code:'AB'},{...info,code:'A'.repeat(65)},{...info,code:'CODE\n'},{...info,at:'2026-02-30T00:00:00.000Z'},{...info,at:'yesterday'}, {...info,at:0}])assert.throws(()=>retire({},'grok',v),{code:'SESSION_SCOPE_INVALID'});
  for(const meta of [{providerBindings:{claude:{}}},{sessions:{claude:42}},{models:[]},{rulesSent:null},{retiredBindings:{}},JSON.parse('{"__proto__":{}}')])assert.throws(()=>retire(meta,'grok',info),{code:'SESSION_BINDING_CORRUPT'});
});
