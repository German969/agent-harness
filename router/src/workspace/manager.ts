// Workspace manager — the runtime-facing API for worktree acquisition.
//
// Per router/ARCHITECTURE.md §1.3 (Prepare) + §2.3 (worktree manager).
//
// Flow:
//   1. Compute paths (agent + task_id → path + branch)
//   2. Look up existing worktree registration in the `worktrees` table
//   3. If absent: git worktree add + register in DB
//   4. Acquire the DB lease (atomic; fails if another session holds it)
//   5. Return a WorkspaceLease with a release() that clears the lease
//
// Continuation reuse: if two sessions target the same task_id and the first is
// still running, the second's acquireLease call fails. The caller (runtime) can
// choose to wait, queue, or drop.

import type { Db } from '../state/db.js';
import {
  acquireLease,
  findWorktreeByTask,
  registerWorktree,
  releaseLease,
} from '../state/index.js';
import type { AgentId } from '../types.js';
import { addWorktree } from './git.js';
import { branchName, worktreePath } from './paths.js';

export type AcquireRequest = {
  agent: AgentId;
  taskId: string;
  sessionId: number;
  sourceRepo: string;
  baseBranch: string;
};

export type ManagerConfig = {
  /** Base directory for all worktrees; each agent gets its own subdir underneath. */
  root: string;
};

export type AcquireResult =
  | { ok: true; lease: WorkspaceLease }
  | { ok: false; reason: 'busy' | 'setup_failed'; message?: string };

export type WorkspaceLease = {
  agent: AgentId;
  taskId: string;
  path: string;
  branch: string;
  sessionId: number;
  isReused: boolean;
  release: () => Promise<void>;
};

export async function acquireWorkspace(
  db: Db,
  cfg: ManagerConfig,
  req: AcquireRequest,
): Promise<AcquireResult> {
  const path = worktreePath(cfg.root, req.agent, req.taskId);
  const branch = branchName(req.agent, req.taskId);

  const existing = findWorktreeByTask(db, req.agent, req.taskId);
  let isReused = false;

  if (!existing) {
    // Create the worktree on disk first (git succeeds → then register in DB).
    try {
      await addWorktree({
        sourceRepo: req.sourceRepo,
        worktreePath: path,
        branch,
        baseBranch: req.baseBranch,
      });
    } catch (err) {
      return { ok: false, reason: 'setup_failed', message: (err as Error).message };
    }
    registerWorktree(db, {
      path,
      agent: req.agent,
      task_id: req.taskId,
      branch,
    });
  } else {
    isReused = true;
  }

  const acquired = acquireLease(db, path, req.sessionId);
  if (!acquired) {
    return { ok: false, reason: 'busy' };
  }

  const lease: WorkspaceLease = {
    agent: req.agent,
    taskId: req.taskId,
    path,
    branch,
    sessionId: req.sessionId,
    isReused,
    release: async () => {
      releaseLease(db, path);
    },
  };
  return { ok: true, lease };
}
