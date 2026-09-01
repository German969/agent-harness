// cost_ledger queries — per-agent monthly spend lookups for cap pre-flight + reporting.
// Per router/ARCHITECTURE.md §2.7 (cost cap algorithm) + §2.6 (schema).

import type { AgentId } from '../types.js';
import type { Db } from './db.js';

export type DayKey = { year: number; month: number; day: number };

/** UTC date components for the given timestamp. Monthly caps reset on the 1st 00:00 UTC. */
export function dayKey(ts: number = Date.now()): DayKey {
  const d = new Date(ts);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1, // 1-12
    day: d.getUTCDate(),
  };
}

/**
 * Record a per-turn cost delta. Increments the day's rollup row (UPSERT).
 * Called from the runtime's onTurnComplete callback.
 */
export function recordTurnCost(
  db: Db,
  agent: AgentId,
  delta: {
    cost_usd: number;
    input_tokens: number;
    cache_write_tokens?: number;
    cache_read_tokens?: number;
    output_tokens: number;
  },
  ts?: number,
): void {
  const k = dayKey(ts);
  db.prepare(
    `INSERT INTO cost_ledger
       (agent, year, month, day, cost_usd, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, sessions_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(agent, year, month, day) DO UPDATE SET
       cost_usd = cost_usd + excluded.cost_usd,
       input_tokens = input_tokens + excluded.input_tokens,
       cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       output_tokens = output_tokens + excluded.output_tokens`,
  ).run(
    agent,
    k.year,
    k.month,
    k.day,
    delta.cost_usd,
    delta.input_tokens,
    delta.cache_write_tokens ?? 0,
    delta.cache_read_tokens ?? 0,
    delta.output_tokens,
  );
}

/** Bump session count for the day (called once per session start). */
export function recordSessionStart(db: Db, agent: AgentId, ts?: number): void {
  const k = dayKey(ts);
  db.prepare(
    `INSERT INTO cost_ledger
       (agent, year, month, day, sessions_count)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(agent, year, month, day) DO UPDATE SET
       sessions_count = sessions_count + 1`,
  ).run(agent, k.year, k.month, k.day);
}

/** Total cost for an agent in a given month. Used by the cost-cap pre-flight. */
export function getMonthlyAgentSpend(db: Db, agent: AgentId, year: number, month: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total
       FROM cost_ledger
       WHERE agent = ? AND year = ? AND month = ?`,
    )
    .get(agent, year, month) as { total: number };
  return row.total;
}

export type DailyRollup = {
  agent: AgentId;
  year: number;
  month: number;
  day: number;
  cost_usd: number;
  input_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  sessions_count: number;
};

/** All daily rollups for an agent in a month. Used by FinOps weekly reports. */
export function listMonthlyRollup(
  db: Db,
  agent: AgentId,
  year: number,
  month: number,
): DailyRollup[] {
  return db
    .prepare(
      `SELECT * FROM cost_ledger
       WHERE agent = ? AND year = ? AND month = ?
       ORDER BY day`,
    )
    .all(agent, year, month) as DailyRollup[];
}
