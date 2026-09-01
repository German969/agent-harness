// task_id derivation — the identity of a unit of work, used to name its worktree.
//
// One worktree per task (ARCHITECTURE.md §2.3, PLAN.md L214), so the id has to be
// stable across every event about the same ticket or PR: a label added, a comment,
// a follow-up. `thread_key` already means exactly that, so the task id is derived
// from it rather than re-parsed out of each provider's payload — one definition of
// "same conversation" instead of two that can drift apart.
//
// The only transformation is making it path-safe: `paths.ts` rejects '/', which
// GitHub thread keys contain (`github:owner/repo/pr/12`).

// The id has to satisfy BOTH consumers: `worktreePath` (a filesystem path) and
// `branchName` (a git ref). Their intersection is narrower than either alone —
// `sanitizeTaskId` permits ':' because a colon is legal in a path, but git refs
// reject it outright ("fatal: 'agent/x/linear:IRS-46' is not a valid branch
// name"). So colons collapse here too, and the allowed set is what git accepts.
const UNSAFE = /[^a-zA-Z0-9_.-]+/g;

/**
 * Derive a filesystem-safe task id from a thread key, or undefined when the event
 * has no thread (nothing stable to key a worktree on — such a session gets none).
 */
export function taskIdFromThreadKey(threadKey: string | undefined): string | undefined {
  if (!threadKey) return undefined;
  const safe = threadKey.replace(UNSAFE, '-').replace(/^[.-]+/, '');
  if (safe.length === 0) return undefined;
  // paths.ts caps at 128; truncating keeps the prefix, which is the identifying part.
  return safe.slice(0, 128);
}
