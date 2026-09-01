import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Db,
  applyMigrations,
  openDb,
  pruneOldDeliveries,
  setWebhookOutcome,
  tryRegisterDelivery,
} from '../../src/state/index.js';

describe('webhook_deliveries', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb({ path: ':memory:' });
    applyMigrations(db);
  });

  it('first delivery is registered (returns true)', () => {
    const ok = tryRegisterDelivery(db, {
      delivery_id: 'gh-001',
      provider: 'github',
      agent: 'guardian',
      event_type: 'pull_request.opened',
    });
    expect(ok).toBe(true);
  });

  it('redelivery of the same (delivery_id, agent) returns false', () => {
    const args = {
      delivery_id: 'gh-002',
      provider: 'github' as const,
      agent: 'guardian' as const,
      event_type: 'pull_request.opened',
    };
    expect(tryRegisterDelivery(db, args)).toBe(true);
    expect(tryRegisterDelivery(db, args)).toBe(false);
  });

  // GitHub reuses one X-GitHub-Delivery GUID for every installed App's copy of an
  // event. Each copy must register so the classifier's single-owner gate can see it;
  // deduping on delivery_id alone dropped every copy but the first to arrive.
  it('same delivery_id registers once per agent', () => {
    const copy = (agent: 'strategist' | 'builder-server' | 'guardian') => ({
      delivery_id: 'gh-fanout',
      provider: 'github' as const,
      agent,
      event_type: 'issue_comment.created',
    });

    expect(tryRegisterDelivery(db, copy('strategist'))).toBe(true);
    expect(tryRegisterDelivery(db, copy('builder-server'))).toBe(true);
    expect(tryRegisterDelivery(db, copy('guardian'))).toBe(true);

    // ...but a second copy for an agent that already saw it is still a duplicate.
    expect(tryRegisterDelivery(db, copy('builder-server'))).toBe(false);
  });

  it('setOutcome updates the outcome field', () => {
    tryRegisterDelivery(db, {
      delivery_id: 'gh-003',
      provider: 'github',
      agent: 'guardian',
      event_type: 'pull_request.opened',
    });
    setWebhookOutcome(db, 'gh-003', 'guardian', 'gated');
    const row = db
      .prepare('SELECT outcome FROM webhook_deliveries WHERE delivery_id = ?')
      .get('gh-003') as { outcome: string };
    expect(row.outcome).toBe('gated');
  });

  it("setOutcome touches only the given agent's copy", () => {
    for (const agent of ['strategist', 'builder-server'] as const) {
      tryRegisterDelivery(db, {
        delivery_id: 'gh-004',
        provider: 'github',
        agent,
        event_type: 'issue_comment.created',
      });
    }

    setWebhookOutcome(db, 'gh-004', 'builder-server', 'gated');

    const rows = db
      .prepare('SELECT agent, outcome FROM webhook_deliveries WHERE delivery_id = ? ORDER BY agent')
      .all('gh-004') as { agent: string; outcome: string }[];
    expect(rows).toEqual([
      { agent: 'builder-server', outcome: 'gated' },
      { agent: 'strategist', outcome: 'enqueued' },
    ]);
  });

  it('pruneOldDeliveries removes only rows older than retentionMs', () => {
    const now = Date.now();
    tryRegisterDelivery(db, {
      delivery_id: 'old',
      provider: 'github',
      agent: 'guardian',
      event_type: 'x',
      received_at: now - 40 * 24 * 60 * 60 * 1000, // 40d old
    });
    tryRegisterDelivery(db, {
      delivery_id: 'recent',
      provider: 'github',
      agent: 'guardian',
      event_type: 'x',
      received_at: now - 5 * 24 * 60 * 60 * 1000, // 5d old
    });

    const deleted = pruneOldDeliveries(db, 30 * 24 * 60 * 60 * 1000);
    expect(deleted).toBe(1);
    const remaining = db.prepare('SELECT delivery_id FROM webhook_deliveries').all() as {
      delivery_id: string;
    }[];
    expect(remaining.map((r) => r.delivery_id)).toEqual(['recent']);
  });
});
