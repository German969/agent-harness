// Zod schema for agents/<agent>/settings.json.
//
// The schema is intentionally LENIENT on hook-config internals — Phase 6a only
// needs the config to parse safely. Phase 6b's hook handler registry validates
// each command's own arguments when that command executes.

import { z } from 'zod';

// Cost-cap configuration. Every agent has one.
export const CostCapSchema = z.object({
  _comment: z.string().optional(),
  perJobCostUsd: z.number().nonnegative(),
  perJobTokens: z.number().int().positive().optional(),
  monthlyCostUsd: z.number().nonnegative(),
  monthlyTokensApprox: z.number().int().positive().optional(),
  warnAtPercent: z.number().int().min(0).max(100).optional().default(80),
  alertChannel: z.string().optional(),
  onCapReached: z.enum(['refuse_session', 'throttle', 'alert_only']).default('refuse_session'),
  offHoursThrottling: z.unknown().optional().nullable(),
});

// Thinking budget (extended thinking / reasoning tokens).
export const ThinkingSchema = z.object({
  type: z.literal('enabled'),
  budget_tokens: z.number().int().positive(),
});

// Permissions block — allow / ask / deny + defaultMode.
export const PermissionsSchema = z.object({
  allow: z.array(z.string()).default([]),
  ask: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  defaultMode: z.enum(['default', 'strict']).optional().default('default'),
});

// Write-scope block — path allow/deny lists.
export const WriteScopeSchema = z.object({
  _comment: z.string().optional(),
  allowedPaths: z.array(z.string()).default([]),
  deniedPaths: z.array(z.string()).default([]),
});

// Hooks are open-shaped — each entry has a `command` string plus arbitrary
// command-specific fields. Phase 6b validates per-command. Phase 6a just checks
// the outer array structure.
export const HookEntrySchema = z
  .object({
    command: z.string().optional(),
    _comment: z.string().optional(),
  })
  .passthrough();

export const HooksSchema = z
  .object({
    SessionStart: z.array(HookEntrySchema).optional().default([]),
    PreToolUse: z.array(HookEntrySchema).optional().default([]),
    PostToolUse: z.array(HookEntrySchema).optional().default([]),
    SessionEnd: z.array(HookEntrySchema).optional().default([]),
  })
  .optional()
  .default({});

export const AgentSettingsSchema = z
  .object({
    $schema: z.string().optional(),
    _comment: z.string().optional(),
    model: z.string(),
    modelOverrides: z.record(z.string(), z.string()).optional().default({}),
    thinking: ThinkingSchema.optional(),
    max_turns: z.number().int().positive().default(30),
    costCap: CostCapSchema,
    permissions: PermissionsSchema,
    writeScope: WriteScopeSchema,
    hooks: HooksSchema,
    _implementationNotes: z.unknown().optional(),
  })
  .passthrough();

export type AgentSettings = z.infer<typeof AgentSettingsSchema>;
export type HookEntry = z.infer<typeof HookEntrySchema>;

/**
 * Resolve the model to use for a session. If a skill is provided and has an
 * override in settings.modelOverrides, use the override. Otherwise, use the
 * agent's default model.
 */
export function resolveModel(settings: AgentSettings, skill?: string): string {
  if (skill && settings.modelOverrides && settings.modelOverrides[skill]) {
    return settings.modelOverrides[skill];
  }
  return settings.model;
}

// ---------------------------------------------------------------------------
// MCP config schema — agents/<agent>/mcp.json
// ---------------------------------------------------------------------------

// An MCP server entry. Two supported transports:
//   - `type: 'stdio'` — router spawns a child process (npx / node / any command).
//     Config fields: `command`, `args`, `env`.
//   - `type: 'http'` — the Anthropic SDK connects to a remote HTTP MCP endpoint
//     (e.g. GitHub's api.githubcopilot.com/mcp/). No child process is spawned by
//     the router; the SDK owns the connection.
//     Config fields: `url`, `headers`.
//
// Both variants accept `${VAR}` placeholders — resolved against sessionEnv at
// session prep time via resolveMcpEnv().
export const McpStdioServerSchema = z
  .object({
    _comment: z.string().optional(),
    _TBD_in_phase_6: z.boolean().optional(),
    _TBD_during_router_impl: z.boolean().optional(),
    type: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  })
  .passthrough();

export const McpHttpServerSchema = z
  .object({
    _comment: z.string().optional(),
    type: z.literal('http'),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).default({}),
  })
  .passthrough();

export const McpServerSchema = z.discriminatedUnion('type', [
  McpStdioServerSchema,
  McpHttpServerSchema,
]);

// mcp.json can also have documentation-only fields (starting with '_').
// Real MCP servers are top-level keys under `mcpServers` that don't start with '_'.
export const McpConfigSchema = z
  .object({
    _comment: z.string().optional(),
    mcpServers: z.record(z.string(), z.unknown()),
    _future_mcp_candidates: z.unknown().optional(),
    _toolbelt_audit_checklist: z.unknown().optional(),
  })
  .passthrough();

export type McpConfig = z.infer<typeof McpConfigSchema>;

/**
 * True when an mcp.json server entry should boot for the given skill. A server
 * may declare `only_skills: [...]` to load only for those skills (per-skill MCP
 * gating — keeps a lightweight skill like `conversational` from paying to load
 * tool schemas it never uses). Absent `only_skills` → always boots.
 */
export function serverAllowsSkill(cfg: unknown, skill: string | undefined): boolean {
  const only = (cfg as { only_skills?: unknown })?.only_skills;
  if (!Array.isArray(only)) return true;
  return skill !== undefined && only.includes(skill);
}

/**
 * Extract the MCP servers that should actually be booted for a session.
 * Filters out entries prefixed with `_` (placeholders and documentation),
 * entries gated to other skills via `only_skills`, and entries that fail
 * McpServerSchema (bad shape — logged separately).
 *
 * Returns a map { name → validated server config }.
 */
export function activeServers(
  mcp: McpConfig,
  skill?: string,
): Map<string, z.infer<typeof McpServerSchema>> {
  const out = new Map<string, z.infer<typeof McpServerSchema>>();
  for (const [name, cfg] of Object.entries(mcp.mcpServers)) {
    if (name.startsWith('_')) continue;
    if (!serverAllowsSkill(cfg, skill)) continue;
    const parsed = McpServerSchema.safeParse(cfg);
    if (parsed.success) out.set(name, parsed.data);
  }
  return out;
}
