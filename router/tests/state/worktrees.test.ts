import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Db,
  acquireLease,
  applyMigrations,
  createSession,
  findWorktreeByTask,
  listIdleWorktrees,
  listOldestIdle,
  openDb,
  registerWorktree,
  releaseLease,
  removeWorktree,
} from '../../src/state/index.js';

describe('worktrees', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb({ path: ':memory:' });
    applyMigrations(db);
  });

  // Helper: real sessions are needed because worktrees.active_session_id has a FK.
  function mkSession(): number {
    return createSession(db, {
      agent: 'builder-server',
      thread_key: `t-${Math.random()}`,
      status: 'running',
      triggered_by: 'webhook:linear',
      trigger_payload: {},
    });
  }

  it('registerWorktree + findByTask', () => {
    registerWorktree(db, {
      path: '/wt/builder-server/eng-1',
      agent: 'builder-server',
      task_id: 'eng-1',
      branch: 'agent/builder-server/eng-1',
    });
    const row = findWorktreeByTask(db, 'builder-server', 'eng-1');
    expect(row?.path).toBe('/wt/builder-server/eng-1');
    expect(row?.active_session_id).toBeNull();
  });

  it('acquireLease returns true on idle worktree; false when busy', () => {
    registerWorktree(db, {
      path: '/wt/x',
      agent: 'builder-server',
      task_id: 'eng-2',
      branch: 'agent/builder-server/eng-2',
    });
    const s1 = mkSession();
    const s2 = mkSession();
    expect(acquireLease(db, '/wt/x', s1)).toBe(true);
    // Second attempt: busy
    expect(acquireLease(db, '/wt/x', s2)).toBe(false);
    const row = findWorktreeByTask(db, 'builder-server', 'eng-2');
    expect(row?.active_session_id).toBe(s1);
  });

  it('releaseLease frees the worktree', () => {
    registerWorktree(db, {
      path: '/wt/y',
      agent: 'builder-client',
      task_id: 'eng-3',
      branch: 'agent/builder-client/eng-3',
    });
    const s1 = mkSession();
    const s2 = mkSession();
    acquireLease(db, '/wt/y', s1);
    releaseLease(db, '/wt/y');
    const row = findWorktreeByTask(db, 'builder-client', 'eng-3');
    expect(row?.active_session_id).toBeNull();
    expect(acquireLease(db, '/wt/y', s2)).toBe(true);
  });

  it('listIdleWorktrees returns only stale, lease-free worktrees', () => {
    // Manually insert worktrees with controlled timestamps.
    registerWorktree(db, {
      path: '/wt/recent',
      agent: 'guardian',
      task_id: 't1',
      branch: 'b1',
    });
    registerWorktree(db, {
      path: '/wt/stale',
      agent: 'guardian',
      task_id: 't2',
      branch: 'b2',
    });
    // Force /wt/stale to be old.
    db.prepare('UPDATE worktrees SET last_used_at = ? WHERE path = ?').run(
      Date.now() - 10 * 24 * 60 * 60 * 1000,
      '/wt/stale',
    );

    const idle = listIdleWorktrees(db, 7 * 24 * 60 * 60 * 1000);
    expect(idle.map((w) => w.path)).toEqual(['/wt/stale']);
  });

  it('listOldestIdle returns N oldest, leased excluded', () => {
    for (const [path, age] of [
      ['/wt/a', 1000],
      ['/wt/b', 3000],
      ['/wt/c', 500],
    ] as const) {
      registerWorktree(db, { path, agent: 'guardian', task_id: path, branch: 'b' });
      db.prepare('UPDATE worktrees SET last_used_at = ? WHERE path = ?').run(
        Date.now() - age,
        path,
      );
    }
    const sid = mkSession();
    acquireLease(db, '/wt/b', sid); // /wt/b is leased; excluded
    const oldest = listOldestIdle(db, 5);
    expect(oldest.map((w) => w.path)).toEqual(['/wt/a', '/wt/c']);
  });

  it('removeWorktree deletes', () => {
    registerWorktree(db, { path: '/wt/z', agent: 'guardian', task_id: 'z', branch: 'b' });
    removeWorktree(db, '/wt/z');
    expect(findWorktreeByTask(db, 'guardian', 'z')).toBeUndefined();
  });
});
