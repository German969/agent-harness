// PreToolUse hook — command: 'block_if_command_matches'
// Denies a tool call when the tool's command string matches a regex in `patterns`
// (or the single `pattern`), OR — when no patterns are given and `deny_always` is
// set — whenever the tool itself matches (a flat tool denial).
//
// This backs two shapes present in every agent's settings.json that the router
// previously ignored (followup #9):
//   - git-push-to-main / bypass-attempt gates:
//       { tool: 'Bash', patterns: ['git push.*\\b(main|master)\\b', ...], deny_always: true }
//   - flat tool denials:
//       { tool: 'mcp__github__merge_pull_request', deny_always: true }
//       { tool: ['mcp__infisical__*', 'mcp__secrets__*'], deny_always: true }
//
// `inferCommand` used to return undefined for these, so the orchestrator skipped
// them and the gate never fired — the block-push-to-main constraint was inert.

import { minimatch } from 'minimatch';
import type { HookResult, ToolCallContext, ToolCallHookHandler } from '../types.js';

type BlockIfCommandConfig = {
  tool?: string | string[];
  patterns?: unknown;
  pattern?: unknown;
  deny_always?: boolean;
  message?: string;
};

export const blockIfCommandMatchesHandler: ToolCallHookHandler = async (
  config,
  ctx,
): Promise<HookResult> => {
  const cfg = config as BlockIfCommandConfig;

  if (!toolMatches(cfg.tool, ctx.tool)) return { kind: 'allow' };

  const patterns = collectPatterns(cfg);

  // No patterns → a flat tool denial (only a `tool` filter + `deny_always`).
  if (patterns.length === 0) {
    if (cfg.deny_always === true) return deny(cfg, `tool "${ctx.tool}" is denied`);
    return { kind: 'allow' };
  }

  const haystack = commandHaystack(ctx);
  for (const pattern of patterns) {
    const rx = compile(pattern, ctx);
    if (rx?.test(haystack)) return deny(cfg, `command blocked by hook rule: ${pattern}`);
  }
  return { kind: 'allow' };
};

function deny(cfg: { message?: string }, fallback: string): HookResult {
  return { kind: 'deny', message: cfg.message ?? `🛑 ${fallback}` };
}

function collectPatterns(cfg: BlockIfCommandConfig): string[] {
  const out: string[] = [];
  if (Array.isArray(cfg.patterns)) {
    for (const p of cfg.patterns) if (typeof p === 'string') out.push(p);
  }
  if (typeof cfg.pattern === 'string') out.push(cfg.pattern);
  return out;
}

// The string a `patterns` regex tests against: tool name, action verb, and the
// command/args. For Bash that means `input.command`; for other tools we fall back
// to a JSON view of the input so patterns can still match arguments.
function commandHaystack(ctx: ToolCallContext): string {
  const parts = [ctx.tool, ctx.action ?? ''];
  const input = ctx.input;
  if (input && typeof input === 'object') {
    const command = (input as Record<string, unknown>).command;
    parts.push(typeof command === 'string' ? command : JSON.stringify(input));
  }
  return parts.join(' ');
}

function compile(pattern: string, ctx: ToolCallContext): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch (err) {
    ctx.log.warn(
      { pattern, err: (err as Error).message },
      'block_if_command_matches: invalid regex; skipped',
    );
    return undefined;
  }
}

function toolMatches(cfgTool: string | string[] | undefined, actual: string): boolean {
  if (cfgTool === undefined || cfgTool === '*') return true;
  const globs = Array.isArray(cfgTool) ? cfgTool : [cfgTool];
  return globs.some((g) => g === actual || minimatch(actual, g));
}
