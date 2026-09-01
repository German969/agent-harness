// cost_alerts_emitted table — idempotency for cost-cap warning posts.
// Per Phase 8 / ARCHITECTURE.md §2.7 — "80% threshold alert fires once per
// agent per month."

import type { AgentId } from '../types.js';
import type { Db } from './db.js';

export type AlertKey = { agent: AgentId; year: number; month: number; level: number };

/**
 * Returns true if an alert at `level` (integer %, e.g. 80) has already been
 * emitted for this agent in this month.
 */
export function wasAlertEmitted(db: Db, key: AlertKey): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM cost_alerts_emitted
       WHERE agent = ? AND year = ? AND month = ? AND level = ?`,
    )
    .get(key.agent, key.year, key.month, key.level);
  return row !== undefined;
}

/**
 * Record that an alert was emitted. Idempotent — repeat calls with the same
 * (agent, year, month, level) are no-ops thanks to the PK conflict clause.
 */
export function recordAlertEmitted(
  db: Db,
  key: AlertKey,
  costUsdAtEmit: number,
  ts: number = Date.now(),
): void {
  db.prepare(
    `INSERT INTO cost_alerts_emitted (agent, year, month, level, emitted_at, cost_usd_at_emit)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent, year, month, level) DO NOTHING`,
  ).run(key.agent, key.year, key.month, key.level, ts, costUsdAtEmit);
}
