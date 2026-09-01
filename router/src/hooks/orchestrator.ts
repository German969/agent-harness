// Hook orchestrator — runs each phase's hook array in order + aggregates results.
//
// Design decisions:
//   - Sequential execution per phase (not parallel). Hook order in settings.json
//     is intentional; e.g. a `check` gate should fire BEFORE `load` context accumulates.
//   - Unknown commands are logged + skipped, not fatal — allows Phase 6b to ship
//     a handler set that doesn't cover every command in every settings.json.
//   - Errors in individual hooks don't stop the phase; they accumulate in the
//     PhaseResult.errors array. Caller decides whether the overall session survives.
//   - The FIRST gate wins (early-exit the phase after emitting a gate).
//   - The FIRST deny wins (early-exit the phase after emitting a deny).

import type { HookEntry } from '../config/settingsSchema.js';
import { getSessionHandler, getToolCallHandler, inferCommand } from './registry.js';
import type { PhaseResult, SessionContext, ToolCallContext } from './types.js';

export async function runSessionPhase(
  entries: HookEntry[],
  ctx: SessionContext,
  phaseLabel: 'SessionStart' | 'SessionEnd',
): Promise<PhaseResult> {
  const result: PhaseResult = {
    contexts: [],
    sideEffects: [],
    errors: [],
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const command = inferCommand(entry as unknown as Record<string, unknown>);
    if (!command) {
      ctx.log.warn(
        { phase: phaseLabel, index: i },
        'hook entry has no resolvable command; skipped',
      );
      continue;
    }
    const handler = getSessionHandler(command);
    if (!handler) {
      ctx.log.warn(
        { phase: phaseLabel, index: i, command },
        'unknown session-hook command; skipped',
      );
      continue;
    }

    try {
      const r = await handler(entry, ctx);
      switch (r.kind) {
        case 'context':
          result.contexts.push({ content: r.content, ...(r.tag ? { tag: r.tag } : {}) });
          break;
        case 'gate':
          result.gate = { reason: r.reason, message: r.message };
          // First gate wins — stop the phase.
          return result;
        case 'side-effect':
          result.sideEffects.push({ summary: r.summary, ...(r.data ? { data: r.data } : {}) });
          break;
        case 'error':
          result.errors.push({ commandIndex: i, error: r.error });
          break;
        default:
          // 'allow' / 'deny' — shouldn't come from session-phase hooks, but be lenient.
          ctx.log.warn(
            { phase: phaseLabel, kind: (r as { kind: string }).kind },
            'session-hook returned tool-call kind — ignored',
          );
      }
    } catch (err) {
      // Handler throwing (shouldn't happen; handlers are supposed to return `error`).
      result.errors.push({ commandIndex: i, error: err as Error });
    }
  }

  return result;
}

export async function runToolCallPhase(
  entries: HookEntry[],
  ctx: ToolCallContext,
  phaseLabel: 'PreToolUse' | 'PostToolUse',
): Promise<PhaseResult> {
  const result: PhaseResult = {
    contexts: [],
    sideEffects: [],
    errors: [],
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const command = inferCommand(entry as unknown as Record<string, unknown>);
    if (!command) {
      ctx.log.warn(
        { phase: phaseLabel, index: i },
        'hook entry has no resolvable command; skipped',
      );
      continue;
    }
    const handler = getToolCallHandler(command);
    if (!handler) {
      ctx.log.warn(
        { phase: phaseLabel, index: i, command },
        'unknown tool-call-hook command; skipped',
      );
      continue;
    }

    try {
      const r = await handler(entry, ctx);
      switch (r.kind) {
        case 'allow':
          // Explicit allow — record no side-effect; continue.
          break;
        case 'deny':
          result.deny = { message: r.message };
          // First deny wins — stop the phase.
          return result;
        case 'side-effect':
          result.sideEffects.push({ summary: r.summary, ...(r.data ? { data: r.data } : {}) });
          break;
        case 'error':
          result.errors.push({ commandIndex: i, error: r.error });
          break;
        default:
          ctx.log.warn(
            { phase: phaseLabel, kind: (r as { kind: string }).kind },
            'tool-call hook returned session-phase kind — ignored',
          );
      }
    } catch (err) {
      result.errors.push({ commandIndex: i, error: err as Error });
    }
  }

  return result;
}
