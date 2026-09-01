// agent_chain — parent→child session links for loop prevention.
// Per router/ARCHITECTURE.md §3.1 (multi-agent coordination + loop prevention).

import type { Db } from './db.js';

export type AgentChainVia =
  | 'linear_assign'
  | 'pr_review'
  | 'slack_mention'
  | 'github_comment'
  /** An agent created the ticket this session is working — a cross-thread hop,
   *  matched through artifact_origin rather than by thread_key continuation. */
  | 'ticket_created'
  | 'other';

export function recordLink(
  db: Db,
  args: { parent_session_id: number; child_session_id: number; via: AgentChainVia },
): void {
  db.prepare(
    'INSERT INTO agent_chain (parent_session_id, child_session_id, via) VALUES (?, ?, ?)',
  ).run(args.parent_session_id, args.child_session_id, args.via);
}

/**
 * Walk the chain backwards from a session_id, counting agent→agent hops.
 * Returns the chain depth (0 = no parent, just a user-triggered session).
 *
 * Loop-prevention threshold: depth > 5 without human intervention should alert.
 * "Human intervention" detection is left to the caller — this function only
 * counts the chain length.
 */
export function chainDepth(db: Db, session_id: number): number {
  let depth = 0;
  let current: number | null = session_id;
  // Cap at 100 to defend against future cycles in case of data corruption.
  for (let i = 0; i < 100; i++) {
    const row = db
      .prepare('SELECT parent_session_id FROM agent_chain WHERE child_session_id = ? LIMIT 1')
      .get(current) as { parent_session_id: number | null } | undefined;
    if (!row || row.parent_session_id === null) return depth;
    depth += 1;
    current = row.parent_session_id;
  }
  return depth;
}

/** Returns the ordered list of session_ids in the chain from root to leaf. */
export function chainPath(db: Db, leaf_session_id: number): number[] {
  const path: number[] = [leaf_session_id];
  let current: number | null = leaf_session_id;
  for (let i = 0; i < 100; i++) {
    const row = db
      .prepare('SELECT parent_session_id FROM agent_chain WHERE child_session_id = ? LIMIT 1')
      .get(current) as { parent_session_id: number | null } | undefined;
    if (!row || row.parent_session_id === null) break;
    path.unshift(row.parent_session_id);
    current = row.parent_session_id;
  }
  return path;
}
