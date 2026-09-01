// Thread-key construction. A thread_key uniquely identifies a conversation
// surface — same key across events means "same thread / continuation candidate."
// Per router/ARCHITECTURE.md §2.2 (Continuation logic).

import type { WebhookEvent } from '../ingress/types.js';

/**
 * Build a thread_key from a normalized WebhookEvent.
 * Returns undefined if the payload doesn't have enough context (rare — treat as
 * "no continuation possible; start fresh session").
 *
 * Formats:
 *   - slack:<channel_id>/<thread_ts>  — Slack thread (or top-level message)
 *   - linear:<issue_key>              — Linear issue (all comments = one thread)
 *   - github:<repo>/pr/<number>       — PR (review + comments + commits)
 *   - github:<repo>/issue/<number>    — issue
 *   - scheduled:<cron_id>             — cron tick (never continues)
 */
export function buildThreadKey(event: WebhookEvent): string | undefined {
  switch (event.provider) {
    case 'slack':
      return buildSlackThreadKey(event);
    case 'linear':
      return buildLinearThreadKey(event);
    case 'github':
      return buildGithubThreadKey(event);
  }
}

function buildSlackThreadKey(event: WebhookEvent): string | undefined {
  const p = event.payload as { event?: unknown };
  if (typeof p.event !== 'object' || p.event === null) return undefined;
  const ev = p.event as { channel?: unknown; thread_ts?: unknown; ts?: unknown };
  const channel = typeof ev.channel === 'string' ? ev.channel : undefined;
  if (!channel) return undefined;
  // Use thread_ts if present (reply); otherwise ts (top-level message).
  const threadTs =
    typeof ev.thread_ts === 'string' ? ev.thread_ts : typeof ev.ts === 'string' ? ev.ts : undefined;
  if (!threadTs) return `slack:${channel}`;
  return `slack:${channel}/${threadTs}`;
}

function buildLinearThreadKey(event: WebhookEvent): string | undefined {
  const p = event.payload as { data?: unknown };
  if (typeof p.data !== 'object' || p.data === null) return undefined;
  const d = p.data as { identifier?: unknown; issue?: unknown };
  // Direct issue events: data.identifier is 'ENG-1234'
  if (typeof d.identifier === 'string') return `linear:${d.identifier}`;
  // Comment events: data.issue.identifier
  if (typeof d.issue === 'object' && d.issue !== null && 'identifier' in d.issue) {
    const id = (d.issue as { identifier: unknown }).identifier;
    if (typeof id === 'string') return `linear:${id}`;
  }
  return undefined;
}

function buildGithubThreadKey(event: WebhookEvent): string | undefined {
  const p = event.payload as {
    repository?: unknown;
    pull_request?: unknown;
    issue?: unknown;
    check_suite?: { pull_requests?: unknown };
    check_run?: { pull_requests?: unknown };
    workflow_run?: { pull_requests?: unknown };
  };
  const repo = extractRepoFullName(p.repository);
  if (!repo) return undefined;

  // PR-scoped events
  if (typeof p.pull_request === 'object' && p.pull_request !== null) {
    const num = (p.pull_request as { number?: unknown }).number;
    if (typeof num === 'number') return `github:${repo}/pr/${num}`;
  }
  // Issue-scoped events (which include issue_comment on PRs — GitHub's issue_comment
  // event fires for both issues and PRs; distinguishable via issue.pull_request field)
  if (typeof p.issue === 'object' && p.issue !== null) {
    const issue = p.issue as { number?: unknown; pull_request?: unknown };
    if (typeof issue.number === 'number') {
      const isPr = issue.pull_request != null;
      return `github:${repo}/${isPr ? 'pr' : 'issue'}/${issue.number}`;
    }
  }

  // CI events (check_suite / check_run / workflow_run) name no `pull_request`
  // node — they carry the PRs they ran against in a `pull_requests` array. Read
  // it so a CI event lands on the SAME thread as the PR it belongs to.
  const ciPrs =
    p.check_suite?.pull_requests ?? p.check_run?.pull_requests ?? p.workflow_run?.pull_requests;
  if (Array.isArray(ciPrs)) {
    for (const pr of ciPrs) {
      const num = (pr as { number?: unknown })?.number;
      if (typeof num === 'number') return `github:${repo}/pr/${num}`;
    }
  }

  // No task scope, so no thread. This used to fall back to a bare `github:<repo>`,
  // which is not a thread — it is every event in the repository sharing one key.
  // `findContinuation` then linked whatever it found there, and a CI event landed
  // on a session from unrelated work weeks earlier (281 continued 206 that way,
  // then 282 continued 281). A key that cannot distinguish two units of work can
  // only ever produce a false continuation, so returning undefined — "start
  // fresh" — is strictly better than a key that is wrong.
  return undefined;
}

function extractRepoFullName(repo: unknown): string | undefined {
  if (typeof repo !== 'object' || repo === null) return undefined;
  const r = repo as { full_name?: unknown };
  return typeof r.full_name === 'string' ? r.full_name : undefined;
}
