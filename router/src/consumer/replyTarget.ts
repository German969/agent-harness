// Resolve a WebhookEvent + session env → ReplyTarget.
//
// Per-provider rules:
//   - Slack: channel from event.channel; thread_ts if present. Token from
//     SLACK_BOT_TOKEN in session env.
//   - Linear: issue_id from data.issue.id OR data.id (for direct issue events).
//     Token from LINEAR_TOKEN.
//   - GitHub: owner/repo from repository.full_name; issue_number from
//     issue.number OR pull_request.number. Token from GITHUB_APP_INSTALLATION_TOKEN.
//
// Returns undefined when the event carries no reply surface (e.g. GitHub push
// events, Slack event_deleted). The consumer treats that as "session runs but
// no reply is streamed" — the CLI is still the source of truth.

import type { WebhookEvent } from '../ingress/types.js';
import type { ReplyTarget } from '../reply/types.js';
import type { SessionEnv } from '../secrets/types.js';

export function resolveReplyTarget(
  event: WebhookEvent,
  sessionEnv: SessionEnv,
): ReplyTarget | undefined {
  switch (event.provider) {
    case 'slack':
      return resolveSlack(event, sessionEnv);
    case 'linear':
      return resolveLinear(event, sessionEnv);
    case 'github':
      return resolveGitHub(event, sessionEnv);
  }
}

function resolveSlack(event: WebhookEvent, env: SessionEnv): ReplyTarget | undefined {
  const p = event.payload as { event?: { channel?: unknown; thread_ts?: unknown; ts?: unknown } };
  if (!p.event) return undefined;
  const channel = typeof p.event.channel === 'string' ? p.event.channel : undefined;
  if (!channel) return undefined;
  const token = env.SLACK_BOT_TOKEN;
  if (!token) return undefined;
  const thread_ts =
    typeof p.event.thread_ts === 'string'
      ? p.event.thread_ts
      : typeof p.event.ts === 'string'
        ? p.event.ts
        : undefined;
  return {
    provider: 'slack',
    channel,
    ...(thread_ts ? { thread_ts } : {}),
    token,
  };
}

function resolveLinear(event: WebhookEvent, env: SessionEnv): ReplyTarget | undefined {
  const p = event.payload as {
    data?: {
      id?: unknown;
      issue?: { id?: unknown };
      issueId?: unknown;
    };
  };
  const d = p.data;
  if (!d) return undefined;
  // Direct issue events: data.id. Comment events: data.issue.id. Fallback: data.issueId.
  const issue_id =
    (d.issue && typeof d.issue.id === 'string' ? d.issue.id : undefined) ??
    (typeof d.issueId === 'string' ? d.issueId : undefined) ??
    (typeof d.id === 'string' ? d.id : undefined);
  if (!issue_id) return undefined;
  const token = env.LINEAR_TOKEN;
  if (!token) return undefined;
  return { provider: 'linear', issue_id, token };
}

function resolveGitHub(event: WebhookEvent, env: SessionEnv): ReplyTarget | undefined {
  const p = event.payload as {
    repository?: { full_name?: unknown };
    issue?: { number?: unknown };
    pull_request?: { number?: unknown };
  };
  const fullName = typeof p.repository?.full_name === 'string' ? p.repository.full_name : undefined;
  if (!fullName || !fullName.includes('/')) return undefined;
  const [owner, repo] = fullName.split('/') as [string, string];
  const issue_number =
    typeof p.issue?.number === 'number'
      ? p.issue.number
      : typeof p.pull_request?.number === 'number'
        ? p.pull_request.number
        : undefined;
  if (issue_number === undefined) return undefined;
  const token = env.GITHUB_APP_INSTALLATION_TOKEN ?? env.GITHUB_TOKEN;
  if (!token) return undefined;
  return { provider: 'github', owner, repo, issue_number, token };
}
