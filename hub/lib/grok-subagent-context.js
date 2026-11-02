'use strict';

// Pure, synchronous Grok subagent-context lineage helper.
// No I/O, no network, no process, no persistence. See contract notes.

const MAX_DEPTH = 24;
const MAX_SESSIONS = 4096;
const MAX_TOOLS = 4096;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const MODEL_RE = /^[A-Za-z0-9_\-.\/]{1,256}$/;

function fail(code, message) {
  const e = new Error(message || 'rejected');
  e.code = code || 'E_REJECTED';
  // Always a fresh Error instance; never re-throw original objects.
  return e;
}

function isPlainString(v) {
  return typeof v === 'string';
}

function validId(v) {
  return isPlainString(v) && ID_RE.test(v);
}

function validModel(v) {
  return isPlainString(v) && MODEL_RE.test(v);
}

function validToolCallId(v) {
  return validId(v);
}

function validClassification(v) {
  return v === 'task' || v === 'other';
}

function validStatus(v) {
  return v === 'pending' || v === 'in_progress' || v === 'completed' || v === 'failed';
}

function isTerminalToolStatus(v) {
  return v === 'completed' || v === 'failed';
}

function createScope(rootSessionId, approvedModel, subagentsApproved, cliDefault = false) {
  // CLI-default reports use the bridge ID contract; explicit models retain
  // the original model contract. Child announcements must match that scope.
  if (typeof cliDefault !== 'boolean') throw fail('E_MODEL', 'invalid model mode');
  const scopeModelValid = cliDefault ? validId : validModel;
  if (!validId(rootSessionId)) throw fail('E_ROOT_ID', 'invalid root session id');
  if (!scopeModelValid(approvedModel)) throw fail('E_MODEL', 'invalid approved model');
  if (typeof subagentsApproved !== 'boolean') throw fail('E_APPROVAL', 'invalid approval flag');

  // Internal mutable state, never exposed directly.
  const sessions = new Map(); // sessionId -> { parent, depth, classification }
  const subagentIds = new Set();
  const attemptIds = new Set();
  const tools = new Map(); // toolCallId -> { sessionId, classification, promptId, status }
  // Count unconsumed observed Task admissions, not live tool calls. There is no
  // official child-to-toolCallId correlation for same-prompt sibling Tasks.
  // JSON tuples keep permitted ':' characters from aliasing distinct pairs.
  const taskGroups = new Map(); // JSON([session,prompt]) -> {available,started,admitted}
  const groupKey = (sessionId, promptId) => JSON.stringify([sessionId, promptId]);
  let disposed = false;

  sessions.set(rootSessionId, { parent: null, depth: 0, classification: 'root' });

  function checkDisposed() {
    if (disposed) throw fail('E_DISPOSED', 'scope disposed');
  }

  function assertSession(sessionId) {
    checkDisposed();
    if (!validId(sessionId)) throw fail('E_SESSION_ID', 'invalid session id');
    if (!sessions.has(sessionId)) throw fail('E_UNKNOWN_SESSION', 'unknown session');
    return true;
  }

  function observeTool(sessionId, toolCallId, taskClassification, promptId, status) {
    checkDisposed();
    if (!validId(sessionId)) throw fail('E_SESSION_ID', 'invalid session id');
    if (!sessions.has(sessionId)) throw fail('E_UNKNOWN_SESSION', 'unknown session');
    if (!validToolCallId(toolCallId)) throw fail('E_TOOL_ID', 'invalid toolCallId');
    if (!validStatus(status)) throw fail('E_STATUS', 'invalid status');
    if (taskClassification !== undefined && !validClassification(taskClassification)) {
      throw fail('E_CLASSIFICATION', 'invalid classification');
    }
    if (promptId !== undefined && !validId(promptId)) throw fail('E_PROMPT_ID', 'invalid prompt id');

    const existing = tools.get(toolCallId);
    if (existing) {
      if (existing.sessionId !== sessionId) {
        throw fail('E_TOOL_OWNER', 'toolCallId owned by another session');
      }
      if (taskClassification !== undefined && taskClassification !== existing.classification) {
        throw fail('E_CLASSIFICATION_CHANGE', 'cannot change tool classification');
      }
      if (promptId !== undefined && existing.promptId !== undefined && promptId !== existing.promptId) {
        throw fail('E_PROMPT_CHANGE', 'cannot change tool prompt');
      }
      const prevTerminal = isTerminalToolStatus(existing.status);
      if (prevTerminal && status !== existing.status) {
        throw fail('E_TERMINAL_REGRESS', 'cannot change terminal status');
      }
      if (existing.status === 'in_progress' && status === 'pending') {
        throw fail('E_STATUS_REGRESS', 'cannot regress tool status');
      }
      if (existing.classification === 'task' && existing.promptId) {
        const group = taskGroups.get(groupKey(sessionId, existing.promptId));
        // A background Task may ACK before its queued child is spawned.
        // Completion retains its observed admission; failure conservatively
        // withdraws one still-unmapped quota in this exact parent/prompt group.
        if (!prevTerminal && status === 'failed') {
          if (!group) throw fail('E_TASK_STATE', 'invalid task state');
          if (group.available > 0) group.available -= 1;
        }
      }
      if (existing.promptId === undefined && promptId !== undefined) existing.promptId = promptId;
      existing.status = status;
      return true;
    }

    if (tools.size >= MAX_TOOLS) throw fail('E_QUOTA_TOOLS', 'tool quota exceeded');

    let classification = 'other';
    if (taskClassification === 'task') {
      if (!validId(promptId)) throw fail('E_PROMPT_ID', 'invalid promptId for task');
      classification = 'task';
    } else if (taskClassification === 'other' || taskClassification === undefined) {
      classification = 'other';
    } else {
      throw fail('E_CLASSIFICATION', 'invalid classification');
    }

    tools.set(toolCallId, { sessionId, classification, promptId, status });

    if (classification === 'task' && !isTerminalToolStatus(status)) {
      const key = groupKey(sessionId, promptId);
      const group = taskGroups.get(key) || {available: 0, started: 0, admitted: 0};
      group.available += 1;
      group.started += 1;
      taskGroups.set(key, group);
    }

    return true;
  }

  function admitChild(outerSessionId, parentSessionId, parentPromptId, childSessionId, subagentId, attemptId, model) {
    checkDisposed();

    if (!validId(outerSessionId)) throw fail('E_OUTER_ID', 'invalid outer session id');
    if (!validId(parentSessionId)) throw fail('E_PARENT_ID', 'invalid parent session id');
    if (!validId(parentPromptId)) throw fail('E_PROMPT_ID', 'invalid parent prompt id');
    if (!validId(childSessionId)) throw fail('E_CHILD_ID', 'invalid child session id');
    if (!validId(subagentId)) throw fail('E_SUBAGENT_ID', 'invalid subagent id');
    if (!validId(attemptId)) throw fail('E_ATTEMPT_ID', 'invalid attempt id');
    if (!scopeModelValid(model)) throw fail('E_CHILD_MODEL', 'invalid child model');

    if (!subagentsApproved) throw fail('E_NOT_APPROVED', 'subagents not approved for this run');

    if (outerSessionId !== parentSessionId) throw fail('E_OUTER_MISMATCH', 'outer/parent mismatch');

    if (!sessions.has(parentSessionId)) throw fail('E_UNKNOWN_PARENT', 'unknown parent session');

    if (model !== approvedModel) throw fail('E_MODEL_MISMATCH', 'model mismatch');

    const group = taskGroups.get(groupKey(parentSessionId, parentPromptId));
    if (!group || group.available <= 0 || group.admitted >= group.started) {
      throw fail('E_NO_PENDING_TASK', 'no available recognized task quota for parent/prompt');
    }

    if (childSessionId === parentSessionId || childSessionId === rootSessionId) {
      throw fail('E_SELF_OR_ROOT', 'child cannot equal self/parent/root inappropriately');
    }

    const parentInfo = sessions.get(parentSessionId);
    const newDepth = parentInfo.depth + 1;
    if (newDepth > MAX_DEPTH) throw fail('E_DEPTH', 'depth quota exceeded');
    if (sessions.size >= MAX_SESSIONS) throw fail('E_QUOTA_SESSIONS', 'session quota exceeded');

    if (sessions.has(childSessionId)) throw fail('E_CHILD_DUP', 'child session already known (reuse/reparent/cycle)');
    if (subagentIds.has(subagentId)) throw fail('E_SUBAGENT_DUP', 'subagent id already used');
    if (attemptIds.has(attemptId)) throw fail('E_ATTEMPT_DUP', 'attempt id already used');

    // atomic commit: all checks passed, now mutate
    sessions.set(childSessionId, { parent: parentSessionId, depth: newDepth, classification: 'child' });
    subagentIds.add(subagentId);
    attemptIds.add(attemptId);
    group.available -= 1;
    group.admitted += 1;

    return true;
  }

  // A child may inherit an ancestor's permission transport. Ownership still
  // comes only from ordinary tool notifications, never from this reverse RPC.
  function permissionSession(outerSessionId, toolCallId) {
    assertSession(outerSessionId);
    if (!validToolCallId(toolCallId)) throw fail('E_TOOL_ID', 'invalid tool call id');

    const tool = tools.get(toolCallId);
    if (!tool) return null;
    const owner = tool.sessionId;
    if (!validId(owner) || !sessions.has(owner)) throw fail('E_TOOL_OWNER', 'unknown tool owner');

    let current = owner;
    let steps = 0;
    let permitted = false;
    const seen = new Set();
    while (true) {
      if (!validId(current) || !sessions.has(current)) throw fail('E_SESSION_CHAIN', 'broken session ancestry');
      if (seen.has(current)) throw fail('E_SESSION_CYCLE', 'cyclic session ancestry');
      seen.add(current);
      const node = sessions.get(current);
      if (!node) throw fail('E_SESSION_CHAIN', 'broken session ancestry');
      if (current === outerSessionId) permitted = true;

      // Even an exact owner or early ancestor match must reach the real root.
      // Undefined parents and a second disconnected root are never terminators.
      const parent = node.parent;
      if (parent === null) {
        if (current !== rootSessionId) throw fail('E_SESSION_CHAIN', 'broken session ancestry');
        break;
      }
      if (!validId(parent) || !sessions.has(parent)) throw fail('E_SESSION_CHAIN', 'broken session ancestry');
      if (steps >= MAX_DEPTH) throw fail('E_SESSION_DEPTH', 'ancestry depth exceeded');
      current = parent;
      steps += 1;
    }

    if (!permitted) throw fail('E_SESSION_UNRELATED', 'session not permitted to transport this permission');
    return owner;
  }

  function dispose() {
    disposed = true;
    sessions.clear();
    subagentIds.clear();
    attemptIds.clear();
    tools.clear();
    taskGroups.clear();
  }

  const api = Object.freeze({
    assertSession,
    observeTool,
    admitChild,
    permissionSession,
    dispose,
  });

  return api;
}

module.exports = Object.freeze({ createScope, isTerminalToolStatus, MAX_DEPTH, MAX_SESSIONS, MAX_TOOLS });
