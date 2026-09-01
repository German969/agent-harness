// Routing registry — indexes identities into fast lookup tables.
// Rebuilt whenever identities are (re-)loaded from disk. Immutable snapshot;
// concurrent classifier reads are safe.

import type { AgentId, Provider } from '../types.js';
import type { Identity } from './schema.js';

export type Registry = {
  /** All loaded identities. */
  identities: readonly Identity[];

  /** GitHub App ID (as string) → agent id. */
  githubByAppId: ReadonlyMap<string, AgentId>;
  /** Linear webhook_id → agent id. */
  linearByWebhookId: ReadonlyMap<string, AgentId>;
  /** Linear agent_id → agent id (for assignment detection). */
  linearByAgentId: ReadonlyMap<string, AgentId>;
  /** Linear user_id → agent id (for assignment detection). */
  linearByUserId: ReadonlyMap<string, AgentId>;
  /** Slack app_id → agent id. */
  slackByAppId: ReadonlyMap<string, AgentId>;
  /** Slack bot_user_id → agent id (for @-mention detection). */
  slackByBotUserId: ReadonlyMap<string, AgentId>;

  /** Linear label → agent id (label-based routing). Multiple labels per agent. */
  labelToAgent: ReadonlyMap<string, AgentId>;
  /** Slack channel → agent id (channel-default routing). */
  slackChannelDefault: ReadonlyMap<string, AgentId>;
  /** GitHub event types that auto-fire per agent (e.g. 'pull_request.opened' → guardian). */
  githubAutoTriggers: ReadonlyMap<string, AgentId>;

  /** Direct lookup by agent id (identity file access). */
  byAgent: ReadonlyMap<AgentId, Identity>;
};

export function buildRegistry(identities: readonly Identity[]): Registry {
  const githubByAppId = new Map<string, AgentId>();
  const linearByWebhookId = new Map<string, AgentId>();
  const linearByAgentId = new Map<string, AgentId>();
  const linearByUserId = new Map<string, AgentId>();
  const slackByAppId = new Map<string, AgentId>();
  const slackByBotUserId = new Map<string, AgentId>();
  const labelToAgent = new Map<string, AgentId>();
  const slackChannelDefault = new Map<string, AgentId>();
  const githubAutoTriggers = new Map<string, AgentId>();
  const byAgent = new Map<AgentId, Identity>();

  for (const id of identities) {
    byAgent.set(id.agent, id);

    if (id.github?.app_id != null) {
      githubByAppId.set(String(id.github.app_id), id.agent);
    }
    if (id.linear?.webhook_id != null) {
      linearByWebhookId.set(id.linear.webhook_id, id.agent);
    }
    if (id.linear?.agent_id != null) {
      linearByAgentId.set(id.linear.agent_id, id.agent);
    }
    if (id.linear?.user_id != null) {
      linearByUserId.set(id.linear.user_id, id.agent);
    }
    if (id.slack?.app_id != null) {
      slackByAppId.set(id.slack.app_id, id.agent);
    }
    if (id.slack?.bot_user_id != null) {
      slackByBotUserId.set(id.slack.bot_user_id, id.agent);
    }

    for (const label of id.routing?.linear_labels ?? []) {
      // First-writer wins on label collisions. Curator should surface these in Phase 8.
      if (!labelToAgent.has(label)) labelToAgent.set(label, id.agent);
    }
    for (const channel of id.routing?.slack_default_channels ?? []) {
      if (!slackChannelDefault.has(channel)) slackChannelDefault.set(channel, id.agent);
    }
    for (const trigger of id.routing?.github_auto_triggers ?? []) {
      if (!githubAutoTriggers.has(trigger)) githubAutoTriggers.set(trigger, id.agent);
    }
  }

  return {
    identities,
    githubByAppId,
    linearByWebhookId,
    linearByAgentId,
    linearByUserId,
    slackByAppId,
    slackByBotUserId,
    labelToAgent,
    slackChannelDefault,
    githubAutoTriggers,
    byAgent,
  };
}

/** Lookup: which agent does this provider + hint identify? Used by ingress SecretLookup. */
export function findAgentByHint(
  reg: Registry,
  provider: Provider,
  hint: string,
): AgentId | undefined {
  switch (provider) {
    case 'github':
      return reg.githubByAppId.get(hint);
    case 'linear':
      return reg.linearByWebhookId.get(hint);
    case 'slack':
      return reg.slackByAppId.get(hint);
  }
}
