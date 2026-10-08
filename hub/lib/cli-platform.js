'use strict';
// Resolve CLI entry points without invoking a shell with user-controlled arguments.
const fs = require('fs');
const path = require('path');

function executable(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function find(name, envPath = process.env.PATH || '', platform = process.platform) {
  if (path.isAbsolute(name)) return executable(name) ? name : '';
  if (platform !== 'win32' && /^\.\.?[/\\]/.test(name)) return name;
  if (!/^[a-z][a-z0-9-]*$/i.test(name)) return '';
  const suffixes = platform === 'win32' ? ['.exe', '.cmd'] : [''];
  for (const dir of String(envPath).split(path.delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const file = path.join(dir, name + suffix);
      if (executable(file)) return file;
    }
  }
  return '';
}

function invocation(file, args = [], platform = process.platform) {
  if (!file || !Array.isArray(args)) throw new Error('CLI invocation is invalid');
  if (platform !== 'win32' || !/\.cmd$/i.test(file)) return { file, args };
  // npm's codex.cmd is a shell shim. Execute the installed JS entry directly so
  // prompts and paths never pass through cmd.exe command-string parsing.
  if (path.basename(file).toLowerCase() !== 'codex.cmd') throw new Error('Windows CLI shim is unsupported');
  const entry = path.join(path.dirname(file), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (!executable(entry)) throw new Error('Codex CLI entry point is missing');
  return { file: process.execPath, args: [entry, ...args] };
}

function resolve(name, args = [], envPath = process.env.PATH || '', platform = process.platform) {
  const file = find(name, envPath, platform);
  if (!file) throw new Error(`${name} CLI was not found`);
  return invocation(file, args, platform);
}

module.exports = { find, invocation, resolve };
