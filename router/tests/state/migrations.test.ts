import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, loadMigrations, openDb, resetDbForTests } from '../../src/state/index.js';

describe('migrations', () => {
  afterEach(() => resetDbForTests());

  it('loads at least the 000-init migration', () => {
    const migrations = loadMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0]?.version).toBe(0);
    expect(migrations[0]?.name).toBe('init');
    expect(migrations[0]?.sql).toContain('CREATE TABLE sessions');
  });

  it('applies all migrations on a fresh DB', () => {
    const db = openDb({ path: ':memory:' });
    const { applied, skipped } = applyMigrations(db);
    expect(applied).toContain(0);
    expect(skipped).toEqual([]);
  });

  it('creates all expected tables', () => {
    const db = openDb({ path: ':memory:' });
    applyMigrations(db);
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toEqual(
      [
        'agent_chain',
        'artifact_origin',
        'cost_alerts_emitted',
        'cost_ledger',
        'linear_oauth',
        'pending_sessions',
        'pr_owner',
        'schedule_override_history',
        'schedule_overrides',
        'schedule_runs',
        'schema_version',
        'sessions',
        'webhook_deliveries',
        'worktrees',
      ].sort(),
    );
  });

  it('is idempotent — re-applying skips already-applied versions', () => {
    const db = openDb({ path: ':memory:' });
    applyMigrations(db);
    const second = applyMigrations(db);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain(0);
  });

  // 005 rebuilds webhook_deliveries to re-key it on (delivery_id, agent). The live DB
  // already holds rows, so exercise the SQL against a populated pre-005 table rather
  // than only the fresh-DB path.
  it('005 re-keys webhook_deliveries on (delivery_id, agent), preserving rows', () => {
    const db = openDb({ path: ':memory:' });
    db.exec(`
      CREATE TABLE webhook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        agent TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        outcome TEXT
      );
      CREATE INDEX idx_webhook_deliveries_received ON webhook_deliveries(received_at);
      INSERT INTO webhook_deliveries VALUES
        ('pre-005', 'github', 'strategist', 1, 'issue_comment.created', 'enqueued');
    `);

    const m = loadMigrations().find((x) => x.version === 5);
    expect(m?.name).toBe('webhook-dedup-per-agent');
    db.exec(m?.sql ?? '');

    const rows = db.prepare('SELECT delivery_id, agent, outcome FROM webhook_deliveries').all();
    expect(rows).toEqual([{ delivery_id: 'pre-005', agent: 'strategist', outcome: 'enqueued' }]);

    // Same GUID, different agent → allowed. Same GUID, same agent → rejected.
    const insert = (agent: string) =>
      db
        .prepare('INSERT INTO webhook_deliveries VALUES (?, ?, ?, ?, ?, ?)')
        .run('pre-005', 'github', agent, 2, 'issue_comment.created', 'enqueued');
    expect(() => insert('builder-server')).not.toThrow();
    expect(() => insert('strategist')).toThrow();

    // The retention index survives the table rebuild.
    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='webhook_deliveries'",
      )
      .all() as { name: string }[];
    expect(idx.map((r) => r.name)).toContain('idx_webhook_deliveries_received');
  });

  it('records the version in schema_version', () => {
    const db = openDb({ path: ':memory:' });
    applyMigrations(db);
    const rows = db.prepare('SELECT version FROM schema_version').all() as { version: number }[];
    expect(rows.map((r) => r.version)).toContain(0);
  });
});
