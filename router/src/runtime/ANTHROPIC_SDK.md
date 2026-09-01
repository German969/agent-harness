# Wiring the real Anthropic SDK

The router uses a narrow `SdkClient` interface (see [sdk.ts](sdk.ts)) so we can
build + test everything without depending on the actual `@anthropic-ai/claude-agent-sdk`
package. This lets each phase land independently — the runtime can be built,
tested, and deployed with `PlaceholderSdkClient` (which always errors) as the
default, and swapped for a real adapter when the deploy is ready.

## Installing

```bash
cd router
pnpm add @anthropic-ai/claude-agent-sdk
```

## Adapter shape

Create `router/src/runtime/anthropicAdapter.ts`:

```typescript
import { ClaudeAgentSDK /* real name TBD */ } from '@anthropic-ai/claude-agent-sdk';
import type {
  SdkCallbacks,
  SdkClient,
  SdkRunInputs,
  SessionOutcome,
} from './sdk.js';

export class AnthropicSdkClient implements SdkClient {
  readonly kind = 'anthropic' as const;

  constructor(private readonly apiKey: string) {}

  async runSession(inputs: SdkRunInputs, callbacks: SdkCallbacks): Promise<SessionOutcome> {
    // 1. Convert our SdkRunInputs → the SDK's session config shape:
    //    - `model` + `systemPrompt` + `initialContext` map ~1:1
    //    - `mcpServers` — the SDK expects ChildProcess handles; we already
    //      provide those in `inputs.mcpServers[i].proc`
    //    - `allowedTools` / `deniedTools` → SDK's tool-allow-list format
    //    - `thinkingBudget` — SDK's thinking config
    //
    // 2. Wire callbacks:
    //    - SDK.onPartial → callbacks.onPartial({ text })
    //    - SDK.onToolCall → callbacks.onToolCall({ tool, action?, input })
    //      then honor the returned { kind: 'allow' | 'deny', message? }
    //    - SDK.onTurnComplete → callbacks.onTurnComplete({ input_tokens,
    //      output_tokens, cost_usd })
    //      then honor the returned { kind: 'continue' | 'cancel', reason? }
    //
    // 3. Map SDK terminal states → SessionOutcome:
    //    - normal end → { kind: 'completed', finalText }
    //    - max_turns → { kind: 'max_turns_reached', finalText }
    //    - our cancel returned → { kind: 'cancelled', reason }
    //    - SDK error → { kind: 'error', error: <underlying> }
    //
    // Do NOT throw for expected error modes — return them as { kind: 'error' }
    // so the runtime can categorize + map to SessionStatus without exception
    // plumbing. The runtime's error handler + status mapping already handles
    // Anthropic API 4xx/5xx, rate-limits, MCP crashes, and unknown errors.

    throw new Error('anthropic adapter not implemented yet');
  }
}
```

## Instantiation

In `router/src/server.ts`, replace the `PlaceholderSdkClient` default:

```typescript
// BEFORE
const sdk = overrides.sdk ?? new PlaceholderSdkClient();

// AFTER
const sdk =
  overrides.sdk ??
  (config.ANTHROPIC_API_KEY
    ? new AnthropicSdkClient(config.ANTHROPIC_API_KEY)
    : new PlaceholderSdkClient());
```

Add `ANTHROPIC_API_KEY` to `config.ts` as an optional env var (it may be
per-agent in Infisical rather than global — in that case the adapter should
read it from `inputs.env.ANTHROPIC_API_KEY` at session time, not from module-
level config).

## What's already handled by the runtime

The adapter does NOT need to worry about:
- Cost cap enforcement — runtime's `onTurnComplete` bridge does this
- PreToolUse hooks — runtime bridges `onToolCall` through the hook orchestrator
- Session-end cleanup, MCP teardown, workspace release — `sessionComplete` runs after
- Reply streaming — `onPartial` gets bridged into `ReplyStreamer.push` upstream
- Session log — writer receives `session.started` + `session.completed` at the runtime layer
- Metrics — session counters + cost + duration are updated at the runtime layer

The adapter is a pure translation layer between two shapes.

## Testing

Once the adapter exists:
1. Set `ANTHROPIC_API_KEY` in `.env` (or Infisical for prod).
2. Trigger a scheduled entry via the CLI:
   ```bash
   docker exec dev-team-router node dist/cli/main.js schedule run guardian-llm-security-weekly-eval
   ```
3. Watch the session jsonl for `session.started` → SDK turns → `session.completed`.
4. Verify the reply landed on the trigger surface (Slack post, Linear comment, PR comment).
