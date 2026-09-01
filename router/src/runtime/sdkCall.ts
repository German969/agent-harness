// Invokes the SDK with prepared inputs.
//
// The runtime provides three callbacks:
//   - onPartial     — streamed text chunks flow to a reply-layer callback
//   - onToolCall    — bridges the SDK's tool-call events to PreToolUse hooks
//   - onTurnComplete — records per-turn cost + checks per-job cap
//
// PostToolUse hooks are not intercepted by the SDK's event stream (they're
// side-effect / observation hooks) — the runtime runs them post-hoc as part of
// `sessionComplete`. This matches ARCHITECTURE.md §2.11's PostToolUse semantics
// (side-effect, not gate).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { config } from '../config.js';
import type { AgentConfig } from '../config/index.js';
import { activeServers, resolveModel, serverAllowsSkill } from '../config/settingsSchema.js';
import { runToolCallPhase } from '../hooks/index.js';
import type { SessionContext, ToolCallContext } from '../hooks/index.js';
import { pickChildBaseEnv, resolveMcpEnv } from '../mcp/env.js';
import type { AlertPoster } from '../observability/alerts.js';
import type { SessionLogWriter } from '../observability/sessionLog.js';
import { recordArtifactOrigin } from '../state/artifact_origin.js';
import { recordTurnCost } from '../state/cost.js';
import type { Db } from '../state/db.js';
import { addTurnCost } from '../state/sessions.js';
import type { AgentId } from '../types.js';
import { checkCapWarnings } from './capWarnings.js';
import { effectiveDeniedTools } from './fleetDeniedTools.js';
import { warnIfUnpricedModel } from './modelCheck.js';
import type {
  PartialChunk,
  PreToolUseDecision,
  SdkCallbacks,
  SdkClient,
  SdkRunInputs,
  SessionOutcome,
  ToolCallDescriptor,
  TurnCost,
  TurnDecision,
} from './sdk.js';
import type { PreparedSession } from './sessionPrep.js';
import { builtinToolsFrom } from './toolAllowlist.js';

export type SdkCallOptions = {
  sdk: SdkClient;
  db: Db;
  agent: AgentId;
  sessionId: number;
  config: AgentConfig;
  prepared: PreparedSession;
  /** Reply callback — the reply streamer (Phase 7) plugs into here. */
  onPartial?: ((chunk: PartialChunk) => void) | undefined;
  /** Initial user message (from the trigger). */
  initialMessage: string;
  /** Per-job cap check: when session's cost_usd exceeds this, cancel. */
  perJobCostUsd: number;
  /** Optional alert poster — used to emit cost-cap threshold warnings. */
  alertPoster?: AlertPoster | undefined;
  /** Optional logger — falls back to the prepared session's context logger. */
  log?: Logger | undefined;
  /** Optional skill name — used for model override resolution. */
  skill?: string | undefined;
  /** Optional per-session jsonl writer — used to trace per-turn token/cost so
   *  cache write-vs-read behavior is visible per turn (the sessions table only
   *  stores the session sum). */
  sessionLog?: SessionLogWriter | undefined;
  /** Additional context blocks (appended to hook-produced initialContext).
   *  Used by the consumer to inject Slack thread history on continuation. */
  extraInitialContexts?: Array<{ content: string; tag?: string }> | undefined;
};

export type SdkCallResult = {
  outcome: SessionOutcome;
  /** Total cost recorded across all turns of this call. */
  totalCostUsd: number;
  turns: number;
};

export async function invokeSdk(opts: SdkCallOptions): Promise<SdkCallResult> {
  const settings = opts.config.settings;
  const inProcessMcp = collectInProcessMcp(opts.config, opts.skill);
  const gatedLinearMutations = linearGatedAllowed(
    opts.config,
    opts.prepared.ctx.trigger.match_reason,
  );
  // The effective model, after any skill override. Warn here rather than at
  // config load: this is the only point that knows which override actually won.
  const model = resolveModel(settings, opts.skill);
  warnIfUnpricedModel(model, opts.log ?? opts.prepared.ctx.log, {
    agent: opts.prepared.ctx.agent,
    ...(opts.skill ? { skill: opts.skill } : {}),
    sessionId: opts.sessionId,
  });

  const inputs: SdkRunInputs = {
    agent: opts.prepared.ctx.agent,
    model,
    systemPrompt: opts.config.claudeMd,
    initialContext: [...opts.prepared.initialContext, ...(opts.extraInitialContexts ?? [])],
    initialMessage: opts.initialMessage,
    maxTurns: settings.max_turns,
    allowedTools: settings.permissions.allow,
    // The fleet-wide denials come first and are not overridable from agent config:
    // permissions.deny is the only field that actually restricts, and the tools on
    // that list start work the router cannot see. See fleetDeniedTools.ts.
    deniedTools: effectiveDeniedTools(settings.permissions.deny),
    // `allow` becomes a real restriction only through `tools`; allowedTools alone
    // just skips the prompt. Behind a config flag because this is the first change
    // in the series that takes capability away from a running agent.
    ...(config.TOOL_ALLOWLIST_ENABLED
      ? { builtinTools: builtinToolsFrom(settings.permissions.allow) }
      : {}),
    ...(settings.thinking?.budget_tokens
      ? { thinkingBudget: settings.thinking.budget_tokens }
      : {}),
    mcpServersConfig: buildMcpServersConfig(
      opts.config,
      opts.prepared.sessionEnv,
      opts.log ?? opts.prepared.ctx.log,
      opts.skill,
    ),
    ...(inProcessMcp.length > 0 ? { inProcessMcp } : {}),
    ...(gatedLinearMutations ? { gatedLinearMutations: true } : {}),
    // Attribute any ticket this session creates back to it, so the loop guard can
    // follow a chain across the thread boundary a new ticket opens.
    onIssueCreated: (threadKey: string) =>
      recordArtifactOrigin(opts.db, { thread_key: threadKey, session_id: opts.sessionId }),
    env: opts.prepared.sessionEnv,
    log: opts.log ?? opts.prepared.ctx.log,
    // Anchor the SDK's Read/Grep/Glob/Bash somewhere useful — without this,
    // tools operate against /app (the router install dir), leaving agents
    // unable to see the code they're supposed to reason about.
    //
    // A work session that leased a worktree stands IN that worktree: it is the
    // only writable checkout of the target project, so `Write`/`Edit`/`git
    // commit` have to land there. Everything else stands in the dev-team repo.
    cwd: sessionCwd(opts.prepared),
    additionalDirectories: readableDirs(opts.prepared.ctx, sessionCwd(opts.prepared)),
    ...(opts.prepared.ctx.claudeSessionId
      ? { claudeSessionId: opts.prepared.ctx.claudeSessionId }
      : {}),
  };

  let totalCostUsd = 0;
  let turns = 0;
  const preToolUseEntries = settings.hooks?.PreToolUse ?? [];

  const callbacks: SdkCallbacks = {
    onPartial: (chunk) => opts.onPartial?.(chunk),

    onToolCall: async (call: ToolCallDescriptor): Promise<PreToolUseDecision> =>
      dispatchPreToolUse(call, opts.prepared.ctx, preToolUseEntries),

    onTurnComplete: async (turn: TurnCost): Promise<TurnDecision> => {
      // Emit a paragraph break at the end of each assistant turn so successive
      // turns render as separate paragraphs in Slack/Linear instead of running
      // together into one wall of text. onPartial is the reply-streamer bridge.
      opts.onPartial?.({ text: '\n\n' });
      turns++;
      totalCostUsd += turn.cost_usd;
      // Persist per-turn cost to both tables so /ready + cost reports agree.
      recordTurnCost(opts.db, opts.agent, {
        cost_usd: turn.cost_usd,
        input_tokens: turn.input_tokens,
        cache_write_tokens: turn.cache_write_tokens,
        cache_read_tokens: turn.cache_read_tokens,
        output_tokens: turn.output_tokens,
      });
      addTurnCost(opts.db, opts.sessionId, {
        cost_usd: turn.cost_usd,
        input_tokens: turn.input_tokens,
        cache_write_tokens: turn.cache_write_tokens,
        cache_read_tokens: turn.cache_read_tokens,
        output_tokens: turn.output_tokens,
      });
      // Per-turn token trace. The sessions table only keeps the session sum, which
      // hides the write-vs-read pattern across turns (e.g. a cold prefix rewritten
      // every turn vs. read from cache). Emit each turn so cost analysis has it.
      opts.sessionLog?.write({
        ts: new Date().toISOString(),
        event: 'turn.cost',
        level: 'info',
        data: {
          turn: turns,
          cost_usd: turn.cost_usd,
          input_tokens: turn.input_tokens,
          cache_write_tokens: turn.cache_write_tokens,
          cache_read_tokens: turn.cache_read_tokens,
          output_tokens: turn.output_tokens,
        },
      });
      // Cost-cap threshold warnings (Phase 8). Non-fatal — errors here don't
      // affect the SDK loop.
      if (opts.alertPoster && settings.costCap.alertChannel) {
        try {
          await checkCapWarnings(
            opts.db,
            {
              agent: opts.agent,
              monthlyCostUsd: settings.costCap.monthlyCostUsd,
              warnAtPercent: settings.costCap.warnAtPercent ?? 80,
              alertChannel: settings.costCap.alertChannel,
            },
            opts.alertPoster,
            opts.log ?? opts.prepared.ctx.log,
          );
        } catch (err) {
          (opts.log ?? opts.prepared.ctx.log).warn(
            { err: (err as Error).message },
            'cap warning check threw — continuing session',
          );
        }
      }
      if (opts.perJobCostUsd > 0 && totalCostUsd > opts.perJobCostUsd) {
        return {
          kind: 'cancel',
          reason: `per_job_cap_exceeded (${totalCostUsd.toFixed(4)} > ${opts.perJobCostUsd})`,
        };
      }
      return { kind: 'continue' };
    },
  };

  const outcome = await opts.sdk.runSession(inputs, callbacks);
  return { outcome, totalCostUsd, turns };
}

/**
 * Bridge from an SDK ToolCallDescriptor to the router's PreToolUse hooks.
 * Runs every configured PreToolUse entry through the orchestrator; first deny wins.
 */
async function dispatchPreToolUse(
  call: ToolCallDescriptor,
  ctx: SessionContext,
  entries: readonly unknown[],
): Promise<PreToolUseDecision> {
  const toolCtx: ToolCallContext = {
    ...ctx,
    tool: call.tool,
    ...(call.action !== undefined ? { action: call.action } : {}),
    input: call.input,
  };
  const result = await runToolCallPhase(entries as never, toolCtx, 'PreToolUse');
  if (result.deny) return { kind: 'deny', message: result.deny.message };
  return { kind: 'allow' };
}

/**
 * Build the raw MCP config map from the agent's mcp.json + resolved session env.
 * Skips entries with unresolvable `${VAR}` references (same policy as our own spawner).
 */
type McpConfigForSdk =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http'; url: string; headers: Record<string, string> };

/**
 * Extra readable/writable directories exposed to the SDK's tools beyond `cwd`
 * (the dev-team repo). The target-project repo (house-style/founding docs) and
 * `dev-team-state` (per-agent memory the SessionEnd hooks commit) each live in
 * their own mount. We include only paths that actually exist so an un-mounted
 * repo doesn't hand the SDK a dead directory. `dev-team-state` resolves to the
 * sibling of the dev-team root — the same convention `resolvePath` uses.
 */
export function readableDirs(ctx: SessionContext, cwd: string = ctx.devTeamRoot): string[] {
  const stateRoot = join(ctx.devTeamRoot, '..', 'dev-team-state');
  // devTeamRoot is listed explicitly: when a work session's cwd is its worktree,
  // the agent still needs the dev-team repo for house style, protocols and its
  // own skill files. The `dir === cwd` skip below drops it again in the ordinary
  // case where cwd already IS devTeamRoot.
  const candidates = [ctx.devTeamRoot, ctx.targetProjectRoot, stateRoot];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of candidates) {
    if (dir === cwd || seen.has(dir)) continue; // cwd needs no additional grant
    seen.add(dir);
    if (existsSync(dir)) out.push(dir);
  }
  return out;
}

/**
 * Where the session's tools are anchored. The leased worktree when there is one
 * — that is the writable checkout the agent must edit and commit in — otherwise
 * the dev-team repo.
 */
function sessionCwd(prepared: PreparedSession): string {
  return prepared.workspace?.path ?? prepared.ctx.devTeamRoot;
}

/**
 * Names of in-process (SDK-hosted) MCP servers the agent opted into via an
 * `{ type: 'sdk' }` entry in mcp.json. These aren't spawned children — the
 * adapter instantiates the known ones. `activeServers()` drops them (they fail
 * the stdio|http schema), so we read the raw `mcpServers` map here.
 */
/**
 * Whether the GATED Linear mutation tier should be exposed this session. True only
 * when BOTH hold: the session was triggered by an explicit human @-mention
 * (match_reason 'explicit_mention'), and the agent's mcp.json `linear` entry
 * declares `gated_mutations: true`. This enforces AGENTS.md's tiered Linear scope
 * structurally — autonomous/work sessions never get the mutation tools.
 */
export function linearGatedAllowed(config: AgentConfig, matchReason: string | undefined): boolean {
  if (matchReason !== 'explicit_mention') return false;
  const linear = config.mcp.mcpServers?.linear as { gated_mutations?: unknown } | undefined;
  return linear?.gated_mutations === true;
}

function collectInProcessMcp(config: AgentConfig, skill?: string): string[] {
  const servers = config.mcp.mcpServers ?? {};
  const out: string[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (name.startsWith('_')) continue;
    if (!serverAllowsSkill(cfg, skill)) continue;
    if (cfg && typeof cfg === 'object' && (cfg as { type?: unknown }).type === 'sdk') {
      out.push(name);
    }
  }
  return out;
}

function buildMcpServersConfig(
  config: AgentConfig,
  sessionEnv: Readonly<Record<string, string>>,
  log: Logger,
  skill?: string,
): Record<string, McpConfigForSdk> {
  const out: Record<string, McpConfigForSdk> = {};
  // Baseline env inherited by every MCP child so `npx` / `node` / etc. resolve
  // — without this the SDK's own spawn hits `ENOENT` for command lookups.
  const baseEnv = pickChildBaseEnv();
  for (const [name, cfg] of activeServers(config.mcp, skill)) {
    try {
      if (cfg.type === 'stdio') {
        out[name] = {
          type: 'stdio',
          command: cfg.command,
          args: cfg.args,
          env: { ...baseEnv, ...resolveMcpEnv(name, cfg.env, sessionEnv) },
        };
      } else {
        // HTTP MCP — remote endpoint; SDK owns the connection.
        out[name] = {
          type: 'http',
          url: cfg.url,
          headers: resolveMcpEnv(name, cfg.headers, sessionEnv),
        };
      }
    } catch (err) {
      // Silent skip is a debugging trap — an agent silently missing a tool
      // (e.g. Harness with no GitHub MCP) is very hard to diagnose from outside.
      log.warn(
        { server: name, err: (err as Error).message },
        'mcp server skipped — placeholder unresolved',
      );
    }
  }
  return out;
}
