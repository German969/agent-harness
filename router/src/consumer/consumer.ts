// Consumer — the missing plumbing between the ingress queue + the runtime.
//
// Given a verified WebhookEvent, this:
//   1. Classifies the event → agent + skill + continuation decision
//   2. Looks up the identity file for the agent → identity.secrets block
//   3. Loads the agent config (CLAUDE.md + settings + mcp + skills)
//   4. Creates a `pending` session row
//   5. Invokes runSession (which owns prep → SDK → complete)
//   6. Records the outcome
//
// This lives in its own module (not `runtime/`) because it composes many
// modules; keeping it separate keeps the dependency graph shallow.

import type { Logger } from 'pino';
import type { AgentConfig } from '../config/index.js';
import { loadAgentConfig } from '../config/index.js';
import { type LabelRemover, enforceOwnerLabels } from '../github/ownerLabelGuard.js';
import type { WebhookEvent } from '../ingress/types.js';
import type { AlertPoster } from '../observability/index.js';
import type { MetricsRegistry } from '../observability/index.js';
import { openSessionLog } from '../observability/index.js';
import type { SessionLogWriter } from '../observability/index.js';
import { ReplyStreamer } from '../reply/index.js';
import type { Classification, Identity, Registry } from '../routing/index.js';
import { classify, isAgentAuthoredEvent, isWorkTrigger } from '../routing/index.js';
import { type SdkClient, runSession } from '../runtime/index.js';
import type { RunSessionResult } from '../runtime/index.js';
import type { SecretProvider } from '../secrets/index.js';
import { fetchSlackThread, formatThreadAsContext } from '../slack/threadHistory.js';
import {
  type Db,
  chainDepth,
  createSession,
  findArtifactOrigin,
  findRootSessionId,
  recordLink,
} from '../state/index.js';
import type { AgentId, TriggerKind } from '../types.js';
import type { ManagerConfig } from '../workspace/manager.js';
import { MAX_CHAIN_DEPTH, chainVia } from './chainGuard.js';
import { extractInitialMessage } from './extractMessage.js';
import { resolveReplyTarget } from './replyTarget.js';
import { taskIdFromThreadKey } from './taskId.js';

export type ConsumerDeps = {
  db: Db;
  registry: Registry;
  secretProvider: SecretProvider;
  sdk: SdkClient;
  log: Logger;
  devTeamRoot: string;
  targetProjectRoot: string;
  projectName: string;
  workspaceCfg?: ManagerConfig | undefined;
  alertPoster?: AlertPoster | undefined;
  /** Removes a spoofed `agent:*` owner label from a PR (HAR-21). Omit to only
   *  alert; routing ignores a spoofed label either way. */
  removeLabel?: LabelRemover | undefined;
  /** Optional — writes per-session jsonl to `<sessionLogDir>/<id>.jsonl`. */
  sessionLogDir?: string | undefined;
  /** Optional — metrics registry to update on webhook receive + session complete. */
  metrics?: MetricsRegistry | undefined;
  /** Base dir for per-task worktrees. Omit to disable worktree acquisition
   *  entirely — sessions then run read-only against the dev-team repo. */
  worktreeRoot?: string | undefined;
  /** Branch new task worktrees are cut from. Defaults to 'main'. */
  targetBaseBranch?: string | undefined;
};

export type ConsumerOutcome =
  | { kind: 'unmatched'; reason: string }
  | { kind: 'identity_missing'; agent: AgentId }
  | { kind: 'config_load_failed'; agent: AgentId; error: string }
  | { kind: 'loop_refused'; agent: AgentId; parentSessionId: number; depth: number }
  | { kind: 'dispatched'; sessionId: number; agent: AgentId; result: RunSessionResult };

/**
 * Build the consumer function that the EventQueue calls for each event.
 * Returns a function suitable for `queue.onEvent(consumer)`.
 */
export function buildConsumer(deps: ConsumerDeps): (event: WebhookEvent) => Promise<void> {
  return async (event: WebhookEvent): Promise<void> => {
    const outcome = await handleEvent(event, deps);
    logOutcome(deps.log, event, outcome);
  };
}

/**
 * Same as buildConsumer but exposes the outcome — tests use this to assert on
 * what happened.
 */
export async function handleEvent(
  event: WebhookEvent,
  deps: ConsumerDeps,
): Promise<ConsumerOutcome> {
  // HAR-21: take a spoofed owner label off the PR and alert. Runs before, and
  // independently of, classification, which already ignores such a label.
  await enforceOwnerLabels(event, {
    registry: deps.registry,
    log: deps.log,
    removeLabel: deps.removeLabel,
    alertPoster: deps.alertPoster,
  });

  const classification: Classification = classify(event, {
    registry: deps.registry,
    db: deps.db,
  });

  if (classification.route === 'unmatched') {
    deps.metrics?.webhookTotal.inc({ provider: event.provider, outcome: 'unmatched' });
    return { kind: 'unmatched', reason: classification.reason };
  }

  deps.metrics?.webhookTotal.inc({ provider: event.provider, outcome: 'dispatched' });

  const identity = deps.registry.byAgent.get(classification.agent);
  if (!identity) {
    return { kind: 'identity_missing', agent: classification.agent };
  }

  let config: AgentConfig;
  try {
    config = loadAgentConfig(classification.agent, {
      devTeamRoot: deps.devTeamRoot,
    });
  } catch (err) {
    return {
      kind: 'config_load_failed',
      agent: classification.agent,
      error: (err as Error).message,
    };
  }

  // Loop guard (ARCHITECTURE.md §3.1). A chain only grows through agent-authored
  // triggers; a human replying in the same thread starts a fresh one, so a long
  // conversation with a person never trips this.
  const sameThreadParent =
    classification.continuation.mode === 'continue'
      ? classification.continuation.parent_row_id
      : undefined;

  // Cross-thread hop. `findContinuation` matches on thread_key, so it only ever
  // finds a parent INSIDE one thread — and a ticket an agent creates is a new
  // thread, which restarted the depth count at zero. A fan-out built entirely
  // from agent-created tickets was therefore unbounded, which is exactly the
  // shape decomposition into subtasks makes easy to reach.
  //
  // The origin record is stronger evidence than the authorship heuristic can be:
  // we do not infer that an agent made this ticket, we recorded it at creation.
  // So it needs no isAgentAuthoredEvent gate — and must not have one, because a
  // Linear Issue.create carries neither a botActor nor our reply footer, so the
  // heuristic returns false for precisely the hop being guarded here.
  //
  // A ticket a HUMAN created has no origin row and is never affected. Someone
  // acting on an agent-created ticket can still inherit depth — but only once
  // agents have already chained five deep, where an alert is the right outcome.
  const crossThreadParent =
    sameThreadParent === undefined && classification.thread_key
      ? findArtifactOrigin(deps.db, classification.thread_key)?.session_id
      : undefined;

  const parentSessionId = sameThreadParent ?? crossThreadParent;
  const extendsAgentChain =
    parentSessionId !== undefined &&
    (crossThreadParent !== undefined || isAgentAuthoredEvent(deps.registry, event));

  if (parentSessionId !== undefined && extendsAgentChain) {
    // The child's depth is the parent's plus this hop — computed BEFORE the
    // session row exists, so nothing is created when we refuse.
    const depth = chainDepth(deps.db, parentSessionId) + 1;
    if (depth > MAX_CHAIN_DEPTH) {
      deps.metrics?.webhookTotal.inc({ provider: event.provider, outcome: 'loop_refused' });
      await postLoopAlert(deps, identity, classification.agent, event, parentSessionId, depth);
      return { kind: 'loop_refused', agent: classification.agent, parentSessionId, depth };
    }
  }

  // Create the session row before dispatch so the CLI can see it even if the
  // session dies mid-run.
  const triggerKind: TriggerKind = `webhook:${event.provider}` as TriggerKind;
  const sessionId = createSession(deps.db, {
    agent: classification.agent,
    ...(classification.skill ? { skill: classification.skill } : {}),
    thread_key: classification.thread_key ?? `unknown:${event.delivery_id}`,
    status: 'pending',
    triggered_by: triggerKind,
    trigger_payload: {
      provider: event.provider,
      event_type: event.event_type,
      delivery_id: event.delivery_id,
      // Truncated: the full payload is on the ingress-side webhooks table.
      match_reason: classification.match_reason,
    },
    ...(classification.continuation.mode === 'continue'
      ? { triggered_by_session_id: classification.continuation.parent_row_id }
      : {}),
  });

  // Link parent → child now that the child row exists (the FK needs it). Only
  // agent-authored hops are recorded, which is what makes chainDepth mean
  // "consecutive agent turns since a human last spoke".
  if (parentSessionId !== undefined && extendsAgentChain) {
    recordLink(deps.db, {
      parent_session_id: parentSessionId,
      child_session_id: sessionId,
      via: chainVia(event.provider, classification.match_reason, crossThreadParent !== undefined),
    });
  }

  // Workspace. A work trigger (ticket assigned/labelled, PR opened) gets a
  // writable worktree; a question does not. Without this a Builder has nowhere
  // to write at all — the target-project mirror is mounted read-only, so
  // `Write`, `git commit` and the whole build/test loop have no checkout to
  // land in, and a session can only ever narrate what it would have done.
  const workspace = buildWorkspaceRequest(deps, classification);

  const initialMessage = extractInitialMessage(event, {
    ...(identity.slack?.bot_user_id ? { slackBotUserId: identity.slack.bot_user_id } : {}),
  });

  // Open a per-session jsonl trace if a log dir was provided.
  let sessionLog: SessionLogWriter | undefined;
  if (deps.sessionLogDir) {
    try {
      sessionLog = openSessionLog({ logDir: deps.sessionLogDir, sessionId });
      deps.log.info({ sessionId, logDir: deps.sessionLogDir }, 'session deep-trace jsonl opened');
    } catch (err) {
      // Upgrade to error — without the deep trace we're debugging blind on any
      // "session completed silently" failure. Fix the underlying perm/mount
      // issue rather than swallowing it.
      deps.log.error(
        { sessionId, logDir: deps.sessionLogDir, err: (err as Error).message },
        'failed to open session jsonl — deep trace disabled for this session',
      );
    }
  }

  // Reply streamer factory — called by the runtime once secrets resolve.
  const buildReplyStreamer = (env: Readonly<Record<string, string>>) => {
    const target = resolveReplyTarget(event, env);
    if (!target) return undefined;
    return new ReplyStreamer({ target, log: deps.log });
  };

  // Slack thread history — on continuation, inject prior messages so the model
  // sees the same conversation the human sees. This is the router-side answer
  // to thread continuity (Anthropic's server-side `resume` is unreliable).
  // Non-Slack triggers + fresh sessions get an empty extras list.
  const extraInitialContexts = await maybeFetchSlackThreadHistory(
    event,
    classification,
    identity,
    deps,
  );

  // Non-secret workspace config the slack MCP needs (`${SLACK_TEAM_ID}`). Without
  // it the MCP env resolver can't resolve the placeholder and skips the slack
  // server every session (followup #4). Sourced from the identity's slack block.
  const extraEnv: Record<string, string> = {};
  const slackTeamId = identity.slack?.team_id;
  if (typeof slackTeamId === 'string' && slackTeamId.length > 0) {
    extraEnv.SLACK_TEAM_ID = slackTeamId;
  }

  const result = await runSession({
    agent: classification.agent,
    sessionId,
    config,
    identitySecrets: identity.secrets ?? {},
    extraEnv,
    trigger: {
      kind: triggerKind,
      provider: event.provider,
      ...(classification.thread_key ? { thread_key: classification.thread_key } : {}),
      ...(workspace.acquireWorkspace ? { task_id: workspace.taskId } : {}),
      message: initialMessage,
      match_reason: classification.match_reason,
    },
    devTeamRoot: deps.devTeamRoot,
    targetProjectRoot: deps.targetProjectRoot,
    projectName: deps.projectName,
    ...workspace,
    ...(deps.workspaceCfg ? { workspaceCfg: deps.workspaceCfg } : {}),
    secretProvider: deps.secretProvider,
    db: deps.db,
    log: deps.log,
    sdk: deps.sdk,
    initialMessage,
    ...(classification.continuation.mode === 'continue'
      ? {
          claudeSessionId: classification.continuation.claude_session_id,
          rootSessionId: findRootSessionId(deps.db, classification.continuation.parent_row_id),
        }
      : {}),
    ...(deps.alertPoster ? { alertPoster: deps.alertPoster } : {}),
    ...(sessionLog ? { sessionLog } : {}),
    ...(classification.skill ? { skill: classification.skill } : {}),
    // Display handle for the reply footer — prefer GitHub bot_username (most
    // universally readable), fall back to Linear agent_handle. Both default to
    // `<agent>-agent` in the footer if neither is set.
    ...(identity.github?.bot_username
      ? { agentHandle: identity.github.bot_username }
      : identity.linear?.agent_handle
        ? { agentHandle: identity.linear.agent_handle }
        : {}),
    ...buildGithubAppOptions(identity),
    ...(extraInitialContexts.length > 0 ? { extraInitialContexts } : {}),
    buildReplyStreamer,
    ...(deps.metrics ? { metrics: deps.metrics } : {}),
  });

  return { kind: 'dispatched', sessionId, agent: classification.agent, result };
}

/**
 * Build the `githubApp` option for runSession when the identity has both a
 * numeric GitHub App id AND at least one numeric installation id under any key
 * (Harness installs on `dev_team_repo`, Strategist on `target_project`, future
 * agents may use other keys). When either is missing or non-numeric (placeholder
 * `~`), returns an empty object so the spread is a no-op — the agent runs
 * without GitHub App auth.
 */
function buildGithubAppOptions(
  identity: Identity,
): { githubApp: { appId: number; installationId: number } } | Record<string, never> {
  const rawAppId = identity.github?.app_id;
  const appId = typeof rawAppId === 'number' ? rawAppId : Number(rawAppId);
  if (!Number.isFinite(appId)) return {};

  const installations = identity.github?.installations ?? {};
  for (const raw of Object.values(installations)) {
    const installationId = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(installationId)) {
      return { githubApp: { appId, installationId } };
    }
  }
  return {};
}

/**
 * On Slack continuation events, fetch prior thread messages via
 * conversations.replies and format as a `<slack_thread_history>` context block.
 * Returns an empty array for non-Slack triggers, fresh sessions, or when the
 * fetch fails — better to run without history than to crash.
 */
async function maybeFetchSlackThreadHistory(
  event: WebhookEvent,
  classification: Extract<Classification, { route: 'agent' }>,
  identity: Identity,
  deps: ConsumerDeps,
): Promise<Array<{ content: string; tag?: string }>> {
  if (event.provider !== 'slack') return [];
  if (classification.continuation.mode !== 'continue') return [];

  const payload = event.payload as {
    event?: { channel?: unknown; thread_ts?: unknown; ts?: unknown };
  };
  const slackEvent = payload.event;
  if (!slackEvent) return [];
  const channel = typeof slackEvent.channel === 'string' ? slackEvent.channel : undefined;
  const thread_ts =
    typeof slackEvent.thread_ts === 'string'
      ? slackEvent.thread_ts
      : typeof slackEvent.ts === 'string'
        ? slackEvent.ts
        : undefined;
  const currentTs = typeof slackEvent.ts === 'string' ? slackEvent.ts : undefined;
  if (!channel || !thread_ts) return [];

  const tokenName = identity.secrets?.slack_bot_token;
  if (!tokenName) return [];

  try {
    const botToken = await deps.secretProvider.getSecret(tokenName);
    const messages = await fetchSlackThread({
      botToken,
      channel,
      thread_ts,
      log: deps.log,
    });
    const content = formatThreadAsContext(messages, { currentTs });
    if (!content) return [];
    deps.log.info(
      {
        agent: classification.agent,
        thread_ts,
        messages: messages.length,
        contextChars: content.length,
      },
      'slack thread history injected as initial context',
    );
    return [{ content, tag: 'slack_thread_history' }];
  } catch (err) {
    // Non-fatal — session runs without thread history rather than crashing.
    deps.log.warn(
      { agent: classification.agent, thread_ts, err: (err as Error).message },
      'slack thread history fetch failed — session runs without prior context',
    );
    return [];
  }
}

/**
 * Whether this session gets a writable worktree, and the config to build it.
 *
 * Acquire for a work trigger with a stable thread to key on; skip otherwise. A
 * question does not need a checkout, and a session with no thread has nothing
 * stable to name one after — two events about the same ticket must land on ONE
 * worktree, not two.
 *
 * `worktreeRoot` unset disables acquisition entirely, which is what tests and a
 * router deployed without the worktree volume want.
 */
function buildWorkspaceRequest(
  deps: ConsumerDeps,
  classification: Extract<Classification, { route: 'agent' }>,
):
  | { acquireWorkspace: false }
  | {
      acquireWorkspace: true;
      taskId: string;
      workspaceCfg: ManagerConfig;
      workspaceSource: { sourceRepo: string; baseBranch: string };
    } {
  if (!deps.worktreeRoot) return { acquireWorkspace: false };
  if (!isWorkTrigger(classification.match_reason)) return { acquireWorkspace: false };
  const taskId = taskIdFromThreadKey(classification.thread_key);
  if (!taskId) return { acquireWorkspace: false };
  return {
    acquireWorkspace: true,
    taskId,
    workspaceCfg: { root: deps.worktreeRoot },
    workspaceSource: {
      sourceRepo: deps.targetProjectRoot,
      baseBranch: deps.targetBaseBranch ?? 'main',
    },
  };
}

/**
 * `coordination_loop_suspected` — the alert ARCHITECTURE.md §3.1 names. Posted to
 * the agent's configured alerts channel so a refused chain is visible rather than
 * silently dropped; a refusal with nobody watching looks identical to an agent
 * that simply stopped answering.
 */
async function postLoopAlert(
  deps: ConsumerDeps,
  identity: Identity,
  agent: AgentId,
  event: WebhookEvent,
  parentSessionId: number,
  depth: number,
): Promise<void> {
  if (!deps.alertPoster) return;
  // Split across locals rather than concatenating: Biome's useTemplate fix for a
  // concatenation is classed unsafe here because it would emit one ~150-char line.
  const what = `Refused to start a session for ${agent}.`;
  const why = `It would be hop ${depth} of an agent-to-agent chain with no human turn`;
  const cap = `in between (cap ${MAX_CHAIN_DEPTH}). Nothing was dispatched;`;
  const fix = 'a human replying on this thread clears the chain.';
  try {
    await deps.alertPoster.post({
      agent,
      channel: identity.slack?.channels?.alerts ?? '#agents-alerts',
      level: 'error',
      title: 'coordination_loop_suspected',
      body: `${what} ${why} ${cap} ${fix}`,
      fields: {
        provider: event.provider,
        event_type: event.event_type,
        delivery_id: event.delivery_id,
        parent_session_id: parentSessionId,
        depth,
        max_depth: MAX_CHAIN_DEPTH,
      },
    });
  } catch (err) {
    // The refusal already happened and is the part that matters — a failed alert
    // must not turn into a thrown error that the queue reports as a crash.
    deps.log.error(
      { agent, err: (err as Error).message },
      'coordination_loop_suspected alert failed to post',
    );
  }
}

function logOutcome(log: Logger, event: WebhookEvent, outcome: ConsumerOutcome): void {
  const base = {
    provider: event.provider,
    delivery_id: event.delivery_id,
    event_type: event.event_type,
  };
  switch (outcome.kind) {
    case 'unmatched':
      log.info({ ...base, reason: outcome.reason }, 'event unmatched — no agent dispatched');
      break;
    case 'identity_missing':
      log.error(
        { ...base, agent: outcome.agent },
        'classifier matched an agent with no loaded identity',
      );
      break;
    case 'config_load_failed':
      log.error(
        { ...base, agent: outcome.agent, err: outcome.error },
        'agent config load failed — session not dispatched',
      );
      break;
    case 'loop_refused':
      log.error(
        {
          ...base,
          agent: outcome.agent,
          parentSessionId: outcome.parentSessionId,
          depth: outcome.depth,
          maxDepth: MAX_CHAIN_DEPTH,
        },
        'coordination loop suspected — session refused',
      );
      break;
    case 'dispatched':
      log.info(
        {
          ...base,
          agent: outcome.agent,
          sessionId: outcome.sessionId,
          resultKind: outcome.result.kind,
        },
        'session dispatched',
      );
      break;
  }
}
