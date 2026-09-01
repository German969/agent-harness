// PostToolUse hooks — `lint_and_format` and `format_and_lint`.
//
// These were stubs: they logged their intent and returned. Their own comment said
// "Phase 9 (Scheduler + Ops) or a per-target-project extension wires the real
// command runner". Phase 9 shipped without it, so five agents' post-edit
// formatting has never run — and the fleet-config gate reported them as fine,
// because a registered handler existed.
//
// What runs, and what deliberately does not:
//
//   - Runs the project's own formatter on the ONE file that was just edited.
//     A Builder makes dozens of edits per session; a whole-project pass after each
//     is the kind of hook people turn off. Biome on a single file is milliseconds.
//   - Does NOT typecheck. tsc has no meaningful per-file mode — it needs the whole
//     project — and a multi-second pass after every Edit would dominate a session.
//     CI typechecks, and the agents can run it themselves now that they have a
//     PATH (#28). A hook named for something it cannot afford to do is how the
//     last one ended up a stub.
//
// The tool is DETECTED from the project's own config rather than read from a
// command string in a file: `.dev-team.yml` has no `commands:` schema, inventing
// one would mean executing an arbitrary string out of the target repo, and
// detection covers the real projects without either.
//
// Never fails a session. Formatting is a convenience; a formatter that is missing,
// slow, or unhappy with a file must not turn into a failed turn.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { minimatch } from 'minimatch';
import { resolvePath } from '../placeholder.js';
import type { HookResult, ToolCallContext, ToolCallHookHandler } from '../types.js';

const execFileP = promisify(execFile);

/** A formatter must never be the slowest thing in a turn. */
const FORMAT_TIMEOUT_MS = 20_000;

type LintConfig = {
  tool?: string | string[];
  if_path_matches?: unknown;
  fix?: boolean;
};

type Formatter = {
  name: string;
  bin: string;
  args: (file: string, fix: boolean) => string[];
  extensions: readonly string[];
};

/**
 * Formatters, in the order a project would want them tried. Detection is by the
 * config file the tool itself requires, so a project that has not adopted one is
 * simply skipped rather than guessed at.
 */
const FORMATTERS: ReadonlyArray<Formatter & { detect: readonly string[] }> = [
  {
    name: 'biome',
    detect: ['biome.json', 'biome.jsonc'],
    bin: 'biome',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc'],
    args: (file, fix) => (fix ? ['check', '--write', file] : ['check', file]),
  },
  {
    name: 'prettier',
    detect: ['.prettierrc', '.prettierrc.json', '.prettierrc.js', 'prettier.config.js'],
    bin: 'prettier',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.scss', '.md', '.yml', '.yaml'],
    args: (file, fix) => (fix ? ['--write', file] : ['--check', file]),
  },
  {
    name: 'ruff',
    detect: ['ruff.toml', '.ruff.toml'],
    bin: 'ruff',
    extensions: ['.py'],
    args: (file, fix) => (fix ? ['format', file] : ['format', '--check', file]),
  },
];

async function runFormatter(config: LintConfig, ctx: ToolCallContext): Promise<HookResult> {
  const cfg = config;
  if (!toolMatches(cfg.tool, ctx.tool)) {
    return { kind: 'side-effect', summary: 'format: tool skipped' };
  }

  const raw = extractPath(ctx.input);
  if (!raw) return { kind: 'side-effect', summary: 'format: no path in input' };
  if (!pathMatches(cfg.if_path_matches, raw, ctx)) {
    return { kind: 'side-effect', summary: 'format: path not in scope' };
  }

  const file = isAbsolute(raw) ? raw : join(ctx.workspaceDir ?? ctx.targetProjectRoot, raw);
  if (!existsSync(file)) return { kind: 'side-effect', summary: 'format: file not on disk' };

  // The project the file belongs to — a leased worktree when there is one, so the
  // worktree's own config wins over the shared mirror's.
  const root = projectRootFor(file, ctx);
  const found = FORMATTERS.find(
    (f) => f.detect.some((c) => existsSync(join(root, c))) && f.extensions.includes(extname(file)),
  );
  if (!found) return { kind: 'side-effect', summary: 'format: no formatter detected' };

  const bin = resolveBin(root, found.bin);
  try {
    await execFileP(bin.cmd, [...bin.prefix, ...found.args(file, cfg.fix !== false)], {
      cwd: root,
      timeout: FORMAT_TIMEOUT_MS,
    });
    return {
      kind: 'side-effect',
      summary: `format: ${found.name} on ${relative(root, file)}`,
      data: { formatter: found.name, file },
    };
  } catch (err) {
    // A lint finding exits non-zero. That is information, not a session failure —
    // the agent sees it in the summary and CI is the gate either way.
    ctx.log.debug(
      { formatter: found.name, file, err: (err as Error).message },
      'format: formatter reported a problem',
    );
    return {
      kind: 'side-effect',
      summary: `format: ${found.name} reported a problem on ${relative(root, file)}`,
      data: { formatter: found.name, file, ok: false },
    };
  }
}

export const lintAndFormatHandler: ToolCallHookHandler = async (config, ctx) =>
  runFormatter(config as LintConfig, ctx);

/** Same work; the two names exist because agents configured both spellings. */
export const formatAndLintHandler: ToolCallHookHandler = async (config, ctx) =>
  runFormatter(config as LintConfig, ctx);

/** Prefer the project's own pinned binary; fall back to npx without installing. */
function resolveBin(root: string, bin: string): { cmd: string; prefix: string[] } {
  const local = join(root, 'node_modules', '.bin', bin);
  if (existsSync(local)) return { cmd: local, prefix: [] };
  return { cmd: 'npx', prefix: ['--no-install', bin] };
}

/** The nearest of the roots this session knows that contains the file. */
function projectRootFor(file: string, ctx: ToolCallContext): string {
  const candidates = [ctx.workspaceDir, ctx.targetProjectRoot, ctx.devTeamRoot].filter(
    (c): c is string => Boolean(c),
  );
  const containing = candidates.filter((c) => file.startsWith(c));
  // Longest match wins: a worktree path under the mirror should pick the worktree.
  return containing.sort((a, b) => b.length - a.length)[0] ?? ctx.targetProjectRoot;
}

function pathMatches(patterns: unknown, path: string, ctx: ToolCallContext): boolean {
  if (!Array.isArray(patterns) || patterns.length === 0) return true;
  const resolved = resolvePath(path, ctx);
  return patterns.some(
    (p) =>
      typeof p === 'string' &&
      (minimatch(resolved, resolvePath(p, ctx), { dot: true }) ||
        // Configured globs are written repo-relative (`dev-team/router/src/**/*.ts`)
        // while the tool reports an absolute path.
        minimatch(resolved, `**/${resolvePath(p, ctx)}`, { dot: true })),
  );
}

function extractPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const rec = input as Record<string, unknown>;
  if (typeof rec.file_path === 'string') return rec.file_path;
  if (typeof rec.path === 'string') return rec.path;
  return undefined;
}

function toolMatches(cfgTool: string | string[] | undefined, actual: string): boolean {
  if (cfgTool === undefined || cfgTool === '*') return true;
  const list = Array.isArray(cfgTool) ? cfgTool : [cfgTool];
  return list.includes(actual);
}
