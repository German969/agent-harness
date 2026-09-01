// Zod schema for identities/<agent>.yml.
// Placeholders in YAML files (bootstrap phase) come through as null. The schema
// tolerates them and downstream code decides whether a null blocks a given
// routing path (e.g. an agent with null GitHub App ID simply can't be matched
// via GitHub webhooks, but can still be matched via Linear/Slack).

import { z } from 'zod';
import type { AgentId } from '../types.js';

// Nullable string helpers — YAML `~` parses as null.
const nullableString = z.string().nullable().optional();
const nullableNumber = z.number().nullable().optional();

export const GithubIdentitySchema = z.object({
  app_slug: z.string(),
  app_id: z.union([z.number(), z.string(), z.null()]).optional(),
  bot_username: z.string(),
  installation_url: nullableString,
  installations: z.record(z.string(), z.union([z.number(), z.string(), z.null()])).optional(),
  default_pr_labels: z.array(z.string()).optional(),
  conditional_pr_labels: z.array(z.object({ label: z.string(), condition: z.string() })).optional(),
});

export const LinearIdentitySchema = z.object({
  agent_handle: z.string(),
  agent_id: nullableString,
  user_id: nullableString,
  webhook_id: nullableString,
});

export const SlackIdentitySchema = z.object({
  app_id: nullableString,
  bot_user_id: nullableString,
  team_id: nullableString,
  channels: z
    .object({
      primary: z.array(z.string()).optional(),
      alerts: z.string().optional(),
      crossposts: z.record(z.string(), z.string()).optional(),
      posts: z.array(z.string()).optional(),
    })
    .optional(),
});

export const RoutingRulesSchema = z.object({
  linear_labels: z.array(z.string()).optional(),
  slack_default_channels: z.array(z.string()).optional(),
  github_auto_triggers: z.array(z.string()).optional(),
});

// Values may be `~` (null) to declare that this agent deliberately has no such
// secret — see resolveSecrets. Mirrors the `~` placeholder convention the rest
// of the identity file already uses for absent IDs.
export const SecretsBlockSchema = z.record(z.string(), z.string().nullable());

export const IdentityFileSchema = z.object({
  agent: z.string(),
  github: GithubIdentitySchema.optional(),
  linear: LinearIdentitySchema.optional(),
  slack: SlackIdentitySchema.optional(),
  routing: RoutingRulesSchema.optional(),
  continuation_timeout_days: z.number().int().positive().default(30),
  secrets: SecretsBlockSchema.optional(),
});

export type IdentityFile = z.infer<typeof IdentityFileSchema>;

/** Validated identity with a narrowed AgentId type. */
export type Identity = IdentityFile & { agent: AgentId };

/** Guard: is this a known AgentId? */
export function isKnownAgent(id: string): id is AgentId {
  return [
    'strategist',
    'platform',
    'builder-server',
    'builder-client',
    'guardian',
    'marketer',
    'harness',
  ].includes(id);
}
