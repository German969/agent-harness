// Fastify server with health endpoints.
// Webhook routes land in Phase 3; metrics in Phase 10.

import { join } from 'node:path';
import sensible from '@fastify/sensible';
import Fastify from 'fastify';
import type { Logger } from 'pino';
import { PACKAGE_VERSION, config } from './config.js';
import { buildConsumer } from './consumer/index.js';
import { buildLabelRemover } from './github/ownerLabelGuard.js';
import { EventQueue } from './ingress/queue.js';
import { registerIngressRoutes } from './ingress/routes.js';
import {
  type AlertPoster,
  type MetricsRegistry,
  NoopAlertPoster,
  createMetrics,
  scrape,
} from './observability/index.js';
import {
  buildRegistry,
  buildSecretLookup,
  checkCrosspostsDrift,
  loadIdentities,
} from './routing/index.js';
import { AnthropicSdkClient, PlaceholderSdkClient, type SdkClient } from './runtime/index.js';
import { auditFleetModels } from './runtime/modelCheck.js';
import { type SecretProvider, createSecretProvider, pinoRedact } from './secrets/index.js';
import { initDb, markRunningAsInterruptedOnBoot } from './state/index.js';
import { pruneIdle } from './workspace/index.js';

/** How often to sweep for idle worktrees, and how long "idle" is. A worktree is a
 *  full checkout, so keeping one costs disk while reclaiming one too eagerly costs a
 *  re-clone on the next resume. A day of idleness is well past when a session would
 *  have come back for it. */
const WORKTREE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const WORKTREE_MAX_IDLE_MS = 24 * 60 * 60 * 1000;

const startedAt = Date.now();

/**
 * Load identities, waiting for the config volume to populate first. On a fresh boot
 * the router can come up before the git sidecar has cloned the dev-team repo into the
 * mounted volume, so `identities/` is momentarily empty — the registry is then built
 * with zero agents and every webhook 404s (`no_agent_matches_hint`) until a manual
 * restart. Poll until at least one identity loads, bounded by `maxWaitMs`. If none ever
 * appear we return the empty result and let boot continue, so /ready surfaces
 * `no_identities_loaded` rather than the process hanging forever.
 */
export async function loadIdentitiesWaiting(
  dir: string,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  maxWaitMs: number,
  pollMs = 2_000,
): Promise<ReturnType<typeof loadIdentities>> {
  const deadline = Date.now() + maxWaitMs;
  let result = loadIdentities(dir);
  let waited = false;
  while (result.identities.length === 0 && Date.now() < deadline) {
    waited = true;
    log.warn({ dir }, 'no identities loaded yet — waiting for the config volume to populate');
    await new Promise((r) => setTimeout(r, pollMs));
    result = loadIdentities(dir);
  }
  if (result.identities.length === 0) {
    log.error(
      { dir, maxWaitMs },
      'identities never populated within the wait window — starting with an empty registry (routing will 404 until the volume is fixed)',
    );
  } else if (waited) {
    log.info(
      { count: result.identities.length },
      'identities appeared after waiting for the config volume',
    );
  }
  return result;
}

export type BuildServerOverrides = {
  sdk?: SdkClient;
  alertPoster?: AlertPoster;
  targetProjectRoot?: string;
  projectName?: string;
  /** Override the SQLite path (tests). Falls back to config.STATE_DB_PATH. */
  dbPath?: string;
  /** Override the dev-team root (tests). Falls back to config.DEV_TEAM_ROOT. */
  devTeamRoot?: string;
  /** Inject a pre-built metrics registry (tests). Server creates its own by default. */
  metrics?: MetricsRegistry;
  /** Override the session-log directory. Falls back to config.SESSION_LOG_DIR. */
  sessionLogDir?: string;
  /** Max time (ms) to wait at boot for the identities volume to populate before
   *  building the registry. Default 60s; set 0 to skip waiting (tests/dev). */
  identitiesWaitMs?: number;
};

export async function buildServer(overrides: BuildServerOverrides = {}) {
  const isDev = config.NODE_ENV === 'development';

  const server = Fastify({
    logger: isDev
      ? {
          level: config.LOG_LEVEL,
          redact: pinoRedact,
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
          },
        }
      : { level: config.LOG_LEVEL, redact: pinoRedact },
    disableRequestLogging: false,
  });

  await server.register(sensible);

  // Phase 1: open DB + run migrations + recover interrupted sessions.
  const dbPath = overrides.dbPath ?? config.STATE_DB_PATH;
  const devTeamRoot = overrides.devTeamRoot ?? config.DEV_TEAM_ROOT;
  const db = initDb({ path: dbPath });
  const interrupted = markRunningAsInterruptedOnBoot(db);
  if (interrupted > 0) {
    server.log.warn({ count: interrupted }, 'marked stale running sessions as interrupted');
  }

  // Phase 2: pick a secret provider (env-backed for dev/test; Infisical for prod).
  const secretProvider = buildSecretProvider(server);

  // Phase 4: load identities + build routing registry + wire real SecretLookup.
  const identitiesDir = join(devTeamRoot, 'identities');
  const identitiesWaitMs = overrides.identitiesWaitMs ?? 60_000;
  const { identities, errors: identityErrors } = await loadIdentitiesWaiting(
    identitiesDir,
    server.log,
    identitiesWaitMs,
  );
  for (const e of identityErrors) {
    server.log.warn({ file: e.file, reason: e.reason }, 'identity file skipped');
  }
  server.log.info({ count: identities.length }, 'identities loaded');
  const registry = buildRegistry(identities);

  // Flag Harness crossposts-map drift (a stale map silently sends heads-ups to the
  // wrong channel; there's no CI gate on identity edits, so surface it in the log).
  for (const issue of checkCrosspostsDrift(identities)) {
    server.log.warn({ check: 'crossposts-drift' }, `identity consistency: ${issue}`);
  }

  // Flag any agent configured with a model the rate table cannot price. The cost
  // cap silently bills those at the most expensive known rate, so the agent gets
  // refused at a fraction of its budget — done at boot so a mispriced agent shows
  // up right after the deploy that introduced it, not at its first trigger.
  const unpriced = auditFleetModels(
    identities.map((i) => i.agent),
    devTeamRoot,
    server.log,
  );
  if (unpriced > 0) {
    server.log.warn(
      { check: 'model-rates', count: unpriced },
      'agents configured with unpriced models',
    );
  }

  // Phase 3: in-memory event queue + webhook ingress routes.
  const queue = new EventQueue();
  await registerIngressRoutes(server, {
    db,
    queue,
    resolveSecret: buildSecretLookup(registry, secretProvider),
  });

  // Phase 10: metrics registry + /metrics endpoint (built before consumer so
  // the consumer can receive it).
  const metrics = overrides.metrics ?? createMetrics();

  // Phase 12: consumer bridge — pulls verified events from the queue, classifies
  // them, and dispatches sessions via the runtime.
  // Use the real Anthropic SDK when:
  //  - a top-level ANTHROPIC_API_KEY is set (local dev), OR
  //  - SECRETS_PROVIDER=infisical (per-session key resolves from Infisical via
  //    the identity's secrets block).
  // Otherwise fall back to the placeholder so tests / bare boots fail loudly
  // rather than silently making live API calls.
  const anthropicOpts = config.ANTHROPIC_API_KEY ? { apiKey: config.ANTHROPIC_API_KEY } : {};
  const canUseRealSdk =
    Boolean(config.ANTHROPIC_API_KEY) || config.SECRETS_PROVIDER === 'infisical';
  const sdk =
    overrides.sdk ??
    (canUseRealSdk ? new AnthropicSdkClient(anthropicOpts) : new PlaceholderSdkClient());
  const alertPoster = overrides.alertPoster ?? new NoopAlertPoster();
  const targetProjectRoot =
    overrides.targetProjectRoot ?? config.TARGET_PROJECT_ROOT ?? devTeamRoot;
  const projectName = overrides.projectName ?? config.PROJECT_NAME;
  const sessionLogDir = overrides.sessionLogDir ?? config.SESSION_LOG_DIR;
  const consumer = buildConsumer({
    db,
    registry,
    secretProvider,
    sdk,
    // Fastify's log wraps pino; the shape is compatible at runtime, but the
    // type doesn't expose msgPrefix. Cast for the consumer interface.
    log: server.log as unknown as Logger,
    devTeamRoot,
    targetProjectRoot,
    projectName,
    alertPoster,
    removeLabel: buildLabelRemover(registry, secretProvider),
    ...(sessionLogDir ? { sessionLogDir } : {}),
    metrics,
    worktreeRoot: config.WORKTREE_ROOT,
    targetBaseBranch: config.TARGET_BASE_BRANCH,
  });
  queue.onEvent(consumer);
  server.get('/metrics', async (_req, reply) => {
    const body = await scrape(metrics);
    return reply.header('Content-Type', metrics.registry.contentType).status(200).send(body);
  });

  // Worktree GC. `pruneIdle` shipped with the workspace layer and its own comment
  // says "Called periodically by a cron worker (Phase 9)" — Phase 9 never wired it,
  // so nothing has ever removed a worktree. Each one is a full checkout of the
  // target project, created per task and never reclaimed, so the volume fills
  // quietly until some unrelated session fails on ENOSPC.
  //
  // Deliberately not a schedules.yml entry: that scheduler starts AGENT sessions,
  // and reclaiming disk is maintenance, not something worth paying a session to
  // reason about. A plain interval in the router does it for free.
  //
  // `pruneIdle` skips any worktree holding an active lease, so a running session
  // cannot have its checkout pulled out from under it.
  const pruneTimer = setInterval(() => {
    void pruneIdle({ db, sourceRepo: targetProjectRoot, maxIdleMs: WORKTREE_MAX_IDLE_MS })
      .then((res) => {
        // `attempted` counts only what was eligible, so a sweep that spared
        // everything reports zero — log on either, or worktrees held back for
        // unpushed work would accumulate silently.
        if (res.attempted > 0 || res.keptUnpushed) server.log.info({ ...res }, 'worktree prune');
      })
      .catch((err) => {
        server.log.warn({ err: (err as Error).message }, 'worktree prune failed');
      });
  }, WORKTREE_PRUNE_INTERVAL_MS);
  // A GC tick must never hold the process open.
  pruneTimer.unref();
  server.addHook('onClose', async () => clearInterval(pruneTimer));

  server.get('/health', () => ({
    ok: true,
    version: PACKAGE_VERSION,
    uptimeMs: Date.now() - startedAt,
  }));

  server.get('/ready', async (_req, reply) => {
    const dbReady = db.open;
    const secretsReady = secretProvider.kind === 'env' || secretProvider.kind === 'infisical';
    const routingReady = registry.identities.length > 0;
    const subsystems = {
      db: dbReady ? 'ready' : 'down',
      secrets: secretsReady ? `ready (${secretProvider.kind})` : `stub (${secretProvider.kind})`,
      routing: routingReady
        ? `ready (${registry.identities.length} identities)`
        : 'no_identities_loaded',
      ingress: `ready (queue depth: ${queue.size()})`,
      mcp: 'not_initialized', // Phase 6
    };
    const ready = dbReady && secretsReady && routingReady;
    return reply.status(ready ? 200 : 503).send({ ready, subsystems });
  });

  return server;
}

function buildSecretProvider(server: {
  log: { info: (obj: object, msg: string) => void };
}): SecretProvider {
  if (config.SECRETS_PROVIDER === 'infisical') {
    if (
      !config.INFISICAL_SITE_URL ||
      !config.INFISICAL_PROJECT_ID ||
      !config.INFISICAL_ENVIRONMENT ||
      !config.INFISICAL_CLIENT_ID ||
      !config.INFISICAL_CLIENT_SECRET
    ) {
      throw new Error(
        'SECRETS_PROVIDER=infisical requires INFISICAL_SITE_URL, INFISICAL_PROJECT_ID, INFISICAL_ENVIRONMENT, INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET',
      );
    }
    server.log.info(
      { provider: 'infisical', environment: config.INFISICAL_ENVIRONMENT },
      'secret provider initialized',
    );
    return createSecretProvider({
      kind: 'infisical',
      infisical: {
        siteUrl: config.INFISICAL_SITE_URL,
        projectId: config.INFISICAL_PROJECT_ID,
        environment: config.INFISICAL_ENVIRONMENT,
        clientId: config.INFISICAL_CLIENT_ID,
        clientSecret: config.INFISICAL_CLIENT_SECRET,
      },
    });
  }
  server.log.info({ provider: 'env' }, 'secret provider initialized');
  return createSecretProvider({ kind: 'env' });
}
