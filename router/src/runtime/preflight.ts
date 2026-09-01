// Pre-flight checks that run BEFORE any expensive prep (worktree, MCP boot).
//
// Two checks (both fast, no side effects):
//   1. Cost cap — would spending `perJobCostUsd` push this agent's month-to-date
//      spend over `monthlyCostUsd`? If so, refuse. (Per ARCHITECTURE.md §2.7.)
//   2. Founding-docs gate — SessionStart's `check` hooks must not gate before
//      SDK invocation. Runs the SessionStart phase preflight-only.
//
// A preflight FAILURE is not an error — it's a decision to refuse the session.
// The caller records the session status accordingly + notifies the trigger surface.

import type { AgentSettings } from '../config/settingsSchema.js';
import type { HookEntry } from '../config/settingsSchema.js';
import type { PhaseResult, SessionContext } from '../hooks/index.js';
import { runSessionPhase } from '../hooks/index.js';
import { dayKey, getMonthlyAgentSpend } from '../state/cost.js';
import type { Db } from '../state/db.js';
import type { AgentId } from '../types.js';

export type PreflightRefusal =
  | {
      kind: 'cost_cap_hit';
      agent: AgentId;
      monthlyCostUsd: number;
      monthToDateUsd: number;
      wouldExceedByUsd: number;
    }
  | { kind: 'gated'; reason: string; message: string };

export type PreflightOutcome =
  | { kind: 'ok'; sessionStart: PhaseResult }
  | { kind: 'refused'; refusal: PreflightRefusal };

/**
 * Cost-cap pre-flight (no side effects — read-only against the ledger).
 * Returns a refusal if adding `perJobCostUsd` would exceed `monthlyCostUsd`.
 */
export function checkCostCap(
  db: Db,
  agent: AgentId,
  costCap: { monthlyCostUsd: number; perJobCostUsd: number },
  now?: number,
): PreflightRefusal | null {
  const k = dayKey(now);
  const monthToDate = getMonthlyAgentSpend(db, agent, k.year, k.month);
  const projected = monthToDate + costCap.perJobCostUsd;
  if (projected > costCap.monthlyCostUsd) {
    return {
      kind: 'cost_cap_hit',
      agent,
      monthlyCostUsd: costCap.monthlyCostUsd,
      monthToDateUsd: monthToDate,
      wouldExceedByUsd: projected - costCap.monthlyCostUsd,
    };
  }
  return null;
}

/**
 * Runs the full pre-flight sequence:
 *   1. cost-cap check
 *   2. SessionStart hooks (which include founding-docs `check` gates)
 *
 * Returns the SessionStart phase result so the caller can inject `contexts`
 * into the SDK's initial context.
 */
export async function runPreflight(
  db: Db,
  agent: AgentId,
  settings: AgentSettings,
  sessionStartHooks: HookEntry[],
  ctx: SessionContext,
  now?: number,
): Promise<PreflightOutcome> {
  const capRefusal = checkCostCap(
    db,
    agent,
    {
      monthlyCostUsd: settings.costCap.monthlyCostUsd,
      perJobCostUsd: settings.costCap.perJobCostUsd,
    },
    now,
  );
  if (capRefusal) return { kind: 'refused', refusal: capRefusal };

  const sessionStart = await runSessionPhase(sessionStartHooks, ctx, 'SessionStart');
  if (sessionStart.gate) {
    return {
      kind: 'refused',
      refusal: {
        kind: 'gated',
        reason: sessionStart.gate.reason,
        message: sessionStart.gate.message,
      },
    };
  }
  return { kind: 'ok', sessionStart };
}
