import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Db,
  applyMigrations,
  createSession,
  findWorktreeByTask,
  openDb,
} from '../../src/state/index.js';
import { acquireWorkspace, forcePrune, pruneIdle } from '../../src/workspace/index.js';

// ---------------------------------------------------------------------------
// Test rig: temp source git repo + temp worktrees root + in-memory DB
// ---------------------------------------------------------------------------
let tempDir: string;
let sourceRepo: string;
let worktreesRoot: string;
let db: Db;

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'router-workspace-test-'));
  sourceRepo = join(tempDir, 'source');
  worktreesRoot = join(tempDir, 'worktrees');

  // Bootstrap a git repo with one commit on 'main'.
  execFileSync('git', ['init', '-b', 'main', sourceRepo], { stdio: 'ignore' });
  writeFileSync(join(sourceRepo, 'README.md'), '# test\n', 'utf-8');
  git(sourceRepo, ['add', '.']);
  git(sourceRepo, ['commit', '-m', 'initial']);

  db = openDb({ path: ':memory:' });
  applyMigrations(db);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function mkSession(): number {
  return createSession(db, {
    agent: 'builder-server',
    thread_key: `t-${Math.random()}`,
    status: 'running',
    triggered_by: 'webhook:linear',
    trigger_payload: {},
  });
}

// ---------------------------------------------------------------------------
// acquireWorkspace
// ---------------------------------------------------------------------------
describe('acquireWorkspace', () => {
  it('creates a new worktree + branch on first acquisition', async () => {
    const sid = mkSession();
    const result = await acquireWorkspace(
      db,
      { root: worktreesRoot },
      {
        agent: 'builder-server',
        taskId: 'eng-1',
        sessionId: sid,
        sourceRepo,
        baseBranch: 'main',
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.lease.path).toBe(join(worktreesRoot, 'builder-server', 'eng-1'));
    expect(result.lease.branch).toBe('agent/builder-server/eng-1');
    expect(result.lease.isReused).toBe(false);
    expect(existsSync(result.lease.path)).toBe(true);
    expect(existsSync(join(result.lease.path, 'README.md'))).toBe(true);
    expect(findWorktreeByTask(db, 'builder-server', 'eng-1')?.active_session_id).toBe(sid);
  });

  it('reuses an existing worktree on second acquisition (continuation)', async () => {
    const first = mkSession();
    const r1 = await acquireWorkspace(
      db,
      { root: worktreesRoot },
      {
        agent: 'builder-server',
        taskId: 'eng-2',
        sessionId: first,
        sourceRepo,
        baseBranch: 'main',
      },
    );
    if (!r1.ok) return expect.fail('first acquire failed');
    await r1.lease.release();

    const second = mkSession();
    const r2 = await acquireWorkspace(
      db,
      { root: worktreesRoot },
      {
        agent: 'builder-server',
        taskId: 'eng-2',
        sessionId: second,
        sourceRepo,
        baseBranch: 'main',
      },
    );
    if (!r2.ok) return expect.fail('reuse failed');
    expect(r2.lease.isReused).toBe(true);
    expect(r2.lease.path).toBe(r1.lease.path);
  });

  it('two parallel sessions for different tasks get separate worktrees', async () => {
    const s1 = mkSession();
    const s2 = mkSession();

    const r1 = await acquireWorkspace(
      db,
      { root: worktreesRoot },
      {
        agent: 'builder-server',
        taskId: 'eng-A',
        sessionId: s1,
        sourceRepo,
        baseBranch: 'main',
      },
    );
    const r2 = await acquireWorkspace(
      db,
      { root: worktreesRoot },
      {
        agent: 'builder-server',
        taskId: 'eng-B',
        sessionId: s2,
        sourceRepo,
        baseBranch: 'main',
      },
    );

    if (!r1.ok || !r2.ok) return expect.fail('acquire failed');
    expect(r1.lease.path).not.toBe(r2.lease.path);
    expect(existsSync(r1.lease.path)).toBe(true);
    expect(existsSync(r2.lease.path)).toBe(true);
  });

  it('rejects a second concurrent session for the same task (busy)', async () => {
    const s1 = mkSession();
    const s2 = mkSession();

    const r1 = await acquireWorkspace(
      db,
      { root: worktreesRoot },
      {
        agent: 'guardian',
        taskId: 'pr-99',
        sessionId: s1,
        sourceRepo,
        baseBranch: 'main',
      },
    );
    expect(r1.ok).toBe(true);

    // Second session tries same task WITHOUT the first releasing.
    const r2 = await acquireWorkspace(
      db,
      { root: worktreesRoot },
      {
        agent: 'guardian',
        taskId: 'pr-99',
        sessionId: s2,
        sourceRepo,
        baseBranch: 'main',
      },
    );
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('busy');
  });

  it('release() clears the lease so the same task can be re-acquired', async () => {
    const s1 = mkSession();
    const r1 = await acquireWorkspace(
      db,
      { root: worktreesRoot },
      {
        agent: 'guardian',
        taskId: 'pr-100',
        sessionId: s1,
        sourceRepo,
        baseBranch: 'main',
      },
    );
    if (!r1.ok) return expect.fail('first acquire failed');
    await r1.lease.release();

    const s2 = mkSession();
    const r2 = await acquireWorkspace(
      db,
      { root: worktreesRoot },
      {
        agent: 'guardian',
        taskId: 'pr-100',
        sessionId: s2,
        sourceRepo,
        baseBranch: 'main',
      },
    );
    expect(r2.ok).toBe(true);
  });

  it('setup_failed when source repo does not exist', async () => {
    const sid = mkSession();
    const result = await acquireWorkspace(
      db,
      { root: worktreesRoot },
      {
        agent: 'builder-server',
        taskId: 'eng-3',
        sessionId: sid,
        sourceRepo: '/nonexistent/source/repo',
        baseBranch: 'main',
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('setup_failed');
  });

  it('sanitizes task_id (rejects escape attempts before touching git)', async () => {
    const sid = mkSession();
    await expect(
      acquireWorkspace(
        db,
        { root: worktreesRoot },
        {
          agent: 'builder-server',
          taskId: '../etc/passwd',
          sessionId: sid,
          sourceRepo,
          baseBranch: 'main',
        },
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// pruneIdle + forcePrune
// ---------------------------------------------------------------------------
describe('pruneIdle', () => {
  it('removes idle worktrees older than maxIdleMs', async () => {
    const sid = mkSession();
    const r = await acquireWorkspace(
      db,
      { root: worktreesRoot },
      {
        agent: 'builder-server',
        taskId: 'eng-p1',
        sessionId: sid,
        sourceRepo,
        baseBranch: 'main',
      },
    );
    if (!r.ok) return expect.fail('setup failed');
    await r.lease.release();

    // Backdate last_used_at
    db.prepare('UPDATE worktrees SET last_used_at = ? WHERE path = ?').run(
      Date.now() - 100 * 60 * 60 * 1000,
      r.lease.path,
    );

    const result = await pruneIdle({ db, sourceRepo, maxIdleMs: 60 * 60 * 1000 });
    expect(result.removed).toBe(1);
    expect(result.errors).toEqual([]);
    expect(existsSync(r.lease.path)).toBe(false);
    expect(findWorktreeByTask(db, 'builder-server', 'eng-p1')).toBeUndefined();
  });

  // The other half of the truncation-durability story. The SessionEnd hook covers a
  // session that ENDS; a session killed by OOM or a container restart never runs one,
  // and `git worktree remove --force` does not care about uncommitted edits. Routine
  // GC must not be what destroys the only copy of a session's work.
  it('spares an idle worktree that still holds uncommitted edits', async () => {
    const sid = mkSession();
    const r = await acquireWorkspace(
      db,
      { root: worktreesRoot },
      {
        agent: 'builder-server',
        taskId: 'eng-dirty',
        sessionId: sid,
        sourceRepo,
        baseBranch: 'main',
      },
    );
    if (!r.ok) return expect.fail('setup failed');
    writeFileSync(join(r.lease.path, 'half-done.ts'), 'export const x = 1;\n', 'utf-8');
    await r.lease.release();
    db.prepare('UPDATE worktrees SET last_used_at = ? WHERE path = ?').run(
      Date.now() - 100 * 60 * 60 * 1000,
      r.lease.path,
    );

    const result = await pruneIdle({ db, sourceRepo, maxIdleMs: 60 * 60 * 1000 });

    expect(result.removed).toBe(0);
    expect(result.keptUnpushed).toEqual([r.lease.path]);
    expect(existsSync(join(r.lease.path, 'half-done.ts'))).toBe(true);
    // The lease row survives too, so the work is still findable.
    expect(findWorktreeByTask(db, 'builder-server', 'eng-dirty')).toBeDefined();
  });

  // The counterweight: sparing unpushed work must not mean never pruning, or the
  // volume fills and every session fails on ENOSPC — the problem wiring the pruner
  // was meant to solve.
  it('still removes an idle worktree whose commits are reachable from a remote', async () => {
    const origin = join(tempDir, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
    git(sourceRepo, ['remote', 'add', 'origin', origin]);
    git(sourceRepo, ['push', 'origin', 'main']);
    git(sourceRepo, ['fetch', 'origin']);

    const sid = mkSession();
    const r = await acquireWorkspace(
      db,
      { root: worktreesRoot },
      {
        agent: 'builder-server',
        taskId: 'eng-clean',
        sessionId: sid,
        sourceRepo,
        baseBranch: 'main',
      },
    );
    if (!r.ok) return expect.fail('setup failed');
    await r.lease.release();
    db.prepare('UPDATE worktrees SET last_used_at = ? WHERE path = ?').run(
      Date.now() - 100 * 60 * 60 * 1000,
      r.lease.path,
    );

    const result = await pruneIdle({ db, sourceRepo, maxIdleMs: 60 * 60 * 1000 });

    expect(result.removed).toBe(1);
    expect(result.keptUnpushed).toBeUndefined();
    expect(existsSync(r.lease.path)).toBe(false);
  });

  it('spares a worktree holding a commit no remote can reach', async () => {
    const origin = join(tempDir, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
    git(sourceRepo, ['remote', 'add', 'origin', origin]);
    git(sourceRepo, ['push', 'origin', 'main']);
    git(sourceRepo, ['fetch', 'origin']);

    const sid = mkSession();
    const r = await acquireWorkspace(
      db,
      { root: worktreesRoot },
      {
        agent: 'builder-server',
        taskId: 'eng-committed',
        sessionId: sid,
        sourceRepo,
        baseBranch: 'main',
      },
    );
    if (!r.ok) return expect.fail('setup failed');
    // Committed but never pushed — clean tree, real work. This is exactly what the
    // SessionEnd hook produces when its push fails.
    writeFileSync(join(r.lease.path, 'wip.ts'), 'export const y = 2;\n', 'utf-8');
    git(r.lease.path, ['add', '.']);
    git(r.lease.path, ['commit', '-m', 'wip']);
    await r.lease.release();
    db.prepare('UPDATE worktrees SET last_used_at = ? WHERE path = ?').run(
      Date.now() - 100 * 60 * 60 * 1000,
      r.lease.path,
    );

    const result = await pruneIdle({ db, sourceRepo, maxIdleMs: 60 * 60 * 1000 });

    expect(result.removed).toBe(0);
    expect(result.keptUnpushed).toEqual([r.lease.path]);
  });

  it('leaves active-lease worktrees alone', async () => {
    const sid = mkSession();
    const r = await acquireWorkspace(
      db,
      { root: worktreesRoot },
      {
        agent: 'builder-server',
        taskId: 'eng-p2',
        sessionId: sid,
        sourceRepo,
        baseBranch: 'main',
      },
    );
    if (!r.ok) return expect.fail('setup failed');
    // Do NOT release. Force last_used_at backwards; lease is still active.
    db.prepare('UPDATE worktrees SET last_used_at = ? WHERE path = ?').run(
      Date.now() - 100 * 60 * 60 * 1000,
      r.lease.path,
    );

    const result = await pruneIdle({ db, sourceRepo, maxIdleMs: 60 * 60 * 1000 });
    expect(result.removed).toBe(0);
    expect(existsSync(r.lease.path)).toBe(true);

    await r.lease.release(); // cleanup for afterEach
  });
});

describe('forcePrune', () => {
  it('removes the N oldest idle worktrees', async () => {
    // Create 3 idle worktrees with staggered last_used_at.
    for (const [n, ageHours] of [
      ['eng-old', 100],
      ['eng-medium', 50],
      ['eng-new', 1],
    ] as const) {
      const sid = mkSession();
      const r = await acquireWorkspace(
        db,
        { root: worktreesRoot },
        {
          agent: 'builder-server',
          taskId: n,
          sessionId: sid,
          sourceRepo,
          baseBranch: 'main',
        },
      );
      if (!r.ok) return expect.fail(`setup ${n} failed`);
      await r.lease.release();
      db.prepare('UPDATE worktrees SET last_used_at = ? WHERE path = ?').run(
        Date.now() - ageHours * 60 * 60 * 1000,
        r.lease.path,
      );
    }

    const result = await forcePrune({ db, sourceRepo, count: 2 });
    expect(result.removed).toBe(2);
    // Oldest two ('eng-old' + 'eng-medium') removed; 'eng-new' survives.
    expect(findWorktreeByTask(db, 'builder-server', 'eng-old')).toBeUndefined();
    expect(findWorktreeByTask(db, 'builder-server', 'eng-medium')).toBeUndefined();
    expect(findWorktreeByTask(db, 'builder-server', 'eng-new')).toBeDefined();
  });
});
