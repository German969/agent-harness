// Extract the user-facing "initial message" from a WebhookEvent, per provider.
//
// This is what gets threaded into the SDK's `initialMessage` — the model reads
// it as the trigger prompt. Provider payloads vary:
//   - slack: event.text (app_mention or message)
//   - linear: comment.body OR issue.description / title
//   - github: issue.body, comment.body, PR title+body — depends on event_type
//
// The extractor is best-effort and returns a fallback string if nothing fits;
// callers should still call it (never pass raw payload as the message).

import type { WebhookEvent } from '../ingress/types.js';

export type ExtractOptions = {
  /**
   * Bot's own Slack user id (e.g. `U0123ABCDEF`). When set, a leading
   * `<@BOT_USER_ID>` in the incoming Slack message is stripped so the model
   * sees the raw question — without this, the model tends to echo the mention
   * back at the start of its reply, producing a self-tag in Slack.
   */
  slackBotUserId?: string;
};

export function extractInitialMessage(event: WebhookEvent, opts: ExtractOptions = {}): string {
  switch (event.provider) {
    case 'slack':
      return extractSlack(event, opts);
    case 'linear':
      return extractLinear(event);
    case 'github':
      return extractGitHub(event);
    default:
      return `${event.provider} ${event.event_type} (${event.delivery_id})`;
  }
}

function extractSlack(event: WebhookEvent, opts: ExtractOptions): string {
  const p = event.payload as { event?: { text?: unknown } };
  if (p.event && typeof p.event.text === 'string') {
    return stripLeadingSelfMention(p.event.text, opts.slackBotUserId);
  }
  return `slack ${event.event_type}`;
}

function stripLeadingSelfMention(text: string, botUserId?: string): string {
  if (!botUserId) return text;
  const pattern = new RegExp(`^\\s*<@${escapeForRegex(botUserId)}>[\\s:,]*`);
  return text.replace(pattern, '').trim();
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractLinear(event: WebhookEvent): string {
  const p = event.payload as {
    data?: {
      body?: unknown;
      description?: unknown;
      title?: unknown;
    };
  };
  const d = p.data;
  if (d) {
    if (typeof d.body === 'string' && d.body.length > 0) return d.body;
    if (typeof d.description === 'string' && d.description.length > 0) return d.description;
    if (typeof d.title === 'string' && d.title.length > 0) return d.title;
  }
  return `linear ${event.event_type}`;
}

function extractGitHub(event: WebhookEvent): string {
  const body = extractGitHubBody(event);
  const context = githubPrContext(event);
  return context ? `${context}\n\n${body}` : body;
}

function extractGitHubBody(event: WebhookEvent): string {
  const p = event.payload as {
    comment?: { body?: unknown };
    issue?: { body?: unknown; title?: unknown };
    pull_request?: { body?: unknown; title?: unknown };
    review?: { body?: unknown };
  };

  // Comment events (issue_comment / pull_request_review_comment)
  if (p.comment && typeof p.comment.body === 'string' && p.comment.body.length > 0) {
    return p.comment.body;
  }
  // Review events (pull_request_review)
  if (p.review && typeof p.review.body === 'string' && p.review.body.length > 0) {
    return p.review.body;
  }
  // PR events (pull_request.opened, .synchronize, etc.)
  if (p.pull_request) {
    const title = typeof p.pull_request.title === 'string' ? p.pull_request.title : '';
    const body = typeof p.pull_request.body === 'string' ? p.pull_request.body : '';
    if (title || body) return `${title}\n\n${body}`.trim();
  }
  // Issue events (issues.opened, .edited)
  if (p.issue) {
    const title = typeof p.issue.title === 'string' ? p.issue.title : '';
    const body = typeof p.issue.body === 'string' ? p.issue.body : '';
    if (title || body) return `${title}\n\n${body}`.trim();
  }
  return `github ${event.event_type}`;
}

/**
 * A one-block header for PR-scoped events, prepended to the trigger message so
 * the agent knows exactly which PR it's on and how to read the code. Without this
 * a review-comment trigger arrives as bare text — the agent doesn't know the PR
 * number and can't find the changes (its local checkout is on the base branch).
 * Returns undefined for non-PR events.
 */
function githubPrContext(event: WebhookEvent): string | undefined {
  const p = event.payload as {
    repository?: { full_name?: unknown };
    pull_request?: {
      number?: unknown;
      head?: { ref?: unknown; sha?: unknown };
      base?: { ref?: unknown };
    };
    issue?: { number?: unknown; pull_request?: unknown };
  };
  const repo = typeof p.repository?.full_name === 'string' ? p.repository.full_name : undefined;

  let number: number | undefined;
  if (typeof p.pull_request?.number === 'number') number = p.pull_request.number;
  else if (p.issue?.pull_request !== undefined && typeof p.issue?.number === 'number') {
    number = p.issue.number;
  }
  if (!repo || number === undefined) return undefined;

  const headRef =
    typeof p.pull_request?.head?.ref === 'string' ? p.pull_request.head.ref : undefined;
  const headSha =
    typeof p.pull_request?.head?.sha === 'string' ? p.pull_request.head.sha : undefined;
  const baseRef =
    typeof p.pull_request?.base?.ref === 'string' ? p.pull_request.base.ref : undefined;

  const refs = [`[PR context] ${repo} #${number}`];
  if (headRef) refs.push(`head ${headRef}${headSha ? ` (${headSha.slice(0, 7)})` : ''}`);
  if (baseRef) refs.push(`base ${baseRef}`);

  return (
    `${refs.join(' — ')}\n` +
    `Read this PR's changes via the GitHub MCP — pull_request_read (get_diff / get_files) on ${repo} #${number}, ` +
    `or get_file_contents with ref "refs/pull/${number}/head". The local checkout is on the base branch and won't have them.`
  );
}
