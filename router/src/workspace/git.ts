// Git operations for worktree management.
// Uses child_process.execFile — no shell interpolation to prevent injection.
//
// All commands run against a source repo path (the cloned target project).
// Errors surface as GitError with stderr for diagnostics.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export class GitError extends Error {
  override readonly name = 'GitError';

  constructor(
    public readonly command: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(`git ${command} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileP('git', ['-C', cwd, ...args], { maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    const e = err as { code?: number; stderr?: string; message?: string };
    throw new GitError(
      args.join(' '),
      typeof e.code === 'number' ? e.code : null,
      e.stderr ?? e.message ?? '',
    );
  }
}

/**
 * Create a new worktree at `worktreePath` for `branch`, based on `baseBranch`.
 * If the branch already exists, uses it as-is; otherwise creates it from baseBranch.
 */
export async function addWorktree(args: {
  sourceRepo: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}): Promise<void> {
  const branchExists = await hasBranch(args.sourceRepo, args.branch);
  const gitArgs = branchExists
    ? ['worktree', 'add', args.worktreePath, args.branch]
    : ['worktree', 'add', '-b', args.branch, args.worktreePath, args.baseBranch];
  await runGit(args.sourceRepo, gitArgs);
}

/**
 * Remove a worktree. `--force` is used because the worktree may have uncommitted
 * changes at cleanup time (session was interrupted); we accept the data loss for
 * mid-run interrupts. Callers should ensure normal-completion sessions commit + push
 * before cleanup runs.
 */
export async function removeWorktree(args: {
  sourceRepo: string;
  worktreePath: string;
}): Promise<void> {
  await runGit(args.sourceRepo, ['worktree', 'remove', '--force', args.worktreePath]);
}

/**
 * True when the worktree holds work that exists nowhere else: uncommitted edits, or
 * commits that no remote-tracking ref can reach.
 *
 * `removeWorktree` uses `--force` and its own comment says the data loss is accepted
 * for mid-run interrupts, with the burden on callers to "commit + push before cleanup
 * runs". A SessionEnd hook is that caller — but a session killed by OOM or a container
 * restart never runs one, so for those there is no caller to rely on. Idle GC checks
 * this first, so routine cleanup cannot be what destroys a session's only copy.
 *
 * `HEAD --not --remotes` is the right question rather than `@{u}..HEAD`: a fresh
 * worktree sits on a new branch with no upstream, so an upstream comparison would
 * call every pristine checkout "unpushed" and the pruner would stop reclaiming
 * anything — trading a rare data loss for a guaranteed full disk. Reachability from
 * ANY remote ref answers both cases: a pushed branch is reachable, and so is an
 * untouched branch still sitting on the base commit.
 *
 * A repo with no remote-tracking refs at all (a local-only mirror, or a test rig)
 * reports false: pushing was never possible there, so "unpushed" is not a meaningful
 * state and blocking on it would again mean never pruning. Any other failure to
 * determine the answer reports true — if we cannot tell, we do not delete.
 */
export async function hasUnpushedWork(worktreePath: string): Promise<boolean> {
  try {
    const { stdout: dirty } = await runGit(worktreePath, ['status', '--porcelain']);
    if (dirty.trim().length > 0) return true;
  } catch {
    return true;
  }
  try {
    const { stdout: remoteRefs } = await runGit(worktreePath, [
      'for-each-ref',
      '--count=1',
      '--format=%(refname)',
      'refs/remotes',
    ]);
    if (remoteRefs.trim().length === 0) return false;

    const { stdout: unreachable } = await runGit(worktreePath, [
      'rev-list',
      '--count',
      'HEAD',
      '--not',
      '--remotes',
    ]);
    return Number.parseInt(unreachable.trim(), 10) > 0;
  } catch {
    return true;
  }
}

/** Prune stale worktree admin entries (git's internal cleanup; safe to run periodically). */
export async function pruneWorktreeAdmin(sourceRepo: string): Promise<void> {
  await runGit(sourceRepo, ['worktree', 'prune']);
}

/** Whether a branch exists in the source repo. */
export async function hasBranch(sourceRepo: string, branch: string): Promise<boolean> {
  try {
    await runGit(sourceRepo, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** List worktrees registered with the source repo. Returns absolute paths. */
export async function listWorktrees(sourceRepo: string): Promise<string[]> {
  const { stdout } = await runGit(sourceRepo, ['worktree', 'list', '--porcelain']);
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}
