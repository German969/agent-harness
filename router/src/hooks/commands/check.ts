// SessionStart hook — command: 'check'
//
// If any of `if_missing` paths don't exist, behavior depends on `then`:
//   - `then: refuse` (default) → emit a `gate` result; orchestrator refuses session
//   - `then: set_context`     → emit a `context` block flagging the deficiency;
//                                session proceeds and the agent decides what to do
//
// Strategist uses `set_context` for the founding-docs check — this lets the
// `founding` skill run when docs are missing (to author them), while other
// skills self-refuse via the injected `founding_incomplete=true` flag.

import { statSync } from 'node:fs';
import { resolvePath } from '../placeholder.js';
import type { HookHandler, HookResult } from '../types.js';

type CheckConfig = {
  if_missing: unknown;
  then?: string; // 'set_context' | 'refuse' — default: refuse
  context?: string;
  message?: string;
};

export const checkHandler: HookHandler = async (config, ctx): Promise<HookResult> => {
  const cfg = config as CheckConfig;
  const paths = Array.isArray(cfg.if_missing) ? (cfg.if_missing as string[]) : [];
  const mode = cfg.then === 'set_context' ? 'set_context' : 'refuse';

  const missing: string[] = [];
  for (const template of paths) {
    const resolved = resolvePath(template, ctx);
    let exists = false;
    try {
      exists = statSync(resolved).isFile();
    } catch {
      exists = false;
    }
    if (!exists) missing.push(template);
  }

  if (missing.length === 0) {
    return { kind: 'side-effect', summary: 'check: all required files present' };
  }

  if (mode === 'set_context') {
    ctx.log.info(
      { missing, flag: cfg.context ?? 'check_incomplete' },
      'check: files missing — injecting context flag, letting agent decide',
    );
    const header = cfg.context ? `${cfg.context}\n` : '';
    const list = `Missing files:\n${missing.map((p) => `  - ${p}`).join('\n')}`;
    const guidance = cfg.message ? `\n\nGuidance: ${cfg.message}` : '';
    const contextBlock = `${header}${list}${guidance}`;
    return { kind: 'context', content: contextBlock, tag: 'check' };
  }

  ctx.log.warn(
    { missing, gate: cfg.context ?? 'unnamed' },
    'check: required file missing — gating session',
  );
  return {
    kind: 'gate',
    reason: cfg.context ?? `missing:${missing[0]}`,
    message:
      cfg.message ??
      `Required files missing: ${missing.join(', ')}. Cannot proceed with substantive session work.`,
  };
};
