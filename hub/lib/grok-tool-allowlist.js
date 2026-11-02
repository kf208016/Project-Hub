'use strict';
// Process-level Grok tool allowlist (Grok CLI top-level --tools). Applies to Task children,
// which do not receive the session/new agentProfile.
const TASK_COMPANIONS = Object.freeze(['get_task_output', 'wait_tasks', 'kill_task']);
const GROK_PROCESS_TOOLS = Object.freeze([
  'read_file', 'grep', 'search_replace', 'write', 'run_terminal_cmd', 'task', 'search_tool', 'use_tool',
  ...TASK_COMPANIONS
]);
module.exports = { TASK_COMPANIONS, GROK_PROCESS_TOOLS };
