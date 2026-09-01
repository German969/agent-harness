// Runner tests — use `fireOnce` (bypasses cron) to test tick behavior deterministically.

import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ScheduledTrigger, fireOnce } from '../../src/scheduler/runner.js';
import type { ScheduleEntry } from '../../src/scheduler/schema.js';
import {
  type Db,
  applyMigrations,
  createSession,
  openDb,
  recordScheduleRun,
  setOverride,
} from '../../src/state/index.js';

const log = pino({ level: 'silent' });

function mkEntry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    id: 'test-run',
    cron: '0 9 * * *',
    timezone: 'UTC',
    agent: 'strategist',
    trigger: { kind: 'scheduled', message: 'hello' },
    enabled: true,
    ...overrides,
  };
}

let db: Db;
beforeEach(() => {
  db = openDb({ path: ':memory:' });
  applyMigrations(db);
});
afterEach(() => db.close());

describe('fireOnce', () => {
  it('fires onTick when effective state is enabled', async () => {
    const entry = mkEntry();
    const onTick = vi.fn(async () => {
      /* noop */
    });
    const outcome = await fireOnce(entry, { db, log, onTick });
    expect(outcome).toBe('started');
    expect(onTick).toHaveBeenCalledTimes(1);
    const [trigger] = onTick.mock.calls[0] as [ScheduledTrigger];
    expect(trigger.cron_id).toBe('test-run');
    expect(trigger.agent).toBe('strategist');
    expect(trigger.message).toBe('hello');
  });

  it('skips when disabled', async () => {
    const entry = mkEntry({ enabled: false });
    const onTick = vi.fn();
    const outcome = await fireOnce(entry, { db, log, onTick });
    expect(outcome).toBe('skipped_disabled');
    expect(onTick).not.toHaveBeenCalled();
  });

  it('skips when phase-gated', async () => {
    const entry = mkEntry({ requires_project_phase: 'phase-3' });
    // No .dev-team.yml → defaults to phase-0 → blocks phase-3.
    const onTick = vi.fn();
    const outcome = await fireOnce(entry, {
      db,
      log,
      onTick,
      targetProjectRoot: '/nonexistent-for-phase',
    });
    expect(outcome).toBe('skipped_phase_gate');
    expect(onTick).not.toHaveBeenCalled();
  });

  it('skips overlap when the last run is still active', async () => {
    const entry = mkEntry();
    // Simulate a prior run whose session is still running.
    const sessionId = createSession(db, {
      agent: 'strategist',
      thread_key: 'x',
      status: 'running',
      triggered_by: 'scheduled',
      trigger_payload: {},
    });
    recordScheduleRun(db, entry.id, 'strategist', 'started', sessionId);

    const onTick = vi.fn();
    const outcome = await fireOnce(entry, { db, log, onTick });
    expect(outcome).toBe('skipped_overlap');
    expect(onTick).not.toHaveBeenCalled();
  });

  it('records failed_to_start when onTick throws', async () => {
    const entry = mkEntry();
    const onTick = vi.fn(async () => {
      throw new Error('boom');
    });
    const outcome = await fireOnce(entry, { db, log, onTick });
    expect(outcome).toBe('failed_to_start');
  });

  it('override flip enables a disabled YAML entry', async () => {
    const entry = mkEntry({ enabled: false });
    setOverride(db, { cron_id: entry.id, enabled: true, set_by: 'admin' });
    const onTick = vi.fn(async () => {});
    const outcome = await fireOnce(entry, { db, log, onTick });
    expect(outcome).toBe('started');
    expect(onTick).toHaveBeenCalled();
  });
});
