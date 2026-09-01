// Path scheme + sanitization for per-task worktrees.
// Per router/ARCHITECTURE.md §2.3.
//
// Layout: <root>/<agent>/<task-id>/
//   root   = /var/lib/agents/worktrees  (production; configurable)
//   agent  = kebab-case AgentId (validated via the AgentId type — safe)
//   task-id = arbitrary caller-provided string — MUST be sanitized

import { resolve } from 'node:path';
import type { AgentId } from '../types.js';

/**
 * Sanitize a task ID for use in a filesystem path. Allows only:
 *   alphanumeric, hyphen, underscore, period, colon
 * Rejects any other character. Rejects any leading '.' (no dotfiles / dot-parent).
 * Rejects '..' as a whole segment.
 */
export function sanitizeTaskId(taskId: string): string {
  if (taskId.length === 0) throw new Error('task_id_empty');
  if (taskId.length > 128) throw new Error('task_id_too_long');
  if (taskId === '.' || taskId === '..') throw new Error('task_id_reserved');
  if (taskId.startsWith('.')) throw new Error('task_id_leading_dot');
  if (!/^[a-zA-Z0-9_.:-]+$/.test(taskId)) throw new Error('task_id_invalid_chars');
  return taskId;
}

/** Absolute path for a task's worktree. Throws on malformed task_id. */
export function worktreePath(root: string, agent: AgentId, taskId: string): string {
  const safe = sanitizeTaskId(taskId);
  const absolute = resolve(root, agent, safe);
  // Belt + suspenders: ensure the resolved path is still under root.
  const rootAbs = resolve(root);
  if (!absolute.startsWith(`${rootAbs}/`) && absolute !== rootAbs) {
    throw new Error('worktree_path_escape');
  }
  return absolute;
}

/** Branch name for an agent-owned task. Matches ARCHITECTURE.md Appendix A. */
export function branchName(agent: AgentId, taskId: string): string {
  const safe = sanitizeTaskId(taskId);
  return `agent/${agent}/${safe}`;
}
