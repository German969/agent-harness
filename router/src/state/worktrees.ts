// worktrees — per-task git worktree lease tracking + LRU prune support.
// Per router/ARCHITECTURE.md §2.3 (worktree manager).

import type { AgentId } from '../types.js';
import type { Db } from './db.js';

export type WorktreeRow = {
  path: string;
  agent: AgentId;
  task_id: string;
  branch: string;
  created_at: number;
  last_used_at: number;
  active_session_id: number | null;
};

/** Register a freshly-created worktree. Throws on path collision. */
export function registerWorktree(
  db: Db,
  args: {
    path: string;
    agent: AgentId;
    task_id: string;
    branch: string;
    active_session_id?: number;
  },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO worktrees
       (path, agent, task_id, branch, created_at, last_used_at, active_session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(args.path, args.agent, args.task_id, args.branch, now, now, args.active_session_id ?? null);
}

export function findByTask(db: Db, agent: AgentId, task_id: string): WorktreeRow | undefined {
  return db
    .prepare('SELECT * FROM worktrees WHERE agent = ? AND task_id = ?')
    .get(agent, task_id) as WorktreeRow | undefined;
}

/** Acquire a lease (sets active_session_id). Returns true if acquired; false if busy. */
export function acquireLease(db: Db, path: string, session_id: number): boolean {
  const result = db
    .prepare(
      `UPDATE worktrees
       SET active_session_id = ?, last_used_at = ?
       WHERE path = ? AND active_session_id IS NULL`,
    )
    .run(session_id, Date.now(), path);
  return result.changes === 1;
}

/** Release a lease (clears active_session_id; updates last_used_at). */
export function releaseLease(db: Db, path: string): void {
  db.prepare('UPDATE worktrees SET active_session_id = NULL, last_used_at = ? WHERE path = ?').run(
    Date.now(),
    path,
  );
}

export function removeWorktree(db: Db, path: string): void {
  db.prepare('DELETE FROM worktrees WHERE path = ?').run(path);
}

/** Worktrees idle (no active session) and unused for >= maxIdleMs. */
export function listIdleWorktrees(db: Db, maxIdleMs: number): WorktreeRow[] {
  const cutoff = Date.now() - maxIdleMs;
  return db
    .prepare(
      `SELECT * FROM worktrees
       WHERE active_session_id IS NULL AND last_used_at < ?
       ORDER BY last_used_at ASC`,
    )
    .all(cutoff) as WorktreeRow[];
}

/** Oldest idle worktrees (for disk-pressure force-prune). */
export function listOldestIdle(db: Db, limit: number): WorktreeRow[] {
  return db
    .prepare(
      `SELECT * FROM worktrees
       WHERE active_session_id IS NULL
       ORDER BY last_used_at ASC
       LIMIT ?`,
    )
    .all(limit) as WorktreeRow[];
}
