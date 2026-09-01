// PreToolUse hook — shape: `{ tool: 'Edit', if_path_matches: [...], validate: 'version_bump_only' }`
//
// Guardian's dependency-manifest gate. Its CLAUDE.md "What you cannot do" list
// says "Modify application logic — anything beyond tests and dep bumps", and this
// hook is the structural half of that: Guardian may bump an existing dependency
// for a CVE, but adding or removing one is a Builder's call. It had no handler, so
// Guardian's manifest edits were unconstrained.
//
// The check is on the SHAPE of the change, not on the file: an Edit replaces
// `old_string` with `new_string`, so the question is whether the set of dependency
// NAMES is the same on both sides and only version values moved.
//
//     "lodash": "^4.17.20"  →  "lodash": "^4.17.21"     allowed (bump)
//     "lodash": "^4.17.20"  →  "lodash": "^4.17.20",
//                              "left-pad": "^1.3.0"     denied (added)
//     lodash = "4.17.20"    →  lodash = "4.17.21"       allowed (Cargo/TOML form)
//
// An Edit whose two sides declare no dependencies at all is allowed: a manifest
// also holds scripts, engines and metadata, and this hook is scoped to dependency
// churn, not to every byte of package.json. Guardian's writeScope and its other
// PreToolUse rules cover the rest.

import { minimatch } from 'minimatch';
import { resolvePath } from '../placeholder.js';
import type { HookResult, ToolCallContext, ToolCallHookHandler } from '../types.js';

type VersionBumpOnlyConfig = {
  tool?: string | string[];
  if_path_matches?: unknown;
  on_violation_message?: string;
  message?: string;
};

export const versionBumpOnlyHandler: ToolCallHookHandler = async (
  config,
  ctx,
): Promise<HookResult> => {
  const cfg = config as VersionBumpOnlyConfig;
  if (!toolMatches(cfg.tool, ctx.tool)) return { kind: 'allow' };

  const path = extractPath(ctx.input);
  if (!path || !pathMatches(cfg.if_path_matches, path, ctx)) return { kind: 'allow' };

  const edit = extractEdit(ctx.input);
  // No before/after to compare (a Write, or an unexpected input shape). This hook
  // reasons about a diff; with no diff there is nothing it can honestly say.
  if (!edit) return { kind: 'allow' };

  const before = dependencyNames(edit.oldString);
  const after = dependencyNames(edit.newString);

  const added = [...after].filter((name) => !before.has(name));
  const removed = [...before].filter((name) => !after.has(name));
  if (added.length === 0 && removed.length === 0) return { kind: 'allow' };

  const detail = [
    added.length > 0 ? `adds ${added.join(', ')}` : '',
    removed.length > 0 ? `removes ${removed.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ');

  ctx.log.info(
    { agent: ctx.agent, path, added, removed },
    'version_bump_only: denied a dependency-set change',
  );
  return {
    kind: 'deny',
    message:
      cfg.on_violation_message ??
      cfg.message ??
      `🛑 This edit ${detail}, which is not a version bump.`,
  };
};

/**
 * Dependency names declared in a manifest fragment, across the forms the four
 * configured manifests use:
 *
 *   package.json / npm:   "lodash": "^4.17.21"
 *   Cargo.toml:           lodash = "4.17.21"   /   lodash = { version = "1" }
 *   pyproject.toml:       lodash = "^4.17.21"  /   "lodash>=1.0"
 *   go.mod:               github.com/x/y v1.2.3
 *
 * Deliberately name-only. Comparing versions would mean ranking `^4.17.21` against
 * `~4.18.0` across four ecosystems, and the rule being enforced is about the
 * dependency SET, not about which direction a version moved.
 */
export function dependencyNames(fragment: string): Set<string> {
  const names = new Set<string>();
  for (const raw of fragment.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    // "name": "version"  — JSON manifests.
    const json = /^"([^"]+)"\s*:\s*"([^"]*)"\s*,?$/.exec(line);
    if (json?.[1]) {
      names.add(json[1]);
      continue;
    }
    // name = "version" | name = { ... }  — TOML manifests.
    const toml = /^([A-Za-z0-9._-]+)\s*=\s*[{"]/.exec(line);
    if (toml?.[1]) {
      names.add(toml[1]);
      continue;
    }
    // module/path v1.2.3  — go.mod require lines.
    const gomod = /^(\S+\/\S+)\s+v\d[\w.+-]*$/.exec(line);
    if (gomod?.[1]) names.add(gomod[1]);
  }
  return names;
}

function extractEdit(input: unknown): { oldString: string; newString: string } | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const rec = input as Record<string, unknown>;
  const oldString = rec.old_string ?? rec.oldString;
  const newString = rec.new_string ?? rec.newString;
  if (typeof oldString !== 'string' || typeof newString !== 'string') return undefined;
  return { oldString, newString };
}

function extractPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const rec = input as Record<string, unknown>;
  if (typeof rec.file_path === 'string') return rec.file_path;
  if (typeof rec.path === 'string') return rec.path;
  return undefined;
}

function pathMatches(patterns: unknown, path: string, ctx: ToolCallContext): boolean {
  if (!Array.isArray(patterns) || patterns.length === 0) return true;
  const resolved = resolvePath(path, ctx);
  return patterns.some(
    (p) => typeof p === 'string' && minimatch(resolved, resolvePath(p, ctx), { dot: true }),
  );
}

function toolMatches(cfgTool: string | string[] | undefined, actual: string): boolean {
  if (cfgTool === undefined || cfgTool === '*') return true;
  const list = Array.isArray(cfgTool) ? cfgTool : [cfgTool];
  return list.includes(actual);
}
