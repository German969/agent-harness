// End-to-end command tests — build a temp DB, seed rows, run each command
// through its exported entry function, assert on the returned string.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgv } from '../../src/cli/argv.js';
import { agentCmd } from '../../src/cli/commands/agent.js';
import { costCmd } from '../../src/cli/commands/cost.js';
import { scheduleCmd } from '../../src/cli/commands/schedule.js';
import { sessionCmd } from '../../src/cli/commands/session.js';
import { triggerCmd } from '../../src/cli/commands/trigger.js';
import { resetScheduleCache } from '../../src/scheduler/loader.js';
import {
  type Db,
  applyMigrations,
  createSession,
  openDb,
  recordScheduleRun,
  recordTurnCost,
  setOverride,
  updateStatus,
} from '../../src/state/index.js';

let db: Db;
let tmp: string;

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  applyMigrations(db);
  tmp = mkdtempSync(join(tmpdir(), 'cli-test-'));
  resetScheduleCache();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------
describe('session command', () => {
  it('prints session info for a known id', () => {
    const id = createSession(db, {
      agent: 'strategist',
      thread_key: 'issue:42',
      status: 'completed',
      triggered_by: 'webhook:linear',
      trigger_payload: { linear_id: 'ENG-42' },
    });
    updateStatus(db, id, 'completed', {
      ended_at: Date.now(),
      turns: 3,
      cost_usd: 0.15,
      cost_input_tokens: 500,
      cost_output_tokens: 200,
    });
    const out = sessionCmd(db, parseArgv([String(id)]));
    expect(out).toContain(`Session ${id}`);
    expect(out).toContain('agent:              strategist');
    expect(out).toContain('status:             completed');
    expect(out).toContain('turns:              3');
    expect(out).toContain('$0.1500');
    expect(out).toContain('"linear_id": "ENG-42"');
  });

  it('reports "not found" for missing id', () => {
    expect(sessionCmd(db, parseArgv(['9999']))).toBe('session 9999 not found\n');
  });

  it('rejects non-numeric id', () => {
    expect(sessionCmd(db, parseArgv(['abc']))).toContain('must be numeric');
  });

  it('links to schedule_run when session came from cron', () => {
    const id = createSession(db, {
      agent: 'guardian',
      thread_key: 'scheduled:guardian-x',
      status: 'completed',
      triggered_by: 'scheduled',
      trigger_payload: {},
    });
    recordScheduleRun(db, 'guardian-llm-weekly', 'guardian', 'started', id);
    const out = sessionCmd(db, parseArgv([String(id)]));
    expect(out).toContain('schedule_run:');
    expect(out).toContain('cron_id:  guardian-llm-weekly');
  });
});

// ---------------------------------------------------------------------------
// agent
// ---------------------------------------------------------------------------
describe('agent command', () => {
  it('lists sessions for an agent', () => {
    createSession(db, {
      agent: 'strategist',
      thread_key: 't1',
      status: 'completed',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
    });
    createSession(db, {
      agent: 'marketer',
      thread_key: 't2',
      status: 'completed',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
    });
    const out = agentCmd(db, parseArgv(['strategist']));
    // Agent column isn't printed (WHERE already filters); assert via the thread keys.
    expect(out).toContain('t1');
    expect(out).not.toContain('t2'); // marketer's session filtered out
  });

  it('filters by --status', () => {
    createSession(db, {
      agent: 'strategist',
      thread_key: 'live',
      status: 'running',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
    });
    createSession(db, {
      agent: 'strategist',
      thread_key: 'done',
      status: 'completed',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
    });
    const out = agentCmd(db, parseArgv(['strategist', '--status', 'running']));
    expect(out).toContain('live');
    expect(out).not.toContain('done');
  });

  it('filters by --since', () => {
    // Insert a session with started_at 2 hours ago.
    const oldId = createSession(db, {
      agent: 'strategist',
      thread_key: 'old',
      status: 'completed',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
      started_at: Date.now() - 2 * 60 * 60 * 1000,
    });
    void oldId;
    const newId = createSession(db, {
      agent: 'strategist',
      thread_key: 'recent',
      status: 'completed',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
    });
    void newId;
    const out = agentCmd(db, parseArgv(['strategist', '--since', '1h']));
    expect(out).toContain('recent');
    expect(out).not.toContain('old');
  });

  it('reports empty when no matches', () => {
    expect(agentCmd(db, parseArgv(['strategist']))).toContain('no sessions');
  });
});

// ---------------------------------------------------------------------------
// trigger
// ---------------------------------------------------------------------------
describe('trigger command', () => {
  it('groups sessions by thread + shows total cost', () => {
    const s1 = createSession(db, {
      agent: 'strategist',
      thread_key: 'pr:99',
      status: 'completed',
      triggered_by: 'webhook:github',
      trigger_payload: {},
    });
    updateStatus(db, s1, 'completed', { cost_usd: 0.05 });
    const s2 = createSession(db, {
      agent: 'guardian',
      thread_key: 'pr:99',
      status: 'completed',
      triggered_by: 'webhook:github',
      trigger_payload: {},
    });
    updateStatus(db, s2, 'completed', { cost_usd: 0.1 });

    const out = triggerCmd(db, parseArgv(['pr:99']));
    expect(out).toContain('Thread pr:99');
    expect(out).toContain('2 session(s)');
    expect(out).toContain('$0.1500');
    expect(out).toContain('strategist');
    expect(out).toContain('guardian');
  });
});

// ---------------------------------------------------------------------------
// cost
// ---------------------------------------------------------------------------
describe('cost command', () => {
  it('shows per-agent breakdown for the requested month', () => {
    recordTurnCost(db, 'strategist', { cost_usd: 12.5, input_tokens: 1000, output_tokens: 500 });
    recordTurnCost(db, 'marketer', { cost_usd: 4.25, input_tokens: 200, output_tokens: 100 });
    const now = new Date();
    const monthArg = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const out = costCmd(db, parseArgv(['--month', monthArg]));
    expect(out).toContain('Cost breakdown');
    expect(out).toContain('strategist');
    expect(out).toContain('marketer');
    expect(out).toContain('$12.5000');
    expect(out).toContain('$4.2500');
    expect(out).toMatch(/Month total: \$16\.7500/);
  });

  it('errors on missing --month', () => {
    expect(costCmd(db, parseArgv([]))).toContain('usage: cost');
  });

  it('errors on bad --month format', () => {
    expect(costCmd(db, parseArgv(['--month', 'nope']))).toContain('invalid month');
  });
});

// ---------------------------------------------------------------------------
// schedule
// ---------------------------------------------------------------------------
describe('schedule command', () => {
  function writeSchedules(): string {
    const path = join(tmp, 'schedules.yml');
    writeFileSync(
      path,
      `- id: strategist-daily
  cron: "0 9 * * *"
  agent: strategist
  trigger:
    kind: scheduled
    message: standup
  enabled: false
- id: marketer-weekly
  cron: "0 10 * * MON"
  agent: marketer
  trigger:
    kind: scheduled
    message: growth digest
  enabled: true
`,
      'utf-8',
    );
    return path;
  }

  it('list — shows every entry + effective state', async () => {
    const p = writeSchedules();
    const out = await scheduleCmd(parseArgv(['list']), {
      db,
      schedulesPath: p,
      actor: 'test',
    });
    expect(out).toContain('strategist-daily');
    expect(out).toContain('marketer-weekly');
    expect(out).toContain('disabled'); // strategist-daily
    expect(out).toContain('enabled'); // marketer-weekly
  });

  it('list --agent filters', async () => {
    const p = writeSchedules();
    const out = await scheduleCmd(parseArgv(['list', '--agent', 'marketer']), {
      db,
      schedulesPath: p,
      actor: 'test',
    });
    expect(out).toContain('marketer-weekly');
    expect(out).not.toContain('strategist-daily');
  });

  it('list --disabled filters to disabled entries', async () => {
    const p = writeSchedules();
    const out = await scheduleCmd(parseArgv(['list', '--disabled']), {
      db,
      schedulesPath: p,
      actor: 'test',
    });
    expect(out).toContain('strategist-daily');
    expect(out).not.toContain('marketer-weekly');
  });

  it('enable writes an override + reports effective state', async () => {
    const p = writeSchedules();
    const out = await scheduleCmd(
      parseArgv(['enable', 'strategist-daily', '--reason', 'phase 2 online']),
      { db, schedulesPath: p, actor: 'admin' },
    );
    expect(out).toContain('enabled strategist-daily');
    expect(out).toContain('effective: enabled');
    // Follow-up list should now show enabled.
    const list = await scheduleCmd(parseArgv(['list', '--agent', 'strategist']), {
      db,
      schedulesPath: p,
      actor: 'admin',
    });
    expect(list).toMatch(/strategist-daily.*enabled\s+override/);
  });

  it('disable then reset restores YAML default', async () => {
    const p = writeSchedules();
    await scheduleCmd(parseArgv(['disable', 'marketer-weekly']), {
      db,
      schedulesPath: p,
      actor: 'admin',
    });
    // Verify override took effect.
    let list = await scheduleCmd(parseArgv(['list', '--agent', 'marketer']), {
      db,
      schedulesPath: p,
      actor: 'admin',
    });
    expect(list).toMatch(/marketer-weekly.*disabled\s+override/);
    // Reset.
    const resetOut = await scheduleCmd(parseArgv(['reset', 'marketer-weekly']), {
      db,
      schedulesPath: p,
      actor: 'admin',
    });
    expect(resetOut).toContain('reset marketer-weekly');
    list = await scheduleCmd(parseArgv(['list', '--agent', 'marketer']), {
      db,
      schedulesPath: p,
      actor: 'admin',
    });
    expect(list).toMatch(/marketer-weekly.*enabled\s+yaml/);
  });

  it('history shows the audit trail', async () => {
    const p = writeSchedules();
    setOverride(db, {
      cron_id: 'strategist-daily',
      enabled: true,
      set_by: 'admin',
      reason: 'phase 2',
    });
    const out = await scheduleCmd(parseArgv(['history', 'strategist-daily']), {
      db,
      schedulesPath: p,
      actor: 'admin',
    });
    expect(out).toContain('enable');
    expect(out).toContain('admin');
    expect(out).toContain('phase 2');
  });

  it('unknown id → error message', async () => {
    const p = writeSchedules();
    const out = await scheduleCmd(parseArgv(['enable', 'not-a-real-id']), {
      db,
      schedulesPath: p,
      actor: 'admin',
    });
    expect(out).toContain('unknown schedule id');
  });

  it('run → fires once + returns outcome', async () => {
    const p = writeSchedules();
    const out = await scheduleCmd(parseArgv(['run', 'marketer-weekly']), {
      db,
      schedulesPath: p,
      actor: 'admin',
    });
    expect(out).toContain('fireOnce marketer-weekly');
    expect(out).toContain('started');
  });
});
