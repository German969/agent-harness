// sessions table — CRUD + lookup queries.
// Per router/ARCHITECTURE.md §1.2 (continuation logic) + §2.6 (schema).

import type { AgentId, SessionStatus, SkillId, TriggerKind } from '../types.js';
import type { Db } from './db.js';

export type SessionRow = {
  id: number;
  agent: AgentId;
  skill: SkillId | null;
  thread_key: string;
  claude_session_id: string | null;
  status: SessionStatus;
  triggered_by: TriggerKind;
  triggered_by_session_id: number | null;
  trigger_payload: string; // JSON-encoded
  started_at: number;
  ended_at: number | null;
  turns: number;
  cost_usd: number;
  cost_input_tokens: number;
  cost_cache_write_tokens: number;
  cost_cache_read_tokens: number;
  cost_output_tokens: number;
  worktree_path: string | null;
  error_kind: string | null;
  notes: string | null;
};

export type CreateSessionInput = {
  agent: AgentId;
  skill?: SkillId;
  thread_key: string;
  status: SessionStatus;
  triggered_by: TriggerKind;
  triggered_by_session_id?: number;
  trigger_payload: unknown;
  started_at?: number;
  worktree_path?: string;
};

export function createSession(db: Db, input: CreateSessionInput): number {
  const result = db
    .prepare(
      `INSERT INTO sessions
        (agent, skill, thread_key, status, triggered_by, triggered_by_session_id,
         trigger_payload, started_at, worktree_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.agent,
      input.skill ?? null,
      input.thread_key,
      input.status,
      input.triggered_by,
      input.triggered_by_session_id ?? null,
      JSON.stringify(input.trigger_payload),
      input.started_at ?? Date.now(),
      input.worktree_path ?? null,
    );
  return result.lastInsertRowid as number;
}

export function getSession(db: Db, id: number): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
}

export function updateStatus(
  db: Db,
  id: number,
  status: SessionStatus,
  fields?: {
    ended_at?: number;
    turns?: number;
    cost_usd?: number;
    cost_input_tokens?: number;
    cost_output_tokens?: number;
    error_kind?: string;
    notes?: string;
    claude_session_id?: string;
  },
): void {
  const sets: string[] = ['status = ?'];
  const values: (string | number | null)[] = [status];

  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      sets.push(`${key} = ?`);
      values.push(value as string | number);
    }
  }
  values.push(id);

  db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function addTurnCost(
  db: Db,
  id: number,
  delta: {
    cost_usd: number;
    input_tokens: number;
    cache_write_tokens?: number;
    cache_read_tokens?: number;
    output_tokens: number;
  },
): void {
  db.prepare(
    `UPDATE sessions
     SET turns = turns + 1,
         cost_usd = cost_usd + ?,
         cost_input_tokens = cost_input_tokens + ?,
         cost_cache_write_tokens = cost_cache_write_tokens + ?,
         cost_cache_read_tokens = cost_cache_read_tokens + ?,
         cost_output_tokens = cost_output_tokens + ?
     WHERE id = ?`,
  ).run(
    delta.cost_usd,
    delta.input_tokens,
    delta.cache_write_tokens ?? 0,
    delta.cache_read_tokens ?? 0,
    delta.output_tokens,
    id,
  );
}

/**
 * Per ARCHITECTURE.md §1.2: find a prior session in the same thread within the
 * continuation window. Returns the most-recent eligible session (or undefined).
 */
export function findContinuation(
  db: Db,
  threadKey: string,
  withinMs: number,
): SessionRow | undefined {
  const cutoff = Date.now() - withinMs;
  // Only `completed` sessions are safe to resume via options.resume. Sessions
  // in `interrupted_needs_resume` (max_turns_reached, ratelimit, transient
  // SDK errors) have been observed to fail with `error_during_execution`
  // ~1s after resume — the SDK-side state can't recover. Start fresh instead.
  // If a specific interrupt kind is later confirmed resumable, add its status
  // back with test coverage.
  return db
    .prepare(
      `SELECT * FROM sessions
       WHERE thread_key = ?
         AND status = 'completed'
         AND ended_at IS NOT NULL
         AND ended_at > ?
       ORDER BY ended_at DESC
       LIMIT 1`,
    )
    .get(threadKey, cutoff) as SessionRow | undefined;
}

/**
 * Walk `triggered_by_session_id` back to the root of a continuation chain.
 * Returns the id of the first session in the thread. Bounded to avoid infinite
 * loops from any accidental cycle.
 */
export function findRootSessionId(db: Db, id: number): number {
  const stmt = db.prepare('SELECT triggered_by_session_id FROM sessions WHERE id = ?');
  let current = id;
  for (let i = 0; i < 100; i++) {
    const row = stmt.get(current) as { triggered_by_session_id: number | null } | undefined;
    if (!row || row.triggered_by_session_id == null) return current;
    current = row.triggered_by_session_id;
  }
  return current;
}

/** Sessions currently running for a given agent (used by overlap protection). */
export function listRunning(db: Db, agent: AgentId): SessionRow[] {
  return db
    .prepare("SELECT * FROM sessions WHERE agent = ? AND status = 'running'")
    .all(agent) as SessionRow[];
}

/**
 * Recovery: on router restart, mark every still-'running' session as interrupted.
 * The next trigger in those threads will resume per the Token/Cost Resilience Protocol.
 * Returns the number of rows updated.
 */
export function markRunningAsInterrupted(db: Db): number {
  const result = db
    .prepare(
      `UPDATE sessions
       SET status = 'interrupted_needs_resume',
           ended_at = ?
       WHERE status = 'running'`,
    )
    .run(Date.now());
  return result.changes;
}
