// Session prep — per ARCHITECTURE.md §1.3 (Prepare).
//
// Order (each step depends on prior):
//   1. Cost-cap + founding-docs pre-flight (may refuse the session)
//   2. Workspace acquire (git worktree) — skipped when `acquireWorkspace: false`
//   3. Secrets resolve into a SessionEnv
//   4. MCP boot (stdio child processes)
//   5. Build SessionContext + return the prepared bundle
//
// The bundle carries everything downstream (sdkCall, sessionComplete) needs;
// callers do not re-fetch or re-compute derived state.

import type { Logger } from 'pino';
import { mintInstallationToken } from '../auth/github-app.js';
import type { AgentConfig } from '../config/index.js';
import type { HookEntry } from '../config/settingsSchema.js';
import type { SessionContext } from '../hooks/index.js';
import { type LinearOAuthCreds, getLinearAccessToken } from '../linear/oauthToken.js';
import type { AlertPoster } from '../observability/alerts.js';
import { resolveSecretsWithExtras } from '../secrets/resolver.js';
import type { IdentitySecretsBlock, SecretProvider, SessionEnv } from '../secrets/types.js';
import type { Db } from '../state/db.js';
import type { AgentId, SkillId, TriggerKind } from '../types.js';
import type { WorkspaceLease } from '../workspace/manager.js';
import { type ManagerConfig, acquireWorkspace } from '../workspace/manager.js';
import { gitSessionEnv } from './gitEnv.js';
import { type PreflightRefusal, runPreflight } from './preflight.js';

export type PrepareRequest = {
  agent: AgentId;
  skill?: SkillId | undefined;
  sessionId: number;
  claudeSessionId?: string | undefined;

  /** Loaded + cached AgentConfig (CLAUDE.md, settings, mcp, skills). */
  config: AgentConfig;

  /** Identity-file secrets block for this agent. */
  identitySecrets: IdentitySecretsBlock;

  /** Non-secret env vars merged into the session env alongside resolved secrets
   *  (e.g. SLACK_TEAM_ID, which the slack MCP references via `${SLACK_TEAM_ID}`
   *  but is public workspace config, not an Infisical secret). Secrets win on
   *  key collision. */
  extraEnv?: SessionEnv | undefined;

  /** Posts an alert when a SessionEnd hook fails in a way nobody would otherwise
   *  notice — see SessionContext.alertPoster. */
  alertPoster?: AlertPoster | undefined;

  /** Trigger + reply info threaded through hook context. */
  trigger: {
    kind: TriggerKind;
    provider?: 'github' | 'linear' | 'slack' | undefined;
    thread_key?: string | undefined;
    message?: string | undefined;
    /** Classifier match reason — threaded to SessionContext to gate
     *  human-command-only capabilities (e.g. Linear mutation tools). */
    match_reason?: string | undefined;
    /** Task id used for worktree path (PR number, ticket key, or synthetic). */
    task_id?: string | undefined;
  };

  /** Filesystem roots for placeholder resolution. */
  devTeamRoot: string;
  targetProjectRoot: string;
  projectName: string;

  /** Whether to acquire a git worktree (skip for read-only sessions). */
  acquireWorkspace: boolean;
  /** Only used when acquireWorkspace: true. */
  workspaceCfg?: ManagerConfig | undefined;
  workspaceSource?:
    | {
        sourceRepo: string;
        baseBranch: string;
      }
    | undefined;

  secretProvider: SecretProvider;

  /** When present + the identity has a github_app_private_key secret, the
   *  resolver mints a fresh GitHub App installation token and adds it to the
   *  session env as GITHUB_APP_INSTALLATION_TOKEN (consumed by the GitHub MCP). */
  githubApp?:
    | {
        appId: number;
        installationId: number;
      }
    | undefined;

  db: Db;
  log: Logger;
};

export type PreparedSession = {
  ctx: SessionContext;
  sessionEnv: SessionEnv;
  workspace?: WorkspaceLease | undefined;
  /** Contexts collected by SessionStart hooks — feed into SDK initial context. */
  initialContext: Array<{ content: string; tag?: string }>;
};

export type PrepareOutcome =
  | { kind: 'ok'; prepared: PreparedSession }
  | { kind: 'refused'; refusal: PreflightRefusal }
  | { kind: 'setup_failed'; reason: string };

export async function prepareSession(req: PrepareRequest): Promise<PrepareOutcome> {
  const settings = req.config.settings;
  const hooks = settings.hooks ?? {};

  // Build a *provisional* SessionContext for SessionStart hooks. workspaceDir
  // may not exist yet — hooks that need it (`git_commit`, etc.) run in
  // SessionEnd where a full workspace is guaranteed.
  const baseCtx: SessionContext = {
    agent: req.agent,
    skill: req.skill,
    sessionId: req.sessionId,
    claudeSessionId: req.claudeSessionId,
    workspaceDir: undefined,
    trigger: {
      kind: req.trigger.kind,
      ...(req.trigger.provider ? { provider: req.trigger.provider } : {}),
      ...(req.trigger.thread_key ? { thread_key: req.trigger.thread_key } : {}),
      ...(req.trigger.message ? { message: req.trigger.message } : {}),
      ...(req.trigger.match_reason ? { match_reason: req.trigger.match_reason } : {}),
    },
    env: {}, // populated after secrets resolve
    devTeamRoot: req.devTeamRoot,
    targetProjectRoot: req.targetProjectRoot,
    projectName: req.projectName,
    db: req.db,
    log: req.log,
    ...(req.alertPoster ? { alertPoster: req.alertPoster } : {}),
  };

  const sessionStartHooks: HookEntry[] = hooks.SessionStart ?? [];

  // ---- 1. Pre-flight ----------------------------------------------------
  const preflight = await runPreflight(req.db, req.agent, settings, sessionStartHooks, baseCtx);
  if (preflight.kind === 'refused') {
    return { kind: 'refused', refusal: preflight.refusal };
  }

  // ---- 2. Workspace -----------------------------------------------------
  let workspace: WorkspaceLease | undefined;
  if (req.acquireWorkspace) {
    if (!req.workspaceCfg || !req.workspaceSource || !req.trigger.task_id) {
      return {
        kind: 'setup_failed',
        reason:
          'acquireWorkspace: true but workspaceCfg / workspaceSource / trigger.task_id missing',
      };
    }
    const acq = await acquireWorkspace(req.db, req.workspaceCfg, {
      agent: req.agent,
      taskId: req.trigger.task_id,
      sessionId: req.sessionId,
      sourceRepo: req.workspaceSource.sourceRepo,
      baseBranch: req.workspaceSource.baseBranch,
    });
    if (!acq.ok) {
      return {
        kind: 'setup_failed',
        reason: `workspace acquire: ${acq.reason}${acq.message ? ` (${acq.message})` : ''}`,
      };
    }
    workspace = acq.lease;
  }

  // ---- 3. Secrets -------------------------------------------------------
  let sessionEnv: SessionEnv;
  try {
    sessionEnv = await resolveSecretsWithExtras(
      req.secretProvider,
      req.identitySecrets,
      req.extraEnv ?? {},
    );
  } catch (err) {
    if (workspace) await workspace.release();
    return {
      kind: 'setup_failed',
      reason: `secrets resolve: ${(err as Error).message}`,
    };
  }

  // Mint a fresh GitHub App installation token when both the identity has a
  // private key AND the caller supplied App metadata. Kept out of resolveSecrets
  // to keep that pure — this is a computation that depends on identity fields
  // beyond the `secrets:` block.
  if (req.githubApp && sessionEnv.GITHUB_APP_PRIVATE_KEY) {
    try {
      sessionEnv.GITHUB_APP_INSTALLATION_TOKEN = await mintInstallationToken({
        appId: req.githubApp.appId,
        privateKey: sessionEnv.GITHUB_APP_PRIVATE_KEY,
        installationId: req.githubApp.installationId,
      });
      req.log.info(
        {
          sessionId: req.sessionId,
          appId: req.githubApp.appId,
          installationId: req.githubApp.installationId,
        },
        'github app installation token minted',
      );
    } catch (err) {
      if (workspace) await workspace.release();
      return {
        kind: 'setup_failed',
        reason: `github app auth: ${(err as Error).message}`,
      };
    }
  } else {
    req.log.info(
      {
        sessionId: req.sessionId,
        hasGithubApp: Boolean(req.githubApp),
        hasPrivateKey: Boolean(sessionEnv.GITHUB_APP_PRIVATE_KEY),
      },
      'github app token NOT minted (missing config or key)',
    );
  }

  // Refresh the Linear actor=app access token when OAuth refresh is configured.
  // Linear's actor=app tokens expire every 24h; the manager mints a fresh one from
  // the rotating refresh token (persisted in the DB, shared across agents). Only
  // for identities that use Linear (LINEAR_TOKEN present); a non-refresh setup
  // (personal key, or refresh secrets absent) leaves the resolved token untouched.
  if (sessionEnv.LINEAR_TOKEN !== undefined) {
    const fresh = await maybeRefreshLinearToken(req.db, req.secretProvider, req.log);
    if (fresh) sessionEnv.LINEAR_TOKEN = fresh;
  }

  // Give the session's own git an author and, when we minted a token, a way to
  // authenticate to github. Neither exists in the container by default, so an agent
  // that wrote code could not commit it and could not push it. See runtime/gitEnv.ts
  // for why this is env rather than repo config. Placed after the mint so the token
  // is available, and applied unconditionally because identity is needed with or
  // without a worktree.
  Object.assign(sessionEnv, gitSessionEnv(req.agent, sessionEnv.GITHUB_APP_INSTALLATION_TOKEN));

  // ---- 4. Finalize SessionContext --------------------------------------
  // No MCP boot step: the Agent SDK spawns and owns MCP children itself, from the
  // configs runtime/sdkCall.ts resolves. The router previously ALSO spawned a copy
  // of every stdio server here and handed the handles to the adapter — which never
  // read them (SdkRunInputs.mcpServers had no consumer), so every session ran two
  // of each server, one of them idle from birth until teardown killed it.
  const ctx: SessionContext = {
    ...baseCtx,
    env: sessionEnv,
    ...(workspace ? { workspaceDir: workspace.path } : {}),
  };

  return {
    kind: 'ok',
    prepared: {
      ctx,
      sessionEnv,
      ...(workspace ? { workspace } : {}),
      initialContext: preflight.sessionStart.contexts,
    },
  };
}

/**
 * Mint a fresh Linear actor=app access token when the OAuth refresh secrets are
 * configured (LINEAR_OAUTH_CLIENT_ID/SECRET + LINEAR_REFRESH_TOKEN). Returns
 * undefined — leaving the statically-resolved LINEAR_TOKEN in place — when refresh
 * isn't configured or the refresh itself fails, so a Linear-auth problem never hard-
 * fails a session (the agent instead gets the Linear client's clear 401 if it tries).
 */
async function maybeRefreshLinearToken(
  db: Db,
  provider: SecretProvider,
  log: Logger,
): Promise<string | undefined> {
  let creds: LinearOAuthCreds;
  try {
    creds = {
      clientId: await provider.getSecret('LINEAR_OAUTH_CLIENT_ID'),
      clientSecret: await provider.getSecret('LINEAR_OAUTH_CLIENT_SECRET'),
      seedRefreshToken: await provider.getSecret('LINEAR_REFRESH_TOKEN'),
    };
  } catch {
    return undefined; // refresh not configured — keep the static LINEAR_TOKEN
  }
  try {
    return await getLinearAccessToken(db, creds, { log });
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      'linear oauth refresh failed; falling back to static LINEAR_TOKEN',
    );
    return undefined;
  }
}
