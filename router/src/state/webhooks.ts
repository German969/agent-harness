// webhook_deliveries idempotency table.
// Per router/ARCHITECTURE.md §2.1 (webhook ingress dedup).
// Retention: 30 days. Older rows pruned by a daily job.

import type { AgentId, Provider } from '../types.js';
import type { Db } from './db.js';

export type WebhookOutcome = 'enqueued' | 'duplicate' | 'invalid' | 'gated';

/**
 * Attempt to register a webhook delivery for processing.
 * Returns true if this is a new delivery (proceed), false if duplicate (return 200).
 *
 * Idempotency is per (delivery_id, agent), not per delivery_id — GitHub fans one repo
 * event out to every installed App under a single shared X-GitHub-Delivery GUID, and
 * each copy has to reach the classifier for its single-owner gate to pick the right
 * one (see migration 005). `agent` is the agent whose App received THIS copy.
 */
export function tryRegisterDelivery(
  db: Db,
  args: {
    delivery_id: string;
    provider: Provider;
    agent: AgentId;
    event_type: string;
    received_at?: number;
    outcome?: WebhookOutcome;
  },
): boolean {
  // ON CONFLICT DO NOTHING rather than catching a constraint error: SQLite reports a
  // composite-PK collision on a rowid table as SQLITE_CONSTRAINT_UNIQUE, not
  // _PRIMARYKEY, so matching on the error code would be silently wrong here.
  const result = db
    .prepare(
      `INSERT INTO webhook_deliveries
         (delivery_id, provider, agent, received_at, event_type, outcome)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (delivery_id, agent) DO NOTHING`,
    )
    .run(
      args.delivery_id,
      args.provider,
      args.agent,
      args.received_at ?? Date.now(),
      args.event_type,
      args.outcome ?? 'enqueued',
    );

  return result.changes > 0;
}

/** Update the outcome field after processing (e.g. 'gated' if founding-docs missing).
 *  Scoped by agent so it touches only the copy that agent received. */
export function setOutcome(
  db: Db,
  delivery_id: string,
  agent: AgentId,
  outcome: WebhookOutcome,
): void {
  db.prepare('UPDATE webhook_deliveries SET outcome = ? WHERE delivery_id = ? AND agent = ?').run(
    outcome,
    delivery_id,
    agent,
  );
}

/** Prune deliveries older than retentionMs. Returns the number of rows deleted. */
export function pruneOldDeliveries(db: Db, retentionMs: number): number {
  const cutoff = Date.now() - retentionMs;
  const result = db.prepare('DELETE FROM webhook_deliveries WHERE received_at < ?').run(cutoff);
  return result.changes;
}
