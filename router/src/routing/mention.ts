// Mention extraction for Slack + GitHub + Linear payloads.
// Per router/ARCHITECTURE.md §1.2 — explicit mention is the strongest routing
// signal; if present, it overrides label/channel-default routing.

import type { WebhookEvent } from '../ingress/types.js';
import type { AgentId } from '../types.js';
import type { Registry } from './registry.js';

/**
 * Return the agent explicitly mentioned in the event, or undefined.
 * "Mentioned" means:
 *   - Slack: <@BOT_USER_ID> in message text (matches slack.bot_user_id)
 *   - GitHub: @bot-username in comment body (matches github.bot_username)
 *   - Linear: mention markdown in comment body (@bot-handle or @agent_id)
 *
 * If multiple agents are mentioned, returns the first one found by scan order.
 * (The classifier can be extended later to fan out to multiple agents; per
 * ARCHITECTURE.md §1.2 that's a "two independent sessions" pattern.)
 */
export function extractMentionedAgent(reg: Registry, event: WebhookEvent): AgentId | undefined {
  switch (event.provider) {
    case 'slack':
      return extractSlackMention(reg, event);
    case 'github':
      return extractGithubMention(reg, event);
    case 'linear':
      return extractLinearMention(reg, event);
  }
}

function extractSlackMention(reg: Registry, event: WebhookEvent): AgentId | undefined {
  const p = event.payload as { event?: unknown };
  if (typeof p.event !== 'object' || p.event === null) return undefined;
  const ev = p.event as { text?: unknown; type?: unknown };
  if (typeof ev.text !== 'string') return undefined;

  // Match every <@Uxxx> mention in the text. Slack IDs are alphanumeric but we
  // allow hyphens/underscores so test fixtures + human-readable IDs work.
  const mentions = [...ev.text.matchAll(/<@([A-Z0-9_-]+)>/g)].map((m) => m[1] as string);
  for (const botUserId of mentions) {
    const agent = reg.slackByBotUserId.get(botUserId);
    if (agent) return agent;
  }
  return undefined;
}

function extractGithubMention(reg: Registry, event: WebhookEvent): AgentId | undefined {
  const p = event.payload as { comment?: unknown; issue?: unknown; pull_request?: unknown };
  const bodies = [getBody(p.comment), getBody(p.issue), getBody(p.pull_request)].filter(
    (b): b is string => typeof b === 'string',
  );

  // GitHub App usernames are like 'strategist-bot' (comments) or 'strategist-bot[bot]'
  // (author fields). We match the base name in `@name` mentions.
  for (const body of bodies) {
    const mentions = [...body.matchAll(/@([\w-]+)(\[bot\])?/g)].map((m) => m[1] as string);
    for (const username of mentions) {
      // Match against identities: bot_username without the [bot] suffix
      for (const id of reg.identities) {
        if (!id.github?.bot_username) continue;
        const baseName = id.github.bot_username.replace(/\[bot\]$/, '');
        if (baseName === username) return id.agent;
      }
    }
  }
  return undefined;
}

function getBody(obj: unknown): string | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const o = obj as { body?: unknown };
  return typeof o.body === 'string' ? o.body : undefined;
}

function extractLinearMention(reg: Registry, event: WebhookEvent): AgentId | undefined {
  const p = event.payload as { data?: unknown };
  if (typeof p.data !== 'object' || p.data === null) return undefined;
  const d = p.data as { body?: unknown; description?: unknown };
  const bodies = [d.body, d.description].filter((b): b is string => typeof b === 'string');

  for (const body of bodies) {
    // Linear mentions: @agent-handle or @user_uuid
    const mentions = [...body.matchAll(/@([\w-]+)/g)].map((m) => m[1] as string);
    for (const handle of mentions) {
      for (const id of reg.identities) {
        if (id.linear?.agent_handle === handle) return id.agent;
      }
    }
  }
  return undefined;
}
