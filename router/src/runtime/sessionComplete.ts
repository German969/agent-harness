// Complete phase — per ARCHITECTURE.md §1.5.
//
// Steps (best-effort; each is guarded so a later step still runs after an
// earlier one fails):
//   1. SessionEnd hooks — commits, PR intents, lint stubs
//   2. Final session-row update (status + totals)
//   4. Workspace release (does not delete the worktree — Phase 5 owns pruning)
//
// The caller (orchestrator) already recorded the terminal outcome; this
// function's job is to run wrap-up + return a summary for logging.

import type { Logger } from 'pino';
import type { HookEntry } from '../config/settingsSchema.js';
import type { PhaseResult, SessionContext } from '../hooks/index.js';
import { runSessionPhase } from '../hooks/index.js';
import type { Db } from '../state/db.js';
import { updateStatus } from '../state/sessions.js';
import type { SessionStatus } from '../types.js';
import type { WorkspaceLease } from '../workspace/manager.js';
import { mapErrorToStatus } from './errorHandler.js';
import type { SessionOutcome } from './sdk.js';

export type CompleteOptions = {
  db: Db;
  log: Logger;
  sessionId: number;
  ctx: SessionContext;
  workspace?: WorkspaceLease | undefined;
  outcome: SessionOutcome;
  sessionEndHooks: HookEntry[];
  totalCostUsd: number;
  turns: number;
  finalNotes?: string | undefined;
};

export type CompleteResult = {
  status: SessionStatus;
  sessionEnd: PhaseResult;
  workspaceReleased: boolean;
};

export async function completeSession(opts: CompleteOptions): Promise<CompleteResult> {
  // ---- 1. SessionEnd hooks ------------------------------------------------
  let sessionEnd: PhaseResult;
  try {
    sessionEnd = await runSessionPhase(opts.sessionEndHooks, opts.ctx, 'SessionEnd');
  } catch (err) {
    opts.log.error(
      { sessionId: opts.sessionId, err: (err as Error).message },
      'SessionEnd phase threw unexpectedly',
    );
    sessionEnd = {
      contexts: [],
      sideEffects: [],
      errors: [{ commandIndex: -1, error: err as Error }],
    };
  }

  // ---- 2. Final session row update ---------------------------------------
  const status = mapOutcomeToStatus(opts.outcome);
  try {
    const errKind = opts.outcome.kind === 'error' ? classifyError(opts.outcome.error) : undefined;
    updateStatus(opts.db, opts.sessionId, status, {
      ended_at: Date.now(),
      turns: opts.turns,
      cost_usd: opts.totalCostUsd,
      ...(errKind ? { error_kind: errKind } : {}),
      ...(opts.finalNotes ? { notes: opts.finalNotes } : {}),
      ...(opts.outcome.claudeSessionId ? { claude_session_id: opts.outcome.claudeSessionId } : {}),
    });
  } catch (err) {
    opts.log.error(
      { sessionId: opts.sessionId, err: (err as Error).message },
      'failed to update session row at completion — session left in previous status',
    );
  }

  // No MCP teardown: the Agent SDK spawns MCP children and terminates them itself.

  // ---- 4. Workspace release ---------------------------------------------
  let workspaceReleased = false;
  if (opts.workspace) {
    try {
      await opts.workspace.release();
      workspaceReleased = true;
    } catch (err) {
      opts.log.error(
        { sessionId: opts.sessionId, err: (err as Error).message },
        'workspace release failed',
      );
    }
  }

  return { status, sessionEnd, workspaceReleased };
}

function mapOutcomeToStatus(outcome: SessionOutcome): SessionStatus {
  switch (outcome.kind) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'max_turns_reached':
      return 'interrupted_needs_resume';
    case 'error':
      return mapErrorToStatus(outcome.error);
  }
}

function classifyError(err: Error): string {
  return err.name || 'Error';
}
