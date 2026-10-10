'use strict';
// Resolve CLI entry points without invoking a shell with user-controlled arguments.
const fs = require('fs');
const path = require('path');
const registry = require('./provider-registry');

function executable(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function find(name, envPath = process.env.PATH || '', platform = process.platform) {
  if (path.isAbsolute(name)) return executable(name) ? name : '';
  if (platform !== 'win32' && /^\.\.?[/\\]/.test(name)) return name;
  if (!/^[a-z][a-z0-9-]*$/i.test(name)) return '';
  const suffixes = platform === 'win32' ? ['.exe', '.cmd'] : [''];
  for (const dir of String(envPath).split(platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const file = path.join(dir, name + suffix);
      if (executable(file)) return file;
    }
  }
  return '';
}

function invocation(file, args = [], platform = process.platform) {
  if (typeof file !== 'string' || !file || file.includes('\0') || !Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0'))) throw new Error('CLI invocation is invalid');
  if (platform === 'win32' && /\.(?:bat|ps1)$/i.test(file)) throw new Error('Windows CLI shim is unsupported');
  if (platform !== 'win32' || !/\.cmd$/i.test(file)) return { file, args };
  // npm's codex.cmd is a shell shim. Execute the installed JS entry directly so
  // prompts and paths never pass through cmd.exe command-string parsing.
  const name = path.basename(file).toLowerCase();
  const packages = { 'codex.cmd': ['@openai/codex', 'bin/codex.js'], 'npm.cmd': ['npm', 'bin/npm-cli.js'], 'claude.cmd': ['@anthropic-ai/claude-code', null] };
  const spec = packages[name];
  if (!spec) throw new Error('Windows CLI shim is unsupported');
  const root = path.join(path.dirname(file), 'node_modules', spec[0]);
  let relative = spec[1];
  if (!relative) {
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); }
    catch { throw new Error('CLI package manifest is missing or invalid'); }
    if (pkg.name !== spec[0]) throw new Error('CLI package identity is invalid');
    relative = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.claude;
  }
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('CLI package entry is invalid');
  const entry = path.resolve(root, relative);
  const inside = (base, target) => { const rel = path.relative(base, target); return rel && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel); };
  if (!inside(root, entry)) throw new Error('CLI package entry escapes its package');
  if (!executable(entry)) throw new Error('CLI entry point is missing');
  if (!inside(fs.realpathSync(root), fs.realpathSync(entry))) throw new Error('CLI package entry escapes its package');
  if (/\.exe$/i.test(entry)) return { file: entry, args: args.slice() };
  if (!/\.[cm]?js$/i.test(entry)) throw new Error('CLI package entry type is unsupported');
  return { file: process.execPath, args: [entry, ...args] };
}

function resolve(name, args = [], envPath = process.env.PATH || '', platform = process.platform) {
  const file = find(name, envPath, platform);
  if (!file) throw new Error(`${name} CLI was not found`);
  return invocation(file, args, platform);
}

// Provider execution uses this guarded route. Generic find/invocation remain
// usable for read-only binary metadata and synthetic fixture inspection.
function resolveProvider(actor, args = [], envPath = process.env.PATH || '', platform = process.platform) {
  const provider=registry.assertCapability(actor,'spawn',{platform});
  return resolve(provider.id,args,envPath,platform);
}

module.exports = { find, invocation, resolve, resolveProvider };
