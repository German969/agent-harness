// schedule_runs + schedule_overrides + schedule_override_history queries.
// Per router/ARCHITECTURE.md §2.8 (scheduler) + §2.6 (schema).

import type { AgentId } from '../types.js';
import type { Db } from './db.js';

// ----------------------------------------------------------------------------
// schedule_runs — history of every cron tick
// ----------------------------------------------------------------------------

export type ScheduleOutcome =
  | 'started'
  | 'skipped_overlap'
  | 'skipped_disabled'
  | 'skipped_phase_gate'
  | 'failed_to_start';

export type ScheduleRunRow = {
  id: number;
  cron_id: string;
  agent: AgentId;
  fired_at: number;
  session_id: number | null;
  outcome: ScheduleOutcome | null;
};

export function recordRun(
  db: Db,
  cron_id: string,
  agent: AgentId,
  outcome: ScheduleOutcome,
  session_id?: number,
): number {
  const result = db
    .prepare(
      `INSERT INTO schedule_runs (cron_id, agent, fired_at, session_id, outcome)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(cron_id, agent, Date.now(), session_id ?? null, outcome);
  return result.lastInsertRowid as number;
}

export function lastRunForCron(db: Db, cron_id: string): ScheduleRunRow | undefined {
  return db
    .prepare('SELECT * FROM schedule_runs WHERE cron_id = ? ORDER BY fired_at DESC LIMIT 1')
    .get(cron_id) as ScheduleRunRow | undefined;
}

export function hasActiveRunFor(db: Db, cron_id: string): boolean {
  // A cron is "actively running" if its most-recent session_id refers to a session
  // that's still running. Used by the overlap guard in §2.8.
  const row = db
    .prepare(
      `SELECT s.id
       FROM schedule_runs r
       JOIN sessions s ON s.id = r.session_id
       WHERE r.cron_id = ? AND s.status = 'running'
       LIMIT 1`,
    )
    .get(cron_id);
  return row !== undefined;
}

// ----------------------------------------------------------------------------
// schedule_overrides — runtime enable/disable
// ----------------------------------------------------------------------------

export type ScheduleOverrideRow = {
  cron_id: string;
  enabled: 0 | 1;
  set_by: string;
  set_at: number;
  reason: string | null;
};

export function getOverride(db: Db, cron_id: string): ScheduleOverrideRow | undefined {
  return db.prepare('SELECT * FROM schedule_overrides WHERE cron_id = ?').get(cron_id) as
    | ScheduleOverrideRow
    | undefined;
}

export function listOverrides(db: Db): ScheduleOverrideRow[] {
  return db.prepare('SELECT * FROM schedule_overrides').all() as ScheduleOverrideRow[];
}

/**
 * Upsert an override + append history entry. Atomic via transaction.
 * Returns the new override state.
 */
export function setOverride(
  db: Db,
  args: { cron_id: string; enabled: boolean; set_by: string; reason?: string },
): ScheduleOverrideRow {
  const ts = Date.now();
  const enabledInt: 0 | 1 = args.enabled ? 1 : 0;

  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO schedule_overrides (cron_id, enabled, set_by, set_at, reason)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(cron_id) DO UPDATE SET
         enabled = excluded.enabled,
         set_by = excluded.set_by,
         set_at = excluded.set_at,
         reason = excluded.reason`,
    ).run(args.cron_id, enabledInt, args.set_by, ts, args.reason ?? null);

    db.prepare(
      `INSERT INTO schedule_override_history (cron_id, enabled, set_by, set_at, reason)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(args.cron_id, enabledInt, args.set_by, ts, args.reason ?? null);
  });

  txn();

  return {
    cron_id: args.cron_id,
    enabled: enabledInt,
    set_by: args.set_by,
    set_at: ts,
    reason: args.reason ?? null,
  };
}

/** Remove the override row. History entries are preserved. */
export function clearOverride(db: Db, cron_id: string, set_by: string, reason?: string): void {
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM schedule_overrides WHERE cron_id = ?').run(cron_id);
    // Record the "reset" in history so the audit trail captures it.
    db.prepare(
      `INSERT INTO schedule_override_history (cron_id, enabled, set_by, set_at, reason)
       VALUES (?, -1, ?, ?, ?)`,
    ).run(cron_id, set_by, Date.now(), reason ?? 'reset to YAML default');
  });
  txn();
}

// ----------------------------------------------------------------------------
// schedule_override_history — audit trail
// ----------------------------------------------------------------------------

export type ScheduleOverrideHistoryRow = {
  id: number;
  cron_id: string;
  enabled: number; // -1 = reset; 0 = disabled; 1 = enabled
  set_by: string;
  set_at: number;
  reason: string | null;
};

export function listHistory(db: Db, cron_id: string): ScheduleOverrideHistoryRow[] {
  return db
    .prepare('SELECT * FROM schedule_override_history WHERE cron_id = ? ORDER BY set_at DESC')
    .all(cron_id) as ScheduleOverrideHistoryRow[];
}
