// AnthropicSdkClient — implements SdkClient against @anthropic-ai/claude-agent-sdk.
//
// Translation summary (per the SDK's public surface at v0.3.204):
//
//   SdkRunInputs → SDK Options
//     - model / maxTurns / allowedTools / disallowedTools → same-named options
//     - systemPrompt: string          → options.systemPrompt (string form)
//     - initialContext[]              → appended into the systemPrompt (SDK has
//                                       no first-class "initial context" concept;
//                                       we compose it in)
//     - mcpServersConfig              → options.mcpServers as one Record entry
//     - env.ANTHROPIC_API_KEY         → set on the SDK process env
//     - claudeSessionId (continuation) → options.resume
//
//   SDK stream → SdkCallbacks
//     - SDKPartialAssistantMessage.event  → callbacks.onPartial({ text })
//     - SDKAssistantMessage (end of turn) → callbacks.onTurnComplete({ cost + tokens })
//                                             then handle 'cancel' via query.interrupt()
//     - CanUseTool                        → callbacks.onToolCall + { behavior: allow|deny }
//     - SDKResultSuccess                  → { kind: 'completed', finalText: result }
//     - SDKResultError                    → maps to max_turns_reached / cancelled / error
//
// The adapter never throws for expected errors — every failure surfaces via the
// returned SessionOutcome so the runtime's error handler categorizes it.

import {
  type Options,
  type PermissionResult,
  type SDKMessage,
  query,
} from '@anthropic-ai/claude-agent-sdk';
import { GitDataClient } from '../github/gitData.js';
import { GITHUB_GITDATA_SERVER, buildGitDataMcpServer } from '../github/gitDataMcp.js';
import { LinearClient } from '../linear/linearClient.js';
import { LINEAR_SERVER, buildLinearMcpServer } from '../linear/linearMcp.js';
import { pickChildBaseEnv } from '../mcp/env.js';
import { estimateCost } from './modelRates.js';
import type {
  PartialChunk,
  PreToolUseDecision,
  SdkCallbacks,
  SdkClient,
  SdkRunInputs,
  SessionOutcome,
} from './sdk.js';

export type AnthropicSdkClientOptions = {
  /**
   * Anthropic API key. When absent, the adapter falls back to
   * `inputs.env.ANTHROPIC_API_KEY` at session time (useful for per-agent
   * key attribution via Infisical).
   */
  apiKey?: string;
};

export class AnthropicSdkClient implements SdkClient {
  readonly kind = 'anthropic' as const;

  constructor(private readonly opts: AnthropicSdkClientOptions = {}) {}

  async runSession(inputs: SdkRunInputs, callbacks: SdkCallbacks): Promise<SessionOutcome> {
    const apiKey = this.opts.apiKey ?? inputs.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        kind: 'error',
        error: new Error('AnthropicSdkClient: no ANTHROPIC_API_KEY in options or session env'),
      };
    }

    const abortController = new AbortController();
    let cancelReason: string | undefined;
    let lastPartialText = '';
    let claudeSessionId: string | undefined;
    // Assistant-message ids already accounted. The SDK emits multiple `assistant`
    // frames per turn (one per content block: thinking / tool_use / text), each
    // repeating the same cumulative `message.usage`. Counting every frame inflates
    // cost + tokens N× (observed 2–4×). We account each message id exactly once.
    const seenTurnIds = new Set<string>();

    // Compose systemPrompt = agent's CLAUDE.md + injected context blocks.
    const systemPrompt = composeSystemPrompt(inputs.systemPrompt, inputs.initialContext);

    // Compose the SDK's Options object. Fields we don't set default to the SDK's defaults.
    // exactOptionalPropertyTypes: assign optional fields conditionally rather
    // than via ternary-undefined.
    const options: Options = {
      abortController,
      model: inputs.model,
      systemPrompt,
      maxTurns: inputs.maxTurns,
      // Do NOT opt into includePartialMessages. Under that flag the SDK emits
      // assistant frames with `stop_reason: null`, so per-turn accounting
      // (cost, turn count, cap enforcement) never fires. With the flag off we
      // get one assistant frame per turn with stop_reason set to end_turn /
      // tool_use / etc. — the proper turn boundary. Session-level streaming
      // to Slack isn't needed anyway: we intentionally post the reply only at
      // terminal, not during mid-session narration.
      // Route the SDK's tool-permission callback through our PreToolUse hooks.
      // The SDK's runtime Zod schema requires `updatedInput` on the allow
      // variant even though the TypeScript type marks it optional — passing
      // the original input through means "allow, don't rewrite arguments".
      canUseTool: async (toolName, input): Promise<PermissionResult> => {
        const decision = await callbacks.onToolCall({
          tool: toolName,
          action: extractAction(toolName),
          input,
        });
        if (decision.kind === 'deny') {
          // Deny is a security-meaningful event — keep at info so it's visible
          // in default dtlog output.
          inputs.log?.info(
            { tool: toolName, decision: 'deny', reason: decision.message },
            'sdk canUseTool: deny',
          );
          return { behavior: 'deny', message: decision.message };
        }
        // Allows fire on every tool call — noisy at info. Debug is enough for
        // when someone's auditing what tools ran.
        inputs.log?.debug({ tool: toolName, decision: 'allow' }, 'sdk canUseTool: allow');
        return { behavior: 'allow', updatedInput: input };
      },
      // Secrets (ANTHROPIC_API_KEY + MCP creds) on top of a baseline the child
      // needs to function at all.
      //
      // `options.env` REPLACES the child's environment rather than extending it,
      // so passing secrets alone left the session with no PATH — and a Bash tool
      // with no PATH cannot run `git`, `node`, `pnpm`, or even `ls`; every command
      // exits 127. Builder-Server reported exactly that on four separate sessions
      // of chatbots#11 ("empty PATH… git/node/pnpm/which all exit 127"), could not
      // run its own tests or `biome check`, said so on the PR, and asked for CI to
      // be treated as the gate. A lint failure shipped because of it.
      //
      // `pickChildBaseEnv()` already existed for precisely this reason and was
      // applied to MCP stdio children only — its own comment says "without this
      // the SDK's own spawn hits ENOENT for command lookups". The agent's session
      // needs the same baseline. Secrets are spread last so they still win.
      env: { ...pickChildBaseEnv(), ...inputs.env, ANTHROPIC_API_KEY: apiKey },
    };

    if (inputs.allowedTools.length > 0) options.allowedTools = inputs.allowedTools;
    if (inputs.deniedTools.length > 0) options.disallowedTools = inputs.deniedTools;
    // `allowedTools` above only skips the permission prompt — the SDK's own docs
    // say so and point here. `tools` is what actually restricts the built-in set.
    // Never set to an empty array: that would mean "no built-in tools at all".
    if (inputs.builtinTools && inputs.builtinTools.length > 0) {
      options.tools = inputs.builtinTools;
      inputs.log?.debug({ tools: inputs.builtinTools }, 'sdk: built-in tools restricted');
    }
    if (inputs.cwd) options.cwd = inputs.cwd;
    if (inputs.additionalDirectories && inputs.additionalDirectories.length > 0) {
      options.additionalDirectories = inputs.additionalDirectories;
    }

    // Do NOT pass options.resume. Anthropic's server-side conversation state
    // for `resume` is unreliable (observed: "No conversation found with session
    // ID: ..." even for sessions completed days earlier — likely a short TTL
    // we can't depend on). Every SDK call starts a fresh conversation. Thread
    // continuity is provided by injecting prior-turn context via initialContext
    // (see thread-history injection in consumer). claudeSessionId is still
    // persisted for the reply footer's root-session-id display.
    void inputs.claudeSessionId;

    // MCP servers: pass the resolved configs so the SDK spawns stdio children
    // or connects to http endpoints itself. Both transport shapes are typed by
    // SdkRunInputs['mcpServersConfig'].
    if (inputs.mcpServersConfig && Object.keys(inputs.mcpServersConfig).length > 0) {
      options.mcpServers = Object.fromEntries(
        Object.entries(inputs.mcpServersConfig).map(([name, cfg]) => {
          if (cfg.type === 'stdio') {
            return [
              name,
              { type: 'stdio' as const, command: cfg.command, args: cfg.args, env: cfg.env },
            ];
          }
          return [name, { type: 'http' as const, url: cfg.url, headers: cfg.headers }];
        }),
      );
    }

    // In-process (SDK-hosted) MCP servers the agent opted into. Unlike stdio/http
    // servers these are instantiated here, in the adapter, because the SDK needs
    // the live server object — not a spawn config.
    if (inputs.inProcessMcp && inputs.inProcessMcp.length > 0) {
      const servers = { ...(options.mcpServers ?? {}) };
      for (const name of inputs.inProcessMcp) {
        if (name === GITHUB_GITDATA_SERVER) {
          const token = inputs.env.GITHUB_APP_INSTALLATION_TOKEN;
          if (!token) {
            inputs.log?.warn(
              { server: name },
              'in-process git-data MCP skipped: no GITHUB_APP_INSTALLATION_TOKEN in session env',
            );
            continue;
          }
          servers[name] = buildGitDataMcpServer(GitDataClient.fromToken(token), inputs.log);
        } else if (name === LINEAR_SERVER) {
          const token = inputs.env.LINEAR_TOKEN;
          if (!token) {
            inputs.log?.warn(
              { server: name },
              'in-process linear MCP skipped: no LINEAR_TOKEN in session env',
            );
            continue;
          }
          servers[name] = buildLinearMcpServer(
            LinearClient.fromToken(token, { ...(inputs.agent ? { actorName: inputs.agent } : {}) }),
            {
              ...(inputs.log ? { log: inputs.log } : {}),
              ...(inputs.gatedLinearMutations ? { gatedMutations: true } : {}),
              ...(inputs.onIssueCreated ? { onIssueCreated: inputs.onIssueCreated } : {}),
            },
          );
        } else {
          inputs.log?.warn({ server: name }, 'unknown in-process MCP name; skipped');
        }
      }
      options.mcpServers = servers;
    }

    let q: ReturnType<typeof query>;
    try {
      q = query({ prompt: inputs.initialMessage, options });
    } catch (err) {
      return {
        kind: 'error',
        error: err as Error,
        ...(claudeSessionId ? { claudeSessionId } : {}),
      };
    }

    try {
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        // Per-message trace at debug — useful when diagnosing empty responses
        // or stop_reason quirks, but too noisy at info (a real session emits
        // hundreds of stream_event / thinking_tokens messages).
        inputs.log?.debug(
          {
            msgType: msg.type,
            ...('subtype' in msg && msg.subtype ? { subtype: msg.subtype } : {}),
          },
          `sdk msg: ${msg.type}`,
        );

        // The SDK emits `system` with subtype `init` once at the start of the
        // stream (both on fresh sessions and on resume). Capture session_id so
        // the router can persist it and pass it back next turn to continue
        // the same Claude session.
        if (msg.type === 'system') {
          const sid = extractSessionId(msg);
          if (sid) claudeSessionId = sid;
          continue;
        }

        // The SDK emits SEVERAL assistant frames per turn (one per content block:
        // thinking / tool_use / text), each carrying the same cumulative
        // message.usage — so turn accounting dedupes by message.id below.
        // Accumulate each frame's text into lastPartialText so the terminal-result
        // handler has a fallback reply if `result.result` is empty (max_turns /
        // other error subtypes). Subagent frames (parent_tool_use_id set) are skipped.
        //
        // ⚠️ Followup — mid-session prompt-cache miss (turn-12 observation).
        // In a long multi-turn (tool-using) session we observed one turn re-writing
        // the entire ~67K prefix cold (cache_write≈69K / cache_read=0) while the
        // surrounding turns were read-dominated — a one-time full re-cache in the
        // middle of the session. It is NOT TTL (turns were <1min apart) and NOT
        // auto-compaction (well under the context limit). Most consistent with the
        // Agent SDK rotating prompt-cache breakpoints (Anthropic allows max 4,
        // prefix-based) as the message list grows, evicting the one that anchored
        // the stable system prefix. We do not set cache_control — the SDK owns
        // breakpoint placement — so this is not fixable from this adapter today.
        // Impact: ~one extra full prefix re-cache per LONG session (~$0.26 at
        // Sonnet), zero impact on single-turn Q&A. If it ever dominates cost, the
        // lever is fewer turns, not caching. Revisit if the SDK exposes cache
        // controls, or measure per-turn (turn.cost log) to see how often it fires.
        if (msg.type === 'assistant') {
          if (msg.parent_tool_use_id !== null) continue;

          const contentBlocks = Array.isArray(msg.message.content) ? msg.message.content : [];
          for (const block of contentBlocks) {
            const b = block as { type?: string; text?: unknown };
            if (b.type === 'text' && typeof b.text === 'string') {
              lastPartialText += b.text;
            }
          }

          // Account each assistant message's usage once. Repeated frames for the
          // same message.id carry identical cumulative usage — counting them again
          // double-bills the turn. Text accumulation above still runs on every
          // frame so no content block is dropped from the fallback reply.
          const turnId = typeof msg.message.id === 'string' ? msg.message.id : undefined;
          if (turnId && seenTurnIds.has(turnId)) continue;
          if (turnId) seenTurnIds.add(turnId);

          const usage = msg.message.usage;
          const cost = estimateCost(inputs.model, usage);
          const blockTypes = contentBlocks.map((c) => (c as { type?: string })?.type ?? 'unknown');
          inputs.log?.info(
            {
              stop_reason: msg.message.stop_reason,
              input_tokens: usage?.input_tokens ?? 0,
              cache_write_tokens: usage?.cache_creation_input_tokens ?? 0,
              cache_read_tokens: usage?.cache_read_input_tokens ?? 0,
              output_tokens: usage?.output_tokens ?? 0,
              cost_usd: cost,
              content_blocks: blockTypes,
            },
            'sdk assistant turn end',
          );
          const decision = await callbacks.onTurnComplete({
            input_tokens: usage?.input_tokens ?? 0,
            cache_write_tokens: usage?.cache_creation_input_tokens ?? 0,
            cache_read_tokens: usage?.cache_read_input_tokens ?? 0,
            output_tokens: usage?.output_tokens ?? 0,
            cost_usd: cost,
          });
          if (decision !== undefined) {
            const d = await decision;
            if (d.kind === 'cancel') {
              cancelReason = d.reason;
              await q.interrupt().catch(() => {
                /* swallow — we're already cancelling */
              });
            }
          }
          continue;
        }

        // Terminal result — the SDK emits exactly one of these per session.
        if (msg.type === 'result') {
          const sid = extractSessionId(msg) ?? claudeSessionId;
          const finalText =
            msg.subtype === 'success' && typeof msg.result === 'string' ? msg.result : '';
          // On non-success terminals (error_max_turns, error_max_budget_usd,
          // cancels) the SDK doesn't attach `result` text — but we've been
          // accumulating text-block content from each assistant turn into
          // lastPartialText. Fall back to that so Slack still gets whatever
          // the model produced before it was cut off, instead of an empty msg.
          const replyText = finalText.length > 0 ? finalText : lastPartialText;
          // Diagnostics for error subtypes — errors[] + terminal_reason live
          // on SDKResultError but not on SDKResultSuccess, so guard the reads.
          const errorInfo =
            msg.subtype !== 'success'
              ? {
                  errors: Array.isArray((msg as { errors?: unknown }).errors)
                    ? (msg as { errors: string[] }).errors
                    : [],
                  terminal_reason: (msg as { terminal_reason?: string }).terminal_reason,
                  num_turns: (msg as { num_turns?: number }).num_turns,
                  duration_ms: (msg as { duration_ms?: number }).duration_ms,
                }
              : undefined;
          inputs.log?.info(
            {
              subtype: msg.subtype,
              finalTextLen: finalText.length,
              accumulatedLen: lastPartialText.length,
              postedLen: replyText.length,
              ...(errorInfo ?? {}),
            },
            'sdk terminal result',
          );
          // Push the terminal reply as a single onPartial call. During the
          // session we deliberately don't push mid-turn text — the reply
          // target receives one clean message at the end.
          if (replyText.length > 0) {
            callbacks.onPartial({ text: replyText } as PartialChunk);
          }
          if (cancelReason) {
            return {
              kind: 'cancelled',
              reason: cancelReason,
              ...(sid ? { claudeSessionId: sid } : {}),
            };
          }
          if (msg.subtype === 'success') {
            return {
              kind: 'completed',
              finalText: msg.result,
              ...(sid ? { claudeSessionId: sid } : {}),
            };
          }
          // Non-success result subtypes.
          if (msg.subtype === 'error_max_turns') {
            return {
              kind: 'max_turns_reached',
              finalText: lastPartialText,
              ...(sid ? { claudeSessionId: sid } : {}),
            };
          }
          if (msg.subtype === 'error_max_budget_usd') {
            return {
              kind: 'cancelled',
              reason: 'sdk_max_budget_usd',
              ...(sid ? { claudeSessionId: sid } : {}),
            };
          }
          const errText = msg.errors.join('; ') || `sdk_${msg.subtype}`;
          return {
            kind: 'error',
            error: new Error(errText),
            ...(sid ? { claudeSessionId: sid } : {}),
          };
        }

        // All other message types (system, hook, notifications, etc.) are
        // observational — we log them via the SDK's own logging, no bridge here.
      }
    } catch (err) {
      // Unexpected iterator throw (network hiccup, abort race). Runtime's
      // errorHandler categorizes.
      return {
        kind: 'error',
        error: err as Error,
        ...(claudeSessionId ? { claudeSessionId } : {}),
      };
    }

    // Stream ended without a result message — treat as an unexpected end.
    return {
      kind: 'error',
      error: new Error('SDK stream ended without a terminal result message'),
      ...(claudeSessionId ? { claudeSessionId } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Fold the SessionStart hook contexts into the systemPrompt. The SDK doesn't
 * distinguish "system prompt" from "injected context" — everything goes into
 * `systemPrompt` before the first user message.
 */
function composeSystemPrompt(
  base: string,
  contexts: Array<{ content: string; tag?: string }>,
): string {
  if (contexts.length === 0) return base;
  const parts = [base, ''];
  for (const ctx of contexts) {
    if (ctx.tag) parts.push(`<${ctx.tag}>`, ctx.content, `</${ctx.tag}>`);
    else parts.push(ctx.content);
  }
  return parts.join('\n');
}

/**
 * Read `session_id` off any SDK message that carries one (system init + result
 * both do). We type-narrow via a runtime check instead of leaning on the SDK's
 * union types because those change across SDK versions.
 */
function extractSessionId(msg: unknown): string | undefined {
  if (typeof msg !== 'object' || msg === null) return undefined;
  const sid = (msg as { session_id?: unknown }).session_id;
  return typeof sid === 'string' && sid.length > 0 ? sid : undefined;
}

/**
 * Best-effort extraction of the action verb from a tool name (e.g. `mcp__cms__publish`
 * → `publish`). The router's Marketer publish-gate matches on this.
 */
function extractAction(toolName: string): string | undefined {
  const parts = toolName.split('__');
  if (parts.length >= 3) return parts[parts.length - 1];
  return undefined;
}
