import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Db,
  applyMigrations,
  chainDepth,
  chainPath,
  createSession,
  openDb,
  recordLink,
} from '../../src/state/index.js';

describe('agent_chain', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb({ path: ':memory:' });
    applyMigrations(db);
  });

  function mkSession(): number {
    return createSession(db, {
      agent: 'strategist',
      thread_key: `t-${Math.random()}`,
      status: 'pending',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
    });
  }

  it('chainDepth = 0 for unlinked session', () => {
    const id = mkSession();
    expect(chainDepth(db, id)).toBe(0);
  });

  it('chainDepth counts linked hops', () => {
    const root = mkSession();
    const a = mkSession();
    const b = mkSession();
    const c = mkSession();
    recordLink(db, { parent_session_id: root, child_session_id: a, via: 'linear_assign' });
    recordLink(db, { parent_session_id: a, child_session_id: b, via: 'linear_assign' });
    recordLink(db, { parent_session_id: b, child_session_id: c, via: 'pr_review' });
    expect(chainDepth(db, c)).toBe(3);
    expect(chainDepth(db, b)).toBe(2);
    expect(chainDepth(db, a)).toBe(1);
    expect(chainDepth(db, root)).toBe(0);
  });

  it('chainPath returns root-to-leaf order', () => {
    const root = mkSession();
    const a = mkSession();
    const b = mkSession();
    recordLink(db, { parent_session_id: root, child_session_id: a, via: 'linear_assign' });
    recordLink(db, { parent_session_id: a, child_session_id: b, via: 'pr_review' });
    expect(chainPath(db, b)).toEqual([root, a, b]);
  });
});
