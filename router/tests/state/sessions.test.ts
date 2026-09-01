import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Db,
  addTurnCost,
  applyMigrations,
  createSession,
  findContinuation,
  findRootSessionId,
  getSession,
  listRunning,
  markRunningAsInterruptedOnBoot,
  openDb,
  updateStatus,
} from '../../src/state/index.js';

describe('sessions', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb({ path: ':memory:' });
    applyMigrations(db);
  });

  it('creates + retrieves a session', () => {
    const id = createSession(db, {
      agent: 'strategist',
      skill: 'pm',
      thread_key: 'slack:C123/T456',
      status: 'pending',
      triggered_by: 'webhook:slack',
      trigger_payload: { foo: 'bar' },
    });
    const row = getSession(db, id);
    expect(row).toBeDefined();
    expect(row?.agent).toBe('strategist');
    expect(row?.thread_key).toBe('slack:C123/T456');
    expect(row?.status).toBe('pending');
    expect(row?.trigger_payload).toBe('{"foo":"bar"}');
  });

  it('updates status + additional fields', () => {
    const id = createSession(db, {
      agent: 'guardian',
      thread_key: 'github:org/repo/pr/1',
      status: 'pending',
      triggered_by: 'webhook:github',
      trigger_payload: {},
    });
    updateStatus(db, id, 'completed', {
      ended_at: 1000,
      turns: 3,
      cost_usd: 0.5,
      claude_session_id: 'msg_abc',
    });
    const row = getSession(db, id);
    expect(row?.status).toBe('completed');
    expect(row?.ended_at).toBe(1000);
    expect(row?.turns).toBe(3);
    expect(row?.cost_usd).toBe(0.5);
    expect(row?.claude_session_id).toBe('msg_abc');
  });

  it('addTurnCost accumulates', () => {
    const id = createSession(db, {
      agent: 'builder-server',
      thread_key: 'linear:ENG-1',
      status: 'running',
      triggered_by: 'webhook:linear',
      trigger_payload: {},
    });
    addTurnCost(db, id, { cost_usd: 0.1, input_tokens: 100, output_tokens: 50 });
    addTurnCost(db, id, { cost_usd: 0.2, input_tokens: 200, output_tokens: 75 });
    const row = getSession(db, id);
    expect(row?.turns).toBe(2);
    expect(row?.cost_usd).toBeCloseTo(0.3);
    expect(row?.cost_input_tokens).toBe(300);
    expect(row?.cost_output_tokens).toBe(125);
  });

  it('addTurnCost persists cache_write + cache_read tokens', () => {
    const id = createSession(db, {
      agent: 'strategist',
      thread_key: 'slack:C/T',
      status: 'running',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
    });
    addTurnCost(db, id, {
      cost_usd: 2.37,
      input_tokens: 7762,
      cache_write_tokens: 100_000,
      cache_read_tokens: 6_400_000,
      output_tokens: 103,
    });
    const row = getSession(db, id);
    expect(row?.cost_usd).toBeCloseTo(2.37);
    expect(row?.cost_input_tokens).toBe(7762);
    expect(row?.cost_cache_write_tokens).toBe(100_000);
    expect(row?.cost_cache_read_tokens).toBe(6_400_000);
    expect(row?.cost_output_tokens).toBe(103);
  });

  describe('findContinuation', () => {
    it('returns undefined when no prior session exists', () => {
      expect(findContinuation(db, 'slack:X/Y', 30 * 24 * 60 * 60 * 1000)).toBeUndefined();
    });

    it('returns the most-recent completed session within the window', () => {
      const old = createSession(db, {
        agent: 'strategist',
        thread_key: 'slack:X/Y',
        status: 'pending',
        triggered_by: 'webhook:slack',
        trigger_payload: {},
      });
      const recent = createSession(db, {
        agent: 'strategist',
        thread_key: 'slack:X/Y',
        status: 'pending',
        triggered_by: 'webhook:slack',
        trigger_payload: {},
      });
      const now = Date.now();
      updateStatus(db, old, 'completed', { ended_at: now - 60_000 });
      updateStatus(db, recent, 'completed', { ended_at: now - 1_000 });

      const found = findContinuation(db, 'slack:X/Y', 5 * 60 * 1000);
      expect(found?.id).toBe(recent);
    });

    it('excludes sessions outside the window', () => {
      const id = createSession(db, {
        agent: 'strategist',
        thread_key: 'slack:X/Z',
        status: 'pending',
        triggered_by: 'webhook:slack',
        trigger_payload: {},
      });
      updateStatus(db, id, 'completed', { ended_at: Date.now() - 60 * 60 * 1000 });
      const found = findContinuation(db, 'slack:X/Z', 60 * 1000);
      expect(found).toBeUndefined();
    });

    it("excludes 'interrupted_needs_resume' sessions (SDK resume from these states fails)", () => {
      const id = createSession(db, {
        agent: 'strategist',
        thread_key: 'slack:X/A',
        status: 'pending',
        triggered_by: 'webhook:slack',
        trigger_payload: {},
      });
      updateStatus(db, id, 'interrupted_needs_resume', { ended_at: Date.now() - 1000 });
      const found = findContinuation(db, 'slack:X/A', 60 * 1000);
      expect(found).toBeUndefined();
    });
  });

  it('listRunning returns only running sessions for the agent', () => {
    createSession(db, {
      agent: 'guardian',
      thread_key: 't1',
      status: 'running',
      triggered_by: 'webhook:github',
      trigger_payload: {},
    });
    createSession(db, {
      agent: 'guardian',
      thread_key: 't2',
      status: 'completed',
      triggered_by: 'webhook:github',
      trigger_payload: {},
    });
    createSession(db, {
      agent: 'strategist',
      thread_key: 't3',
      status: 'running',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
    });
    expect(listRunning(db, 'guardian')).toHaveLength(1);
    expect(listRunning(db, 'strategist')).toHaveLength(1);
    expect(listRunning(db, 'platform')).toHaveLength(0);
  });

  it('markRunningAsInterruptedOnBoot flips all running sessions', () => {
    createSession(db, {
      agent: 'guardian',
      thread_key: 't1',
      status: 'running',
      triggered_by: 'webhook:github',
      trigger_payload: {},
    });
    createSession(db, {
      agent: 'guardian',
      thread_key: 't2',
      status: 'running',
      triggered_by: 'webhook:github',
      trigger_payload: {},
    });
    const count = markRunningAsInterruptedOnBoot(db);
    expect(count).toBe(2);
    expect(listRunning(db, 'guardian')).toHaveLength(0);
  });

  it('findRootSessionId walks a continuation chain back to the root', () => {
    const root = createSession(db, {
      agent: 'strategist',
      thread_key: 'slack:C/x',
      status: 'completed',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
    });
    const mid = createSession(db, {
      agent: 'strategist',
      thread_key: 'slack:C/x',
      status: 'completed',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
      triggered_by_session_id: root,
    });
    const leaf = createSession(db, {
      agent: 'strategist',
      thread_key: 'slack:C/x',
      status: 'running',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
      triggered_by_session_id: mid,
    });
    expect(findRootSessionId(db, root)).toBe(root);
    expect(findRootSessionId(db, mid)).toBe(root);
    expect(findRootSessionId(db, leaf)).toBe(root);
  });
});
