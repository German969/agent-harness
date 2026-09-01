// Public surface of the workspace module.

export { sanitizeTaskId, worktreePath, branchName } from './paths.js';
export {
  addWorktree,
  removeWorktree,
  pruneWorktreeAdmin,
  hasBranch,
  listWorktrees,
  GitError,
} from './git.js';
export {
  acquireWorkspace,
  type AcquireRequest,
  type AcquireResult,
  type ManagerConfig,
  type WorkspaceLease,
} from './manager.js';
export { pruneIdle, forcePrune, type PruneResult } from './prune.js';
