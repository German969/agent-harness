// artifact_origin — which session created a work artifact.
//
// The cross-thread half of the loop guard. `findContinuation` matches on
// thread_key, so it only ever finds a parent inside one thread; a ticket an agent
// creates is a NEW thread and starts at depth zero. Recording the creating
// session lets the first session on that ticket link back, so a chain built out
// of agent-created tickets is counted like any other.

import type { Db } from './db.js';

export type ArtifactOrigin = {
  thread_key: string;
  session_id: number;
  created_at: number;
};

/**
 * Record that `session_id` created the artifact events will address as
 * `thread_key`.
 *
 * INSERT OR IGNORE: the first writer wins. An agent that touches the same ticket
 * twice must not re-parent it onto its later session — that would rewrite history
 * and could point a chain at itself.
 */
export function recordArtifactOrigin(
  db: Db,
  args: { thread_key: string; session_id: number; now?: number },
): void {
  db.prepare(
    'INSERT OR IGNORE INTO artifact_origin (thread_key, session_id, created_at) VALUES (?, ?, ?)',
  ).run(args.thread_key, args.session_id, args.now ?? Date.now());
}

/** The session that created this artifact, if one did. */
export function findArtifactOrigin(db: Db, threadKey: string): ArtifactOrigin | undefined {
  const row = db
    .prepare('SELECT thread_key, session_id, created_at FROM artifact_origin WHERE thread_key = ?')
    .get(threadKey) as ArtifactOrigin | undefined;
  return row;
}
