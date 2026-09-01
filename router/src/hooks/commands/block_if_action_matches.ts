// PreToolUse hook — command: 'block_if_action_matches' (Marketer's publish-gate + Harness's PR-only guard)
// Denies a tool call if the tool name OR an action verb in the input matches any pattern.
//
// This is the mechanism behind Marketer's "draft, never publish" rule:
//   patterns: ['publish', 'schedule_publish', 'send_now', 'post_now', 'launch', 'spend']
// Any tool whose name contains those verbs → denied.

import type { HookResult, ToolCallContext, ToolCallHookHandler } from '../types.js';

type BlockIfActionConfig = {
  tool?: string | string[];
  block_if_action_matches?: unknown;
  deny_always?: boolean;
  message?: string;
};

export const blockIfActionMatchesHandler: ToolCallHookHandler = async (
  config,
  ctx,
): Promise<HookResult> => {
  const cfg = config as BlockIfActionConfig;

  if (!toolMatches(cfg.tool, ctx.tool)) return { kind: 'allow' };

  const patterns = Array.isArray(cfg.block_if_action_matches)
    ? (cfg.block_if_action_matches as string[])
    : [];
  if (patterns.length === 0) return { kind: 'allow' };

  const toolLower = ctx.tool.toLowerCase();
  const actionLower = ctx.action?.toLowerCase();

  for (const pattern of patterns) {
    const p = pattern.toLowerCase();
    if (toolLower.includes(p) || actionLower?.includes(p)) {
      return {
        kind: 'deny',
        message:
          cfg.message ??
          `🛑 tool "${ctx.tool}" blocked — matches denied action pattern "${pattern}"`,
      };
    }
  }
  return { kind: 'allow' };
};

function toolMatches(cfgTool: string | string[] | undefined, actual: string): boolean {
  if (cfgTool === undefined || cfgTool === '*') return true;
  if (typeof cfgTool === 'string') return cfgTool === actual;
  return cfgTool.includes(actual);
}
