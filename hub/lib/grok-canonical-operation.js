'use strict';

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

const CANONICAL_VARIANT_MAP = Object.create(null);
CANONICAL_VARIANT_MAP.Read = { kind: 'read', operation: 'file' };
CANONICAL_VARIANT_MAP.ReadFile = { kind: 'read', operation: 'file' };
CANONICAL_VARIANT_MAP.Edit = { kind: 'edit', operation: 'file' };
CANONICAL_VARIANT_MAP.SearchReplace = { kind: 'edit', operation: 'file' };
CANONICAL_VARIANT_MAP.Write = { kind: 'edit', operation: 'file' };
CANONICAL_VARIANT_MAP.Bash = { kind: 'execute', operation: 'command' };
CANONICAL_VARIANT_MAP.Grep = { kind: 'search', operation: 'search' };
CANONICAL_VARIANT_MAP.SearchTool = { kind: 'other', operation: 'tool-search' };
CANONICAL_VARIANT_MAP.Task = { kind: 'other', operation: 'subagent' };
CANONICAL_VARIANT_MAP.UseTool = { kind: 'other', operation: 'mcp' };

const LEGACY_TITLE_MAP = Object.create(null);
LEGACY_TITLE_MAP.read_file = { kind: 'read', operation: 'file' };
LEGACY_TITLE_MAP.search_replace = { kind: 'edit', operation: 'file' };
LEGACY_TITLE_MAP.write = { kind: 'edit', operation: 'file' };
LEGACY_TITLE_MAP.run_terminal_command = { kind: 'execute', operation: 'command' };
LEGACY_TITLE_MAP.grep = { kind: 'search', operation: 'search' };
LEGACY_TITLE_MAP.search_tool = { kind: 'other', operation: 'tool-search' };
LEGACY_TITLE_MAP.spawn_subagent = { kind: 'other', operation: 'subagent' };

function classifyGrokOperation(title, kind, variant) {
  if (!isNonEmptyString(title) || !isNonEmptyString(kind)) {
    return 'decline';
  }

  if (variant !== undefined && !isNonEmptyString(variant)) {
    return 'decline';
  }

  if (variant !== undefined) {
    const hasCanonical = Object.prototype.hasOwnProperty.call(CANONICAL_VARIANT_MAP, variant);
    if (!hasCanonical) {
      return 'manual';
    }
    const entry = CANONICAL_VARIANT_MAP[variant];
    if (kind !== entry.kind) {
      return 'decline';
    }
    const hasLegacy = Object.prototype.hasOwnProperty.call(LEGACY_TITLE_MAP, title);
    if (hasLegacy) {
      const legacyEntry = LEGACY_TITLE_MAP[title];
      if (legacyEntry.kind !== entry.kind || legacyEntry.operation !== entry.operation) {
        return 'decline';
      }
    }
    return entry.operation;
  }

  const hasLegacy = Object.prototype.hasOwnProperty.call(LEGACY_TITLE_MAP, title);
  if (!hasLegacy) {
    return 'manual';
  }
  const entry = LEGACY_TITLE_MAP[title];
  if (kind !== entry.kind) {
    return 'decline';
  }
  return entry.operation;
}

module.exports = Object.freeze({ classifyGrokOperation });
