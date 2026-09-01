// Central configuration loader.
// Reads environment variables, validates them, exposes a typed config object.
// Per Phase 0 — only the bare minimum needed to boot. Later phases extend.

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  STATE_DB_PATH: z.string().default('/var/lib/agents/state.sqlite'),

  // Path to the dev-team repo root (contains agents/, identities/, scheduler/, router/).
  // Defaults to the parent of the router directory — useful for local dev where the
  // repo is checked out at ~/work/.../dev-team/router/.
  DEV_TEAM_ROOT: z.string().default('/var/lib/agents/dev-team'),

  // Path to the target-project repo root (where `<target-project>/founding/*`,
  // `docs/`, etc. live). Must be a real clone mounted into the container — agents
  // read house-style/founding docs from disk here at SessionStart. When unset it
  // falls back to DEV_TEAM_ROOT, which has no founding/ dir (so the founding gate
  // reports "Phase 0 not run" even when the docs exist in the target repo).
  TARGET_PROJECT_ROOT: z.string().optional(),

  // The `${PROJECT}` partition name used in dev-team-state paths + reply routing.
  // Set to the target project's name (e.g. the repo name) once agents work a real
  // project; defaults to 'dev-team' to preserve pre-multi-project behavior.
  PROJECT_NAME: z.string().default('dev-team'),

  // Per-task git worktrees (PLAN.md L214, ARCHITECTURE.md §2.3). Work sessions get
  // a writable checkout here; the target-project mirror itself stays read-only for
  // reading house style. Unset disables worktree acquisition entirely.
  WORKTREE_ROOT: z.string().default('/var/lib/agents/worktrees'),
  /** Branch new task worktrees are cut from. */
  TARGET_BASE_BRANCH: z.string().default('main'),

  // Restrict each session's built-in tools to the agent's `permissions.allow`
  // (via the SDK's `tools` option). `allow` was never a restriction — allowedTools
  // only skips the permission prompt — so this is the switch that makes the config
  // mean what it reads. On by default; set to 'false' to fall back to the previous
  // unrestricted behaviour without a code revert, which is what this exists for:
  // it is the first change in the permissions series that removes capability from
  // a running agent.
  TOOL_ALLOWLIST_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Per-session jsonl trace dir. Empty string disables the deep trace.
  SESSION_LOG_DIR: z.string().default('/var/log/agents/sessions'),

  // Anthropic API key — when set, the Anthropic SDK client is used instead of
  // the placeholder. Can also come from per-agent Infisical secrets at session time.
  ANTHROPIC_API_KEY: z.string().optional(),

  // Secrets — see src/secrets. Default `env` for dev/test; switch to `infisical` in prod.
  SECRETS_PROVIDER: z.enum(['env', 'infisical']).default('env'),
  INFISICAL_SITE_URL: z.string().optional(),
  INFISICAL_PROJECT_ID: z.string().optional(),
  INFISICAL_ENVIRONMENT: z.string().optional(),
  // Universal Auth (machine identity) — preferred.
  INFISICAL_CLIENT_ID: z.string().optional(),
  INFISICAL_CLIENT_SECRET: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail loud + fast on bad config. Better to crash at startup than serve with wrong settings.
  console.error('Invalid router config:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

export const PACKAGE_VERSION = '0.1.0';
