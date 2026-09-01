// Worktree pruning — idle cleanup + disk-pressure force cleanup.
// Per router/ARCHITECTURE.md §2.3 (Lifecycle > Idle prune / Force prune).

import type { Db } from '../state/db.js';
import {
  listIdleWorktrees,
  listOldestIdle,
  removeWorktree as removeWorktreeRow,
} from '../state/index.js';
import { removeWorktree as gitRemoveWorktree, hasUnpushedWork, pruneWorktreeAdmin } from './git.js';

export type PruneResult = {
  attempted: number;
  removed: number;
  /** Worktrees left in place because they still hold unpushed work (idle GC only). */
  keptUnpushed?: string[];
  errors: Array<{ path: string; message: string }>;
};

/**
 * Prune worktrees idle >= maxIdleMs. Runs hourly from the router (server.ts).
 * Never touches worktrees with an active lease (their active_session_id is non-null),
 * and never one still holding unpushed work.
 *
 * Skipping unpushed work is what separates routine GC from the disk emergency below.
 * Reclaiming disk is a convenience; deleting the only copy of a session's output is
 * not a tradeoff routine cleanup gets to make on its own. `forcePrune` still can,
 * because by then the alternative is the volume filling and every session failing.
 */
export async function pruneIdle(args: {
  db: Db;
  sourceRepo: string;
  maxIdleMs: number;
}): Promise<PruneResult> {
  const candidates = listIdleWorktrees(args.db, args.maxIdleMs);
  const paths: string[] = [];
  const keptUnpushed: string[] = [];
  for (const w of candidates) {
    if (await hasUnpushedWork(w.path)) keptUnpushed.push(w.path);
    else paths.push(w.path);
  }
  const result = await runPrune(args.db, args.sourceRepo, paths);
  return keptUnpushed.length > 0 ? { ...result, keptUnpushed } : result;
}

/**
 * Force-prune the N oldest idle worktrees. Called on disk-pressure alerts
 * (Phase 10) — the router's observability layer would decide when this fires.
 *
 * Deliberately does NOT spare unpushed work, unlike `pruneIdle`: this only runs
 * when the volume is filling, where keeping one session's uncommitted edits costs
 * every other session on the box.
 */
export async function forcePrune(args: {
  db: Db;
  sourceRepo: string;
  count: number;
}): Promise<PruneResult> {
  const candidates = listOldestIdle(args.db, args.count);
  return runPrune(
    args.db,
    args.sourceRepo,
    candidates.map((w) => w.path),
  );
}

async function runPrune(db: Db, sourceRepo: string, paths: string[]): Promise<PruneResult> {
  const errors: PruneResult['errors'] = [];
  let removed = 0;

  for (const path of paths) {
    try {
      await gitRemoveWorktree({ sourceRepo, worktreePath: path });
      removeWorktreeRow(db, path);
      removed += 1;
    } catch (err) {
      errors.push({ path, message: (err as Error).message });
    }
  }

  // Best-effort admin cleanup (harmless if it fails).
  try {
    await pruneWorktreeAdmin(sourceRepo);
  } catch {
    // ignore
  }

  return { attempted: paths.length, removed, errors };
}
