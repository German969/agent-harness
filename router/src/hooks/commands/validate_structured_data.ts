// PostToolUse hook — command: 'validate_structured_data'
// After an Edit/Write to a JSON or YAML file, verify it parses. Non-blocking:
// if invalid, emit a warning (log-only) so the model sees the error in the reply
// and can fix on the next turn.

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import type { HookResult, ToolCallContext, ToolCallHookHandler } from '../types.js';

type ValidateStructuredDataConfig = {
  tool?: string | string[];
  if_path_matches?: unknown;
  fix?: boolean; // ignored in v1 — informational only
};

export const validateStructuredDataHandler: ToolCallHookHandler = async (
  config,
  ctx,
): Promise<HookResult> => {
  const cfg = config as ValidateStructuredDataConfig;

  if (!toolMatches(cfg.tool, ctx.tool)) {
    return { kind: 'side-effect', summary: 'validate_structured_data: tool skipped' };
  }

  const path = extractInputPath(ctx.input);
  if (!path) {
    return { kind: 'side-effect', summary: 'validate_structured_data: no path in input' };
  }

  const ext = detectExtension(path);
  if (!ext) {
    return { kind: 'side-effect', summary: 'validate_structured_data: unsupported extension' };
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    return {
      kind: 'side-effect',
      summary: `validate_structured_data: unreadable (${(err as Error).message})`,
    };
  }

  try {
    if (ext === 'json') JSON.parse(raw);
    else if (ext === 'yaml') yaml.load(raw);
  } catch (err) {
    ctx.log.warn(
      { path, ext, reason: (err as Error).message },
      'validate_structured_data: file failed to parse',
    );
    return {
      kind: 'side-effect',
      summary: `validate_structured_data: ${path} INVALID (${(err as Error).message})`,
      data: { invalid: true, path },
    };
  }

  return { kind: 'side-effect', summary: `validate_structured_data: ${path} ok` };
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

function detectExtension(path: string): 'json' | 'yaml' | undefined {
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.yml') || path.endsWith('.yaml')) return 'yaml';
  return undefined;
}
