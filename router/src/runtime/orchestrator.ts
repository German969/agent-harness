// Top-level runtime orchestrator.
//
// Wires prepareSession → invokeSdk → completeSession into a single call so
// callers (the ingress consumer, the scheduler) can hand off a "prepared
// context" and get back a terminal status.
//
// This function is intentionally thin — most logic lives in the phase modules.
// Its job is:
//   1. Update the session row to `running` (after prep succeeds)
//   2. Trigger the SDK call
//   3. Run completion regardless of SDK outcome (guaranteed cleanup)
//   4. Return a summary

import type { AlertPoster } from '../observability/alerts.js';
import type { MetricsRegistry } from '../observability/metrics.js';
import type { SessionLogWriter } from '../observability/sessionLog.js';
import type { ReplyStreamer } from '../reply/streamer.js';
import type { SessionEnv } from '../secrets/types.js';
import { updateStatus } from '../state/sessions.js';
import type { PartialChunk, SdkClient } from './sdk.js';
import type { SessionOutcome } from './sdk.js';
import { invokeSdk } from './sdkCall.js';
import { type CompleteResult, completeSession } from './sessionComplete.js';
import { type PrepareOutcome, type PrepareRequest, prepareSession } from './sessionPrep.js';

/**
 * Factory that builds a ReplyStreamer once secrets have been resolved. Called
 * inside the runtime after `prepareSession` completes. Returns undefined when
 * the event has no reply surface (e.g. push events).
 */
export type ReplyStreamerFactory = (env: SessionEnv) => ReplyStreamer | undefined;

export type RunSessionOptions = PrepareRequest & {
  sdk: SdkClient;
  initialMessage: string;
  onPartial?: ((chunk: PartialChunk) => void) | undefined;
  /** Optional — enables cost-cap threshold warnings (Phase 8). */
  alertPoster?: AlertPoster | undefined;
  /** Optional — writes per-session jsonl trace lines. */
  sessionLog?: SessionLogWriter | undefined;
  /** Optional — builds a reply streamer once secrets are resolved. */
  buildReplyStreamer?: ReplyStreamerFactory | undefined;
  /** Optional — Prometheus counters/histograms updated at phase boundaries. */
  metrics?: MetricsRegistry | undefined;
  /** Display handle shown in the reply footer (e.g. `strategist-agent`).
   *  Falls back to `<agent>-agent` in the footer if not provided. */
  agentHandle?: string | undefined;
  /** Root of the continuation chain — passed to the reply footer so subsequent
   *  messages in the same thread share the same session number. Undefined for
   *  fresh sessions. */
  rootSessionId?: number | undefined;
  /** Additional context blocks (appended to hook-produced initialContext).
   *  Used to inject Slack thread history on continuation. */
  extraInitialContexts?: Array<{ content: string; tag?: string }> | undefined;
};

export type RunSessionResult =
  | { kind: 'refused'; refusal: Extract<PrepareOutcome, { kind: 'refused' }>['refusal'] }
  | { kind: 'setup_failed'; reason: string }
  | {
      kind: 'ran';
      outcome: SessionOutcome;
      completion: CompleteResult;
      totalCostUsd: number;
      turns: number;
    };

export async function runSession(opts: RunSessionOptions): Promise<RunSessionResult> {
  const startedAt = Date.now();
  opts.sessionLog?.write({
    ts: new Date().toISOString(),
    event: 'session.started',
    level: 'info',
    data: { agent: opts.agent, skill: opts.skill, trigger: opts.trigger.kind },
  });
  opts.metrics?.inFlight.inc();

  const emitOutcomeMetric = (outcome: string): void => {
    opts.metrics?.sessionTotal.inc({
      agent: opts.agent,
      skill: opts.skill ?? '',
      outcome,
    });
  };

  // ---- Prepare -----------------------------------------------------------
  const prep = await prepareSession(opts);
  if (prep.kind === 'refused') {
    const notes =
      prep.refusal.kind === 'cost_cap_hit'
        ? `cost_cap_hit: ${prep.refusal.monthToDateUsd}/${prep.refusal.monthlyCostUsd}`
        : `gated: ${prep.refusal.reason}`;
    updateStatus(opts.db, opts.sessionId, 'gated', { ended_at: Date.now(), notes });
    opts.sessionLog?.write({
      ts: new Date().toISOString(),
      event: 'session.refused',
      level: 'warn',
      data: { kind: prep.refusal.kind, notes },
    });
    emitOutcomeMetric('gated');
    opts.metrics?.inFlight.dec();
    return { kind: 'refused', refusal: prep.refusal };
  }
  if (prep.kind === 'setup_failed') {
    updateStatus(opts.db, opts.sessionId, 'failed', {
      ended_at: Date.now(),
      error_kind: 'setup_failed',
      notes: prep.reason,
    });
    opts.sessionLog?.write({
      ts: new Date().toISOString(),
      event: 'session.setup_failed',
      level: 'error',
      data: { reason: prep.reason },
    });
    emitOutcomeMetric('setup_failed');
    opts.metrics?.inFlight.dec();
    return { kind: 'setup_failed', reason: prep.reason };
  }

  const prepared = prep.prepared;

  // ---- Reply streamer (built after secrets resolve) ----------------------
  const streamer = opts.buildReplyStreamer?.(prepared.sessionEnv);
  const onPartial = streamer
    ? (chunk: PartialChunk): void => streamer.push(chunk.text)
    : opts.onPartial;

  // ---- Mark running ------------------------------------------------------
  updateStatus(opts.db, opts.sessionId, 'running', {
    ...(prepared.workspace?.path ? {} : {}),
  });

  // ---- SDK call ----------------------------------------------------------
  const sdkResult = await invokeSdk({
    sdk: opts.sdk,
    db: opts.db,
    agent: opts.agent,
    skill: opts.skill,
    sessionId: opts.sessionId,
    config: opts.config,
    prepared,
    ...(onPartial ? { onPartial } : {}),
    initialMessage: opts.initialMessage,
    perJobCostUsd: opts.config.settings.costCap.perJobCostUsd,
    ...(opts.alertPoster ? { alertPoster: opts.alertPoster } : {}),
    log: opts.log,
    ...(opts.sessionLog ? { sessionLog: opts.sessionLog } : {}),
    ...(opts.extraInitialContexts ? { extraInitialContexts: opts.extraInitialContexts } : {}),
  });

  // ---- Complete (always runs, even on error) -----------------------------
  const completion = await completeSession({
    db: opts.db,
    log: opts.log,
    sessionId: opts.sessionId,
    ctx: prepared.ctx,
    ...(prepared.workspace ? { workspace: prepared.workspace } : {}),
    outcome: sdkResult.outcome,
    sessionEndHooks: opts.config.settings.hooks?.SessionEnd ?? [],
    totalCostUsd: sdkResult.totalCostUsd,
    turns: sdkResult.turns,
  });

  // ---- Reply footer (after completion — footer needs final metrics) ------
  const durationMs = Date.now() - startedAt;
  if (streamer) {
    try {
      await streamer.finalize({
        agent: opts.agent,
        ...(opts.agentHandle ? { handle: opts.agentHandle } : {}),
        ...(opts.skill ? { skill: opts.skill } : {}),
        sessionId: opts.sessionId,
        ...(opts.rootSessionId ? { rootSessionId: opts.rootSessionId } : {}),
        durationMs,
        costUsd: sdkResult.totalCostUsd,
        outcome: sdkResult.outcome.kind,
      });
    } catch (err) {
      opts.log.warn(
        { sessionId: opts.sessionId, err: (err as Error).message },
        'reply streamer finalize failed',
      );
    }
  }

  // ---- Metrics + session log at completion -------------------------------
  emitOutcomeMetric(completion.status);
  opts.metrics?.sessionDuration.observe(
    { agent: opts.agent, skill: opts.skill ?? '' },
    durationMs / 1000,
  );
  opts.metrics?.sessionCost.inc({ agent: opts.agent }, sdkResult.totalCostUsd);
  opts.metrics?.inFlight.dec();
  opts.sessionLog?.write({
    ts: new Date().toISOString(),
    event: 'session.completed',
    level: 'info',
    data: {
      outcome: sdkResult.outcome.kind,
      status: completion.status,
      duration_ms: durationMs,
      turns: sdkResult.turns,
      cost_usd: sdkResult.totalCostUsd,
    },
  });

  return {
    kind: 'ran',
    outcome: sdkResult.outcome,
    completion,
    totalCostUsd: sdkResult.totalCostUsd,
    turns: sdkResult.turns,
  };
}
