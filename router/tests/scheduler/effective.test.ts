import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveEffective } from '../../src/scheduler/effective.js';
import { resetProjectPhaseCache } from '../../src/scheduler/projectPhase.js';
import type { ScheduleEntry } from '../../src/scheduler/schema.js';
import { type Db, applyMigrations, openDb, setOverride } from '../../src/state/index.js';

function mkEntry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    id: 'test-1',
    cron: '0 9 * * *',
    timezone: 'UTC',
    agent: 'strategist',
    trigger: { kind: 'scheduled', message: 'hi' },
    enabled: false,
    ...overrides,
  };
}

let db: Db;
let tmp: string;
beforeEach(() => {
  db = openDb({ path: ':memory:' });
  applyMigrations(db);
  tmp = mkdtempSync(join(tmpdir(), 'sched-effective-'));
  resetProjectPhaseCache();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolveEffective', () => {
  it('YAML enabled: false + no override → disabled', () => {
    const e = mkEntry({ enabled: false });
    const r = resolveEffective(e, { db });
    expect(r.state).toBe('disabled');
    expect(r.source).toBe('yaml');
  });

  it('YAML enabled: true + no phase gate → enabled', () => {
    const e = mkEntry({ enabled: true });
    const r = resolveEffective(e, { db });
    expect(r.state).toBe('enabled');
    expect(r.source).toBe('yaml');
  });

  it('runtime override enable > YAML disable', () => {
    const e = mkEntry({ enabled: false });
    setOverride(db, { cron_id: e.id, enabled: true, set_by: 'admin', reason: 'manual test' });
    const r = resolveEffective(e, { db });
    expect(r.state).toBe('enabled');
    expect(r.source).toBe('override');
    expect(r.overrideReason).toBe('manual test');
  });

  it('runtime override disable > YAML enable', () => {
    const e = mkEntry({ enabled: true });
    setOverride(db, { cron_id: e.id, enabled: false, set_by: 'admin' });
    const r = resolveEffective(e, { db });
    expect(r.state).toBe('disabled');
    expect(r.source).toBe('override');
  });

  it('phase-gated when required phase > current phase', () => {
    const e = mkEntry({ enabled: true, requires_project_phase: 'phase-3' });
    writeFileSync(join(tmp, '.dev-team.yml'), 'project:\n  phase: phase-1\n', 'utf-8');
    const r = resolveEffective(e, { db, targetProjectRoot: tmp });
    expect(r.state).toBe('phase_gated');
    expect(r.reason).toContain('phase-1');
    expect(r.reason).toContain('phase-3');
  });

  it('enabled once required phase is met', () => {
    const e = mkEntry({ enabled: true, requires_project_phase: 'phase-2' });
    writeFileSync(join(tmp, '.dev-team.yml'), 'project:\n  phase: phase-2\n', 'utf-8');
    const r = resolveEffective(e, { db, targetProjectRoot: tmp });
    expect(r.state).toBe('enabled');
  });

  it('missing .dev-team.yml defaults to phase-0 (blocks anything above phase-0)', () => {
    mkdirSync(tmp, { recursive: true });
    const e = mkEntry({ enabled: true, requires_project_phase: 'phase-1' });
    const r = resolveEffective(e, { db, targetProjectRoot: tmp });
    expect(r.state).toBe('phase_gated');
  });

  it('no phase gate → enabled even without a .dev-team.yml', () => {
    const e = mkEntry({ enabled: true }); // no requires_project_phase
    const r = resolveEffective(e, { db, targetProjectRoot: '/nonexistent' });
    expect(r.state).toBe('enabled');
  });
});
