// PR routing state — supports owner-per-PR GitHub routing (see classifier.ts).
//
// pr_owner caches the resolved owner agent for a PR so that CI events
// (check_suite / check_run / workflow_run), whose payloads reference the PR by
// number only, can be gated to the same single owner as the PR's other events
// instead of cascading to every installed GitHub App.

import type { AgentId } from '../types.js';
import type { Db } from './db.js';

/** Upsert the owner agent for a PR. Called whenever a PR event resolves an owner. */
export function recordPrOwner(
  db: Db,
  args: { repo: string; number: number; agent: AgentId; now?: number },
): void {
  db.prepare(
    `INSERT INTO pr_owner (repo, number, agent, updated_at)
     VALUES (@repo, @number, @agent, @updated_at)
     ON CONFLICT(repo, number) DO UPDATE SET
       agent = excluded.agent,
       updated_at = excluded.updated_at`,
  ).run({
    repo: args.repo,
    number: args.number,
    agent: args.agent,
    updated_at: args.now ?? Date.now(),
  });
}

/** Look up the cached owner agent for a PR, or undefined if none recorded yet. */
export function getPrOwner(db: Db, repo: string, number: number): AgentId | undefined {
  const row = db
    .prepare('SELECT agent FROM pr_owner WHERE repo = ? AND number = ?')
    .get(repo, number) as { agent: string } | undefined;
  return row?.agent as AgentId | undefined;
}
