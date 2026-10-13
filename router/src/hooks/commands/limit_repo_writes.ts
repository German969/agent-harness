// PreToolUse hook — command: 'limit_repo_writes' (implicit; matched via tool + repo + allow_paths)
//
// Confines a GitHub write tool to an allow-list of paths in ONE repository (HAR-9).
// Guardian's only sanctioned edit to `dev-team` is its two registry files; with the
// GitHub MCP write tools granted, nothing else stopped it writing anywhere in that
// repo. block_if_path_matches cannot express this: it reads a single `path` and
// knows nothing about which repository the call targets, and the MCP tools take
// repo-relative paths, not the checkout paths its patterns are written against.
//
// Every path a call would touch must match an `allow_paths` glob, or the call is
// denied. A call on another repository is not this hook's business and is allowed,
// as is a call that touches no file (create_branch).

import { minimatch } from 'minimatch';
import type { HookResult, ToolCallContext, ToolCallHookHandler } from '../types.js';

type LimitRepoWritesConfig = {
  tool?: string | string[];
  /** Repository name, with or without the `owner/` prefix. */
  repo?: string;
  allow_paths?: unknown;
  message?: string;
};

export const limitRepoWritesHandler: ToolCallHookHandler = async (
  config,
  ctx: ToolCallContext,
): Promise<HookResult> => {
  const cfg = config as LimitRepoWritesConfig;
  if (!toolMatches(cfg.tool, ctx.tool)) return { kind: 'allow' };
  if (typeof cfg.repo !== 'string' || cfg.repo === '') return { kind: 'allow' };

  const target = targetRepo(ctx.input);
  if (!target || repoName(target) !== repoName(cfg.repo)) return { kind: 'allow' };

  const allow = Array.isArray(cfg.allow_paths)
    ? (cfg.allow_paths as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  const outside = touchedPaths(ctx.input).filter(
    (p) => !allow.some((glob) => minimatch(stripSlash(p), glob)),
  );
  if (outside.length === 0) return { kind: 'allow' };

  return {
    kind: 'deny',
    message:
      cfg.message ??
      `writes to ${cfg.repo} are limited to ${allow.join(', ') || '(nothing)'}; refused: ${outside.join(', ')}`,
  };
};

function toolMatches(cfgTool: string | string[] | undefined, actual: string): boolean {
  if (cfgTool === undefined || cfgTool === '*') return true;
  if (typeof cfgTool === 'string') return cfgTool === actual;
  return cfgTool.includes(actual);
}

/** The repository a GitHub tool call targets: `repo` (MCP) or `owner/repo`. */
function targetRepo(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const repo = (input as Record<string, unknown>).repo;
  return typeof repo === 'string' ? repo : undefined;
}

function repoName(repo: string): string {
  const parts = repo.trim().toLowerCase().split('/');
  return parts[parts.length - 1] ?? '';
}

function stripSlash(p: string): string {
  return p.replace(/^\/+/, '');
}

/**
 * Every repository path the call would write, across the shapes the fleet's GitHub
 * tools use: `path` (create_or_update_file, delete_file), `files[].path`
 * (push_files), `from_path`/`to_path` (git-data move_file) and `ops[]` with
 * `path`/`from`/`to` (git-data apply_file_ops).
 */
export function touchedPaths(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return [];
  const rec = input as Record<string, unknown>;
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string' && v !== '') out.push(v);
  };
  add(rec.path);
  add(rec.from_path);
  add(rec.to_path);
  for (const list of [rec.files, rec.ops]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue;
      const entry = item as Record<string, unknown>;
      add(entry.path);
      add(entry.from);
      add(entry.to);
    }
  }
  return out;
}
