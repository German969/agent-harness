import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Db,
  applyMigrations,
  clearOverride,
  createSession,
  getOverride,
  hasActiveRunFor,
  lastRunForCron,
  listOverrides,
  listScheduleOverrideHistory,
  openDb,
  recordScheduleRun,
  setOverride,
} from '../../src/state/index.js';

describe('schedule_runs', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb({ path: ':memory:' });
    applyMigrations(db);
  });

  it('recordRun + lastRunForCron', () => {
    recordScheduleRun(db, 'guardian-weekly', 'guardian', 'started');
    recordScheduleRun(db, 'guardian-weekly', 'guardian', 'started');
    recordScheduleRun(db, 'marketer-weekly', 'marketer', 'started');
    const last = lastRunForCron(db, 'guardian-weekly');
    expect(last?.cron_id).toBe('guardian-weekly');
    expect(last?.outcome).toBe('started');
  });

  it('hasActiveRunFor detects a still-running session', () => {
    const sessionId = createSession(db, {
      agent: 'guardian',
      thread_key: 'scheduled:guardian-weekly',
      status: 'running',
      triggered_by: 'scheduled',
      trigger_payload: {},
    });
    recordScheduleRun(db, 'guardian-weekly', 'guardian', 'started', sessionId);
    expect(hasActiveRunFor(db, 'guardian-weekly')).toBe(true);
  });

  it('hasActiveRunFor is false when the run has completed', () => {
    const sessionId = createSession(db, {
      agent: 'guardian',
      thread_key: 'scheduled:guardian-weekly',
      status: 'completed',
      triggered_by: 'scheduled',
      trigger_payload: {},
    });
    recordScheduleRun(db, 'guardian-weekly', 'guardian', 'started', sessionId);
    expect(hasActiveRunFor(db, 'guardian-weekly')).toBe(false);
  });
});

describe('schedule_overrides', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb({ path: ':memory:' });
    applyMigrations(db);
  });

  it('setOverride writes both override + history', () => {
    setOverride(db, {
      cron_id: 'guardian-weekly',
      enabled: true,
      set_by: 'slack:@german',
      reason: 'Phase 5 verified',
    });
    const o = getOverride(db, 'guardian-weekly');
    expect(o?.enabled).toBe(1);
    expect(o?.set_by).toBe('slack:@german');
    expect(o?.reason).toBe('Phase 5 verified');

    const history = listScheduleOverrideHistory(db, 'guardian-weekly');
    expect(history).toHaveLength(1);
    expect(history[0]?.enabled).toBe(1);
  });

  it('setOverride upserts (existing row updated)', () => {
    setOverride(db, { cron_id: 'x', enabled: true, set_by: 'a' });
    setOverride(db, { cron_id: 'x', enabled: false, set_by: 'b' });
    const o = getOverride(db, 'x');
    expect(o?.enabled).toBe(0);
    expect(o?.set_by).toBe('b');
    // History has 2 entries
    expect(listScheduleOverrideHistory(db, 'x')).toHaveLength(2);
  });

  it('clearOverride removes the row but keeps history', () => {
    setOverride(db, { cron_id: 'y', enabled: true, set_by: 'a' });
    clearOverride(db, 'y', 'slack:@admin', 'no longer needed');
    expect(getOverride(db, 'y')).toBeUndefined();
    const hist = listScheduleOverrideHistory(db, 'y');
    expect(hist).toHaveLength(2);
    expect(hist[0]?.enabled).toBe(-1); // sentinel for reset
    expect(hist[0]?.reason).toBe('no longer needed');
  });

  it('listOverrides returns all current overrides', () => {
    setOverride(db, { cron_id: 'a', enabled: true, set_by: 's' });
    setOverride(db, { cron_id: 'b', enabled: false, set_by: 's' });
    setOverride(db, { cron_id: 'c', enabled: true, set_by: 's' });
    expect(listOverrides(db)).toHaveLength(3);
  });

  it('history is ordered most-recent-first', () => {
    setOverride(db, { cron_id: 'h', enabled: true, set_by: 'first' });
    setOverride(db, { cron_id: 'h', enabled: false, set_by: 'second' });
    const hist = listScheduleOverrideHistory(db, 'h');
    expect(hist[0]?.set_by).toBe('second');
    expect(hist[1]?.set_by).toBe('first');
  });
});
