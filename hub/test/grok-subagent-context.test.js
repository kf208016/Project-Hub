'use strict';

const {describe,test}=require('node:test');
const assert=require('node:assert/strict');
const { createScope, isTerminalToolStatus, MAX_DEPTH, MAX_SESSIONS, MAX_TOOLS } = require('../lib/grok-subagent-context');

function expectThrow(fn, codeContains) {
  assert.throws(fn, e => e instanceof Error && /^E_[A-Z_]+$/.test(e.code) &&
    (codeContains === undefined || e.code === codeContains));
}

describe('grok-subagent-context: construction', () => {
  test('valid root construction returns frozen API', () => {
    const scope = createScope('root-1', 'grok-4', true);
    assert.equal(Object.isFrozen(scope), true);
    assert.equal(scope.assertSession('root-1'), true);
  });

  test('invalid root id rejected', () => {
    expectThrow(() => createScope('', 'grok-4', true));
    expectThrow(() => createScope(null, 'grok-4', true));
    expectThrow(() => createScope(123, 'grok-4', true));
  });

  test('invalid model rejected', () => {
    expectThrow(() => createScope('root-1', '', true));
    expectThrow(() => createScope('root-1', {}, true));
  });

  test('invalid approval flag type rejected', () => {
    expectThrow(() => createScope('root-1', 'grok-4', 'yes'));
    expectThrow(() => createScope('root-1', 'grok-4', undefined));
  });
});

describe('grok-subagent-context: success path', () => {
  test('pending task then announcement then child tool routing', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    const ok = scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-1', 'child-1', 'attempt-1', 'grok-4');
    assert.equal(ok, true);
    assert.equal(scope.assertSession('child-1'), true);
    // child tool routing works under its own session
    assert.equal(scope.observeTool('child-1', 'call-2', 'other', undefined, 'in_progress'), true);
  });

  test('childSessionId === subagentId is accepted (documented equality)', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    assert.doesNotThrow(() => scope.admitChild('root-1', 'root-1', 'prompt-1', 'sameid', 'sameid', 'attempt-x', 'grok-4'));
  });
});

describe('grok-subagent-context: rejection cases', () => {
  test('no owner approval rejects admission', () => {
    const scope = createScope('root-1', 'grok-4', false);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    expectThrow(() => scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-1', 'child-1', 'attempt-1', 'grok-4'));
  });

  test('no pending task rejects', () => {
    const scope = createScope('root-1', 'grok-4', true);
    expectThrow(() => scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-1', 'child-1', 'attempt-1', 'grok-4'));
  });

  test('missing/invalid prompt id rejects', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    expectThrow(() => scope.admitChild('root-1', 'root-1', '', 'child-1', 'child-1', 'attempt-1', 'grok-4'));
  });

  test('wrong prompt rejects', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    expectThrow(() => scope.admitChild('root-1', 'root-1', 'prompt-WRONG', 'child-1', 'child-1', 'attempt-1', 'grok-4'));
  });

  test('wrong outer/parent mismatch rejects', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    expectThrow(() => scope.admitChild('outer-X', 'root-1', 'prompt-1', 'child-1', 'child-1', 'attempt-1', 'grok-4'));
  });

  test('wrong model rejects', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    expectThrow(() => scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-1', 'child-1', 'attempt-1', 'grok-3'));
  });

  test('unknown parent rejects', () => {
    const scope = createScope('root-1', 'grok-4', true);
    expectThrow(() => scope.admitChild('unknown-p', 'unknown-p', 'prompt-1', 'child-1', 'child-1', 'attempt-1', 'grok-4'));
  });

  test('child equal to root rejects', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    expectThrow(() => scope.admitChild('root-1', 'root-1', 'prompt-1', 'root-1', 'sub-1', 'attempt-1', 'grok-4'));
  });

  test('duplicate child session rejects (reuse/reparent)', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-1', 'child-1', 'attempt-1', 'grok-4');
    scope.observeTool('root-1', 'call-2', 'task', 'prompt-1', 'pending');
    expectThrow(() => scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-1', 'child-2', 'attempt-2', 'grok-4'));
  });

  test('attempt id reuse rejects', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-1', 'child-1', 'attempt-shared', 'grok-4');
    scope.observeTool('root-1', 'call-2', 'task', 'prompt-1', 'pending');
    expectThrow(() => scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-2', 'child-2', 'attempt-shared', 'grok-4'));
  });

  test('late announcement after failed task rejects', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'failed');
    expectThrow(() => scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-1', 'child-1', 'attempt-1', 'grok-4'));
  });
});

describe('grok-subagent-context: nested/depth/quota', () => {
  test('nested known descendant works within limits', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-1', 'child-1', 'attempt-1', 'grok-4');
    scope.observeTool('child-1', 'call-2', 'task', 'prompt-2', 'pending');
    assert.doesNotThrow(() => scope.admitChild('child-1', 'child-1', 'prompt-2', 'child-2', 'child-2', 'attempt-2', 'grok-4'));
  });

  test('unknown sibling/foreign parent fails', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-1', 'child-1', 'attempt-1', 'grok-4');
    expectThrow(() => scope.admitChild('child-ghost', 'child-ghost', 'prompt-9', 'child-2', 'child-2', 'attempt-2', 'grok-4'));
  });

  test('cycle attempt fails (child cannot become ancestor of itself)', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-1', 'child-1', 'attempt-1', 'grok-4');
    scope.observeTool('child-1', 'call-2', 'task', 'prompt-2', 'pending');
    expectThrow(() => scope.admitChild('child-1', 'child-1', 'prompt-2', 'root-1', 'sub-x', 'attempt-x', 'grok-4'));
  });

  test('depth overflow rejects at boundary', () => {
    const scope = createScope('root-1', 'grok-4', true);
    let parent = 'root-1';
    for (let i = 0; i < MAX_DEPTH; i++) {
      const childId = 'd-' + i;
      scope.observeTool(parent, 'tc-' + i, 'task', 'p-' + i, 'pending');
      scope.admitChild(parent, parent, 'p-' + i, childId, childId, 'a-' + i, 'grok-4');
      parent = childId;
    }
    scope.observeTool(parent, 'tc-final', 'task', 'p-final', 'pending');
    expectThrow(() => scope.admitChild(parent, parent, 'p-final', 'd-overflow', 'd-overflow', 'a-final', 'grok-4'));
  });
});

describe('grok-subagent-context: task quota bookkeeping', () => {
  test('recognized background Task ACK preserves exactly one unconsumed admission',()=>{
    const s=createScope('root','grok-4',true);
    s.observeTool('root','background-task','task','p','pending');
    s.observeTool('root','background-task',undefined,undefined,'completed');
    s.observeTool('root','background-task',undefined,undefined,'completed');
    assert.equal(s.admitChild('root','root','p','child','child','a','grok-4'),true);
    s.observeTool('root','background-task',undefined,undefined,'completed');
    expectThrow(()=>s.admitChild('root','root','p','extra','extra','b','grok-4'),'E_NO_PENDING_TASK');
  });

  test('failed Task withdraws available admission once and a new Task alone creates more',()=>{
    const s=createScope('root','grok-4',true);
    s.observeTool('root','failed-task','task','p','pending');
    s.observeTool('root','failed-task',undefined,undefined,'failed');
    s.observeTool('root','failed-task',undefined,undefined,'failed');
    expectThrow(()=>s.admitChild('root','root','p','child','child','a','grok-4'),'E_NO_PENDING_TASK');
    s.observeTool('root','new-task','task','p','in_progress');
    s.observeTool('root','new-task',undefined,undefined,'completed');
    assert.equal(s.admitChild('root','root','p','child','child','a','grok-4'),true);
    expectThrow(()=>s.admitChild('root','root','p','extra','extra','b','grok-4'),'E_NO_PENDING_TASK');
  });

  test('sibling completed ACKs retain bounded distinct admissions without a fabricated per-tool mapping',()=>{
    const s=createScope('root','grok-4',true);
    for(const id of ['a','b']){s.observeTool('root',id,'task','p','pending');s.observeTool('root',id,undefined,undefined,'completed');}
    assert.equal(s.admitChild('root','root','p','c1','c1','a1','grok-4'),true);
    assert.equal(s.admitChild('root','root','p','c2','c2','a2','grok-4'),true);
    expectThrow(()=>s.admitChild('root','root','p','c3','c3','a3','grok-4'),'E_NO_PENDING_TASK');
    expectThrow(()=>s.admitChild('root','root','p','c1','c1','a1','grok-4'));
  });

  test('failure conservatively withdraws only one unused quota in its exact parent/prompt group',()=>{
    const s=createScope('root','grok-4',true);
    for(const id of ['a','b','c'])s.observeTool('root',id,'task','p','pending');
    s.observeTool('root','separate','task','other-p','pending');
    assert.equal(s.admitChild('root','root','p','c1','c1','a1','grok-4'),true);
    s.observeTool('root','a',undefined,undefined,'failed');
    s.observeTool('root','a',undefined,undefined,'failed');
    assert.equal(s.admitChild('root','root','p','c2','c2','a2','grok-4'),true);
    expectThrow(()=>s.admitChild('root','root','p','c3','c3','a3','grok-4'),'E_NO_PENDING_TASK');
    assert.equal(s.admitChild('root','root','other-p','other','other','other-a','grok-4'),true);
    assert.equal(s.assertSession('c1'),true);
  });

  test('multiple tasks under one parent/prompt allow bounded unique children', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    scope.observeTool('root-1', 'call-2', 'task', 'prompt-1', 'pending');
    scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-1', 'child-1', 'attempt-1', 'grok-4');
    scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-2', 'child-2', 'attempt-2', 'grok-4');
    expectThrow(() => scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-3', 'child-3', 'attempt-3', 'grok-4'));
  });

  test('duplicate observation of same tool does not inflate quota', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-1', 'child-1', 'attempt-1', 'grok-4');
    expectThrow(() => scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-2', 'child-2', 'attempt-2', 'grok-4'));
  });

  test('terminal bookkeeping idempotent, cannot regress', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'completed');
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'completed');
    expectThrow(() => scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'in_progress'));
  });
});

describe('grok-subagent-context: tool ownership', () => {
  test('toolCallId registered to one session cannot be rewritten from sibling', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-1', 'child-1', 'attempt-1', 'grok-4');
    scope.observeTool('root-1', 'call-2', 'task', 'prompt-2', 'pending');
    scope.admitChild('root-1', 'root-1', 'prompt-2', 'child-2', 'child-2', 'attempt-2', 'grok-4');
    expectThrow(() => scope.observeTool('child-2', 'call-1', 'other', undefined, 'in_progress'));
  });

  test('same-session partial updates retain ownership/classification', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    assert.doesNotThrow(() => scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'in_progress'));
  });
});

describe('grok-subagent-context: atomic rejection', () => {
  test('after invalid announcement, valid distinct input still admits', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    expectThrow(() => scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-1', 'child-1', 'attempt-1', 'grok-WRONG'));
    // quota should still be present since rejected attempt should not consume it
    assert.doesNotThrow(() => scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-1', 'child-1', 'attempt-1', 'grok-4'));
  });

  test('reflection failure on observeTool args never consumes quota', () => {
    const scope = createScope('root-1', 'grok-4', true);
    expectThrow(() => scope.observeTool('root-1', 'call-1', 'task', '', 'pending'));
    expectThrow(() => scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-1', 'child-1', 'attempt-1', 'grok-4'));
  });
});

describe('grok-subagent-context: integration-focused synthetic checks', () => {
  test('child model/session metadata does not change root scope state', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-1', 'child-1', 'attempt-1', 'grok-4');
    // root remains assertable and distinct; no API exposes mutation of root model
    assert.equal(scope.assertSession('root-1'), true);
  });

  test('unannounced child notification/permission fails (unknown session)', () => {
    const scope = createScope('root-1', 'grok-4', true);
    expectThrow(() => scope.assertSession('phantom-child'));
    expectThrow(() => scope.observeTool('phantom-child', 'call-x', 'other', undefined, 'in_progress'));
  });

  test('model text/rawInput announcement lookalikes remain inert (no API to inject)', () => {
    const scope = createScope('root-1', 'grok-4', true);
    // Attempting to use a rawInput-shaped string as prompt id with wrong parent must fail normally
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    expectThrow(() => scope.admitChild('root-1', 'root-1', '{\"fake\":\"prompt-1\"}', 'child-1', 'child-1', 'attempt-1', 'grok-4'));
  });

  test('stop/close disposes lineage', () => {
    const scope = createScope('root-1', 'grok-4', true);
    scope.observeTool('root-1', 'call-1', 'task', 'prompt-1', 'pending');
    scope.admitChild('root-1', 'root-1', 'prompt-1', 'child-1', 'child-1', 'attempt-1', 'grok-4');
    scope.dispose();
    expectThrow(() => scope.assertSession('root-1'));
    expectThrow(() => scope.assertSession('child-1'));
  });
});

describe('grok-subagent-context: independent review regressions', () => {
  test('first sibling completing does not consume the other sibling admission', () => {
    const s=createScope('root','grok-4',true);
    s.observeTool('root','t1','task','p','pending');
    s.observeTool('root','t2','task','p','pending');
    s.admitChild('root','root','p','c1','c1','a1','grok-4');
    s.observeTool('root','t1',undefined,undefined,'completed');
    assert.equal(s.admitChild('root','root','p','c2','c2','a2','grok-4'),true);
    expectThrow(()=>s.admitChild('root','root','p','c3','c3','a3','grok-4'),'E_NO_PENDING_TASK');
    s.observeTool('root','t2',undefined,undefined,'failed');
    expectThrow(()=>s.admitChild('root','root','p','c3','c3','a3','grok-4'),'E_NO_PENDING_TASK');
  });

  test('distinct session/prompt tuples containing colon cannot share Task authority', () => {
    const s=createScope('root','grok-4',true);
    s.observeTool('root','setup','task','setup-p','pending');
    s.admitChild('root','root','setup-p','root::x','root::x','setup-a','grok-4');
    s.observeTool('root','root-task','task','x::p','pending');
    expectThrow(()=>s.admitChild('root::x','root::x','p','grand','grand','ga','grok-4'),'E_NO_PENDING_TASK');
    s.observeTool('root::x','child-task','task','p','pending');
    assert.equal(s.admitChild('root::x','root::x','p','grand','grand','ga','grok-4'),true);
    assert.equal(s.admitChild('root','root','x::p','sibling','sibling','sa','grok-4'),true);
  });

  test('ACP in_progress is supported and status-only updates preserve Task authority', () => {
    const s=createScope('root','grok-4',true);
    s.observeTool('root','t','task','p','pending');
    s.observeTool('root','t',undefined,undefined,'in_progress');
    assert.equal(s.admitChild('root','root','p','c','c','a','grok-4'),true);
  });

  for(const status of ['active','cancelled',null,{},'COMPLETE']) {
    test('unsupported status is refused without registering a tool: '+String(status),()=>{
      const s=createScope('root','grok-4',true);
      expectThrow(()=>s.observeTool('root','t','task','p',status),'E_STATUS');
      s.observeTool('root','t','task','p','pending');
      assert.equal(s.admitChild('root','root','p','c','c','a','grok-4'),true);
    });
  }

  for(const [from,to] of [['completed','failed'],['failed','completed'],['completed','pending'],['failed','in_progress']]) {
    test('terminal state cannot be rewritten '+from+' -> '+to,()=>{
      const s=createScope('root','grok-4',true);
      s.observeTool('root','t','task','p','pending');
      s.observeTool('root','t',undefined,undefined,from);
      expectThrow(()=>s.observeTool('root','t',undefined,undefined,to),'E_TERMINAL_REGRESS');
      assert.equal(s.observeTool('root','t',undefined,undefined,from),true);
      if(from==='failed')expectThrow(()=>s.admitChild('root','root','p','c','c','a','grok-4'),'E_NO_PENDING_TASK');
      else assert.equal(s.admitChild('root','root','p','c','c','a','grok-4'),true);
    });
  }

  test('in_progress cannot regress to pending',()=>{
    const s=createScope('root','grok-4',true);
    s.observeTool('root','t','other',undefined,'in_progress');
    expectThrow(()=>s.observeTool('root','t',undefined,undefined,'pending'),'E_STATUS_REGRESS');
    assert.equal(s.observeTool('root','t',undefined,undefined,'completed'),true);
  });

  test('invalid provided classification, reclassification and changed prompt fail atomically',()=>{
    const s=createScope('root','grok-4',true);
    s.observeTool('root','t','task','p','pending');
    for(const v of [null,{},[],false,'unknown'])expectThrow(()=>s.observeTool('root','t',v,undefined,'completed'),'E_CLASSIFICATION');
    expectThrow(()=>s.observeTool('root','t','other',undefined,'completed'),'E_CLASSIFICATION_CHANGE');
    expectThrow(()=>s.observeTool('root','t',undefined,'different','completed'),'E_PROMPT_CHANGE');
    for(const v of [null,{},[],false,''])expectThrow(()=>s.observeTool('root','t',undefined,v,'completed'),'E_PROMPT_ID');
    assert.equal(s.admitChild('root','root','p','c','c','a','grok-4'),true);
    s.observeTool('root','t',undefined,undefined,'completed');
  });

  test('unknown-to-Task reclassification cannot mint Task quota',()=>{
    const s=createScope('root','grok-4',true);
    s.observeTool('root','t','other',undefined,'pending');
    expectThrow(()=>s.observeTool('root','t','task','p','pending'),'E_CLASSIFICATION_CHANGE');
    expectThrow(()=>s.admitChild('root','root','p','c','c','a','grok-4'),'E_NO_PENDING_TASK');
  });

  test('direct terminal Task does not create live admission quota',()=>{
    const s=createScope('root','grok-4',true);
    s.observeTool('root','t','task','p','completed');
    expectThrow(()=>s.admitChild('root','root','p','c','c','a','grok-4'),'E_NO_PENDING_TASK');
  });

  test('subagent and attempt identities have separate uniqueness namespaces',()=>{
    const s=createScope('root','grok-4',true);
    s.observeTool('root','t1','task','p','pending');
    s.observeTool('root','t2','task','p','pending');
    s.admitChild('root','root','p','c1','shared-subagent','a1','grok-4');
    expectThrow(()=>s.admitChild('root','root','p','c2','shared-subagent','a2','grok-4'),'E_SUBAGENT_DUP');
    assert.equal(s.admitChild('root','root','p','c2','c2','a2','grok-4'),true);
  });

  test('actual sibling cannot rewrite or finish another sibling toolCallId',()=>{
    const s=createScope('root','grok-4',true);
    s.observeTool('root','t1','task','p','pending');
    s.observeTool('root','t2','task','p','pending');
    s.admitChild('root','root','p','c1','c1','a1','grok-4');
    s.admitChild('root','root','p','c2','c2','a2','grok-4');
    s.observeTool('c1','child-tool','other',undefined,'pending');
    expectThrow(()=>s.observeTool('c2','child-tool','other',undefined,'completed'),'E_TOOL_OWNER');
    assert.equal(s.observeTool('c1','child-tool',undefined,undefined,'completed'),true);
  });

  test('primitive API never reflects, coerces, or reads code from hostile objects',()=>{
    let touched=0;
    const hostile=new Proxy({}, {get(){touched++;throw new Error('source secret');},getPrototypeOf(){touched++;throw new Error('source secret');},ownKeys(){touched++;throw new Error('source secret');}});
    const s=createScope('root','grok-4',true);
    const errors=[];
    for(let i=0;i<2;i++){
      try{createScope(hostile,'grok-4',true);}catch(e){errors.push(e);}
    }
    expectThrow(()=>s.observeTool('root','t',hostile,undefined,'pending'),'E_CLASSIFICATION');
    expectThrow(()=>s.observeTool('root','t','task',hostile,'pending'),'E_PROMPT_ID');
    expectThrow(()=>s.admitChild('root','root','p','c','c',hostile,'grok-4'),'E_ATTEMPT_ID');
    assert.equal(touched,0);
    assert.equal(errors.length,2);
    assert.notEqual(errors[0],errors[1]);
    assert.notEqual(errors[0],hostile);
    assert.equal(errors[0].code,'E_ROOT_ID');
    assert.equal(errors[0].message,'invalid root session id');
    s.observeTool('root','t','task','p','pending');
    assert.equal(s.admitChild('root','root','p','c','c','a','grok-4'),true);
  });

  test('ID syntax and maximum ID size align with the protocol boundary',()=>{
    for(const id of ['-root',':root','_root','root/x','root x','r'.repeat(257)])expectThrow(()=>createScope(id,'grok-4',true),'E_ROOT_ID');
    assert.equal(createScope('r'.repeat(256),'grok-4',true).assertSession('r'.repeat(256)),true);
  });

  test('fixed tool quota cannot be exceeded, and terminal updates remain allowed at quota',()=>{
    const s=createScope('root','grok-4',true);
    for(let i=0;i<MAX_TOOLS;i++)s.observeTool('root','tool-'+i,'other',undefined,'pending');
    expectThrow(()=>s.observeTool('root','overflow','other',undefined,'pending'),'E_QUOTA_TOOLS');
    assert.equal(s.observeTool('root','tool-0',undefined,undefined,'failed'),true);
  });

  test('fixed session quota includes root and refuses overflow atomically',()=>{
    const s=createScope('root','grok-4',true);
    for(let i=1;i<MAX_SESSIONS;i++){
      s.observeTool('root','task-'+i,'task','p','pending');
      s.admitChild('root','root','p','child-'+i,'child-'+i,'attempt-'+i,'grok-4');
    }
    s.observeTool('root','last-task','task','p','pending');
    expectThrow(()=>s.admitChild('root','root','p','overflow','overflow','overflow-attempt','grok-4'),'E_QUOTA_SESSIONS');
    expectThrow(()=>s.assertSession('overflow'),'E_UNKNOWN_SESSION');
  });

  test('terminal predicate is total and does not equate terminal with success',()=>{
    for(const value of ['completed','failed'])assert.equal(isTerminalToolStatus(value),true);
    for(const value of ['pending','in_progress','cancelled','active',undefined,null,{},[]])assert.equal(isTerminalToolStatus(value),false);
  });

  test('exports are frozen and unused object-reflection helper is not exposed',()=>{
    const api=require('../lib/grok-subagent-context');
    assert.equal(Object.isFrozen(api),true);
    assert.equal(Object.hasOwn(api,'strictPlainObject'),false);
    assert.deepEqual(Object.keys(createScope('root','grok-4',true)).sort(),['admitChild','assertSession','dispose','observeTool','permissionSession']);
  });
});

describe('grok-subagent-context: permission transport ancestry', () => {
  function tree() {
    const scope=createScope('root','grok-4',true);
    for(const [parent,child] of [['root','a'],['root','b'],['a','grand']]) {
      scope.observeTool(parent,'spawn-'+child,'task','prompt-'+child,'pending');
      scope.admitChild(parent,parent,'prompt-'+child,child,child,'attempt-'+child,'grok-4');
    }
    scope.observeTool('grand','grand-tool','other',undefined,'pending');
    scope.observeTool('root','root-tool','other',undefined,'pending');
    return scope;
  }

  test('owner, immediate ancestor and true root transport the original owner',()=>{
    const scope=tree();
    for(const outer of ['grand','a','root']) assert.equal(scope.permissionSession(outer,'grand-tool'),'grand');
    assert.equal(scope.permissionSession('root','root-tool'),'root');
  });

  test('sibling and descendant cannot transport a registered tool permission',()=>{
    const scope=tree();
    expectThrow(()=>scope.permissionSession('b','grand-tool'),'E_SESSION_UNRELATED');
    expectThrow(()=>scope.permissionSession('a','root-tool'),'E_SESSION_UNRELATED');
    expectThrow(()=>scope.permissionSession('grand','root-tool'),'E_SESSION_UNRELATED');
    assert.equal(scope.permissionSession('root','grand-tool'),'grand');
  });

  test('unknown tool lookup never assigns ownership or creates Task quota',()=>{
    const scope=tree();
    for(let i=0;i<MAX_TOOLS+1;i++) assert.equal(scope.permissionSession('root','unseen-'+i),null);
    assert.equal(scope.permissionSession('a','later-tool'),null);
    expectThrow(()=>scope.admitChild('a','a','unseen-prompt','new-child','new-child','new-attempt','grok-4'),'E_NO_PENDING_TASK');
    assert.equal(scope.observeTool('grand','later-tool','other',undefined,'pending'),true);
    assert.equal(scope.permissionSession('root','later-tool'),'grand');
    expectThrow(()=>scope.observeTool('root','later-tool','other',undefined,'in_progress'),'E_TOOL_OWNER');
  });

  test('route resolution does not mutate ordinary owner, classification, prompt or state',()=>{
    const scope=tree();
    assert.equal(scope.permissionSession('root','grand-tool'),'grand');
    expectThrow(()=>scope.observeTool('root','grand-tool','other',undefined,'completed'),'E_TOOL_OWNER');
    expectThrow(()=>scope.observeTool('grand','grand-tool','task','injected','pending'),'E_CLASSIFICATION_CHANGE');
    assert.equal(scope.observeTool('grand','grand-tool',undefined,undefined,'in_progress'),true);
    assert.equal(scope.observeTool('grand','grand-tool',undefined,undefined,'failed'),true);
  });

  test('lookup validates unknown outer session before unknown tool and rejects malformed IDs',()=>{
    const scope=tree();
    expectThrow(()=>scope.permissionSession('foreign','unseen'),'E_UNKNOWN_SESSION');
    for(const bad of ['',null,undefined,{},[],'-tool','x'.repeat(257)]) {
      expectThrow(()=>scope.permissionSession('root',bad),'E_TOOL_ID');
      expectThrow(()=>scope.permissionSession(bad,'grand-tool'),'E_SESSION_ID');
    }
  });

  test('hostile ID arguments stay inert and all refusal errors are fresh and redacted',()=>{
    let calls=0;
    const hostile=new Proxy({}, {get(){calls++;throw new Error('private');},getPrototypeOf(){calls++;throw new Error('private');},ownKeys(){calls++;throw new Error('private');}});
    const scope=tree();
    const errors=[];
    for(let i=0;i<2;i++)try{scope.permissionSession('root',hostile);}catch(e){errors.push(e);}
    expectThrow(()=>scope.permissionSession(hostile,'grand-tool'),'E_SESSION_ID');
    assert.equal(calls,0);
    assert.equal(errors.length,2);
    assert.notEqual(errors[0],errors[1]);
    assert.equal(errors[0].code,'E_TOOL_ID');
    assert.equal(errors[0].message,'invalid tool call id');
  });

  test('disposed run cannot resolve known or unknown permissions',()=>{
    const scope=tree();
    scope.dispose();
    expectThrow(()=>scope.permissionSession('root','grand-tool'),'E_DISPOSED');
    expectThrow(()=>scope.permissionSession('root','unknown'),'E_DISPOSED');
  });

  test('maximum admitted ancestry is usable by its owner and root',()=>{
    const scope=createScope('root','grok-4',true);
    let parent='root';
    for(let i=1;i<=MAX_DEPTH;i++) {
      const child='depth-'+i;
      scope.observeTool(parent,'task-'+i,'task','p-'+i,'pending');
      scope.admitChild(parent,parent,'p-'+i,child,child,'attempt-'+i,'grok-4');
      parent=child;
    }
    scope.observeTool(parent,'deep-tool','other',undefined,'pending');
    assert.equal(scope.permissionSession(parent,'deep-tool'),parent);
    assert.equal(scope.permissionSession('root','deep-tool'),parent);
  });

  // Inject corruption only into a fresh VM's private Map implementation. The
  // production API exposes no maps or test hooks; source and public API match.
  function corruptedScope() {
    const fs=require('node:fs');
    const vm=require('node:vm');
    const maps=[];
    class CapturedMap extends Map { constructor(...args){super(...args);maps.push(this);} }
    const sandbox={module:{exports:{}},Map:CapturedMap};
    vm.runInNewContext(fs.readFileSync(require.resolve('../lib/grok-subagent-context'),'utf8'),sandbox);
    const scope=sandbox.module.exports.createScope('root','grok-4',true);
    scope.observeTool('root','spawn','task','p','pending');
    scope.admitChild('root','root','p','child','child','attempt','grok-4');
    scope.observeTool('child','child-tool','other',undefined,'pending');
    assert.equal(scope.permissionSession('root','child-tool'),'child');
    assert.equal(scope.permissionSession('child','child-tool'),'child');
    return {scope,sessions:maps[0],tools:maps[1]};
  }

  for(const [label,parent] of [['undefined',undefined],['foreign null',null],['unknown','absent'],['nonstring',7]]) {
    test('early owner match cannot hide '+label+' ancestry',()=>{
      const {scope,sessions}=corruptedScope();
      sessions.get('child').parent=parent;
      assert.throws(()=>scope.permissionSession('child','child-tool'),e=>e.code==='E_SESSION_CHAIN');
    });
  }

  test('early ancestor match cannot hide corrupt true root or a cycle',()=>{
    for(const value of [undefined,'child']) {
      const {scope,sessions}=corruptedScope();
      sessions.get('root').parent=value;
      assert.throws(()=>scope.permissionSession('root','child-tool'),e=>/^E_SESSION_(CHAIN|CYCLE)$/.test(e.code));
    }
  });

  test('registered tool whose owner vanished is refused',()=>{
    const {scope,sessions}=corruptedScope();
    sessions.delete('child');
    assert.throws(()=>scope.permissionSession('root','child-tool'),e=>e.code==='E_TOOL_OWNER');
  });

  test('matched owner cannot hide a chain beyond the depth bound',()=>{
    const {scope,sessions}=corruptedScope();
    let parent='root';
    for(let i=1;i<=MAX_DEPTH;i++) {
      const id='extra-'+i;
      sessions.set(id,{parent,depth:i});
      parent=id;
    }
    sessions.get('child').parent=parent;
    assert.throws(()=>scope.permissionSession('child','child-tool'),e=>e.code==='E_SESSION_DEPTH');
  });
});


test('CLI default model IDs use the bridge contract without changing explicit model validation',()=>{
  expectThrow(()=>createScope('root','grok:latest',true),'E_MODEL');
  assert.doesNotThrow(()=>createScope('root','legacy/model',true));
  for(const model of ['grok:latest','Grok_4.7','x'.repeat(256)]){
    const scope=createScope('root',model,true,true);
    scope.observeTool('root','call','task','prompt','pending');
    assert.equal(scope.admitChild('root','root','prompt','child','child','attempt',model),true);
  }
  for(const model of ['bad/model',':leading','bad model','x'.repeat(257)])expectThrow(()=>createScope('root',model,true,true),'E_MODEL');
  expectThrow(()=>createScope('root','grok',true,'yes'),'E_MODEL');
  const scope=createScope('root','grok:latest',true,true);scope.observeTool('root','call','task','prompt','pending');
  expectThrow(()=>scope.admitChild('root','root','prompt','child','child','attempt','other:model'),'E_MODEL_MISMATCH');
});
