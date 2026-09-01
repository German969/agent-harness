// PreToolUse hook — command: 'block_if_path_matches' (implicit; matched via tool + block_if_path_matches array)
// Denies a tool call if the target path matches any glob pattern in the block list.

import { minimatch } from 'minimatch';
import { resolvePath } from '../placeholder.js';
import type { HookResult, ToolCallContext, ToolCallHookHandler } from '../types.js';

type BlockIfPathConfig = {
  tool?: string | string[];
  block_if_path_matches?: unknown;
  message?: string;
};

export const blockIfPathMatchesHandler: ToolCallHookHandler = async (
  config,
  ctx,
): Promise<HookResult> => {
  const cfg = config as BlockIfPathConfig;

  // Tool filter: config.tool can be a string, an array, or omitted (means "match any").
  if (!toolMatches(cfg.tool, ctx.tool)) return { kind: 'allow' };

  const patterns = Array.isArray(cfg.block_if_path_matches)
    ? (cfg.block_if_path_matches as string[])
    : [];
  if (patterns.length === 0) return { kind: 'allow' };

  // Extract the path from tool input. Convention: input.path or input.file_path.
  const inputPath = extractInputPath(ctx.input);
  if (!inputPath) return { kind: 'allow' };

  const resolvedInputPath = resolvePath(inputPath, ctx);

  for (const template of patterns) {
    const resolvedPattern = resolvePath(template, ctx);
    if (minimatch(resolvedInputPath, resolvedPattern)) {
      return {
        kind: 'deny',
        message: cfg.message ?? `path blocked by hook rule: ${template}`,
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

function extractInputPath(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const rec = input as Record<string, unknown>;
  if (typeof rec.path === 'string') return rec.path;
  if (typeof rec.file_path === 'string') return rec.file_path;
  return undefined;
}
