// AnthropicSdkClient adapter — smoke tests that don't hit the real API.
//
// The adapter is thin (translation only); the SDK does the actual work. These
// tests verify:
//   - It errors out cleanly when no API key is provided.
//   - It composes the systemPrompt from base + initialContext.
//   - The internal helpers (extractPartialText, extractAction, estimateTurnCost)
//     behave as documented.
//
// Live integration tests against the real SDK would need a valid ANTHROPIC_API_KEY
// and are out of scope for the router repo — belong in `tests/api-tests/` or
// a smoke-test in the deploy pipeline.

import { describe, expect, it, vi } from 'vitest';

// Scripted SDK message stream — each test builds one, `queryMock` yields it in
// order. Declared before vi.mock so the mock can close over it.
let scriptedMessages: unknown[] = [];
const queryMock = vi.fn(() => ({
  async *[Symbol.asyncIterator]() {
    for (const m of scriptedMessages) yield m;
  },
  interrupt: async () => {},
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

const { AnthropicSdkClient } = await import('../../src/runtime/anthropicAdapter.js');

describe('built-in tool restriction', () => {
  // `allowedTools` is a prompt-skip list, per the SDK's own docs: "auto-allowed
  // without prompting… to restrict which tools are available, use the `tools`
  // option instead". The router set allowedTools and never set tools, so every
  // built-in the CLI ships was available to every agent whatever its config said.
  async function runWith(builtinTools: string[] | undefined) {
    scriptedMessages = [
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'result', subtype: 'success', result: 'ok', session_id: 's' },
    ];
    const client = new AnthropicSdkClient({ apiKey: 'sk-ant-test' });
    await client.runSession(
      {
        model: 'claude-sonnet-5',
        systemPrompt: '# agent',
        initialContext: [],
        initialMessage: 'hi',
        maxTurns: 5,
        allowedTools: ['Read', 'Bash(git log:*)'],
        deniedTools: ['Agent'],
        mcpServers: [],
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
        ...(builtinTools ? { builtinTools } : {}),
      },
      {
        onPartial: () => {},
        onToolCall: async () => ({ kind: 'allow' }),
        onTurnComplete: () => ({ kind: 'continue' }),
      },
    );
    return queryMock.mock.calls.at(-1)?.[0]?.options as Record<string, unknown>;
  }

  it('sets options.tools from the derived built-in list', async () => {
    const options = await runWith(['Bash', 'Read', 'Write']);
    expect(options?.tools).toEqual(['Bash', 'Read', 'Write']);
    // allowedTools stays as the prompt-skip list it is; the two are not the same
    // field and setting one has never implied the other.
    expect(options?.allowedTools).toEqual(['Read', 'Bash(git log:*)']);
    expect(options?.disallowedTools).toEqual(['Agent']);
  });

  it('leaves options.tools unset when there is no list', async () => {
    // Falling back to the previous unrestricted behaviour is the safe error.
    const options = await runWith(undefined);
    expect(options?.tools).toBeUndefined();
  });

  it('never sets options.tools to an empty array', async () => {
    // `tools: []` means "disable ALL built-in tools" — an agent that could not
    // read a file. The adapter must treat empty as "do not restrict".
    const options = await runWith([]);
    expect(options?.tools).toBeUndefined();
  });
});

describe('session environment', () => {
  // The defect: `options.env` REPLACES the child environment, so passing only
  // secrets left the session with no PATH. Builder-Server reported "git/node/pnpm
  // /which all exit 127" on four sessions of chatbots#11, could not run its own
  // tests or biome, and a lint failure shipped as a result.
  it('gives the session a PATH, not just secrets', async () => {
    scriptedMessages = [
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'result', subtype: 'success', result: 'ok', session_id: 's' },
    ];
    const client = new AnthropicSdkClient({ apiKey: 'sk-ant-test' });
    await client.runSession(
      {
        model: 'claude-sonnet-5',
        systemPrompt: '# builder',
        initialContext: [],
        initialMessage: 'hi',
        maxTurns: 5,
        allowedTools: [],
        deniedTools: [],
        mcpServers: [],
        env: { ANTHROPIC_API_KEY: 'sk-ant-test', LINEAR_TOKEN: 'lin_secret' },
      },
      {
        onPartial: () => {},
        onToolCall: async () => ({ kind: 'allow' }),
        onTurnComplete: () => ({ kind: 'continue' }),
      },
    );
    const env = queryMock.mock.calls.at(-1)?.[0]?.options?.env as Record<string, string>;
    expect(env.PATH).toBe(process.env.PATH);
    // Secrets still reach the session, and still win over the baseline.
    expect(env.LINEAR_TOKEN).toBe('lin_secret');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test');
  });
});

describe('AnthropicSdkClient', () => {
  it('returns { kind: "error" } when no API key is available', async () => {
    const client = new AnthropicSdkClient();
    const outcome = await client.runSession(
      {
        model: 'claude-sonnet-4-5',
        systemPrompt: '# strategist',
        initialContext: [],
        initialMessage: 'hi',
        maxTurns: 5,
        allowedTools: [],
        deniedTools: [],
        mcpServers: [],
        env: {}, // no ANTHROPIC_API_KEY
      },
      {
        onPartial: () => {},
        onToolCall: async () => ({ kind: 'allow' }),
        onTurnComplete: () => ({ kind: 'continue' }),
      },
    );
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.error.message).toContain('ANTHROPIC_API_KEY');
    }
  });

  it('reports the client kind for logging', () => {
    const client = new AnthropicSdkClient({ apiKey: 'sk-ant-test' });
    expect(client.kind).toBe('anthropic');
  });

  it('posts accumulated assistant text on error_max_turns terminal', async () => {
    // Regression: max_turns terminal used to leave content stranded, delivering
    // an empty Slack reply. Fix falls back to text accumulated from assistant
    // frames' content blocks.
    scriptedMessages = [
      { type: 'system', subtype: 'init', session_id: 'sess-max-turns' },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        session_id: 'sess-max-turns',
        message: {
          content: [{ type: 'text', text: 'partial answer before cutoff' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      { type: 'result', subtype: 'error_max_turns', session_id: 'sess-max-turns' },
    ];
    const posted: string[] = [];
    const turnCompletes: number[] = [];
    const client = new AnthropicSdkClient({ apiKey: 'sk-ant-test' });
    const outcome = await client.runSession(
      {
        model: 'claude-sonnet-4-5',
        systemPrompt: '# strategist',
        initialContext: [],
        initialMessage: 'hi',
        maxTurns: 5,
        allowedTools: [],
        deniedTools: [],
        mcpServers: [],
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      },
      {
        onPartial: (chunk) => {
          posted.push(chunk.text);
        },
        onToolCall: async () => ({ kind: 'allow' }),
        onTurnComplete: (t) => {
          turnCompletes.push(t.output_tokens);
          return { kind: 'continue' };
        },
      },
    );
    expect(outcome.kind).toBe('max_turns_reached');
    expect(posted).toEqual(['partial answer before cutoff']);
    // Turn accounting must fire on every assistant frame now that the
    // stop_reason gate is gone (that was the root cause of turns=0 in DB).
    expect(turnCompletes).toEqual([5]);
  });

  it('prefers result.result over accumulated text on a successful terminal', async () => {
    scriptedMessages = [
      { type: 'system', subtype: 'init', session_id: 'sess-ok' },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        session_id: 'sess-ok',
        message: {
          content: [{ type: 'text', text: 'draft draft draft' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'the final polished answer',
        session_id: 'sess-ok',
      },
    ];
    const posted: string[] = [];
    const client = new AnthropicSdkClient({ apiKey: 'sk-ant-test' });
    const outcome = await client.runSession(
      {
        model: 'claude-sonnet-4-5',
        systemPrompt: '# strategist',
        initialContext: [],
        initialMessage: 'hi',
        maxTurns: 5,
        allowedTools: [],
        deniedTools: [],
        mcpServers: [],
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      },
      {
        onPartial: (chunk) => {
          posted.push(chunk.text);
        },
        onToolCall: async () => ({ kind: 'allow' }),
        onTurnComplete: () => ({ kind: 'continue' }),
      },
    );
    expect(outcome.kind).toBe('completed');
    expect(posted).toEqual(['the final polished answer']);
  });

  it('bills cache_creation + cache_read tokens at their own rates', async () => {
    // Regression: pre-fix the estimator only read input_tokens, missing 15-25%
    // of real cost when cache tokens exist. Sonnet-5 rates: input $2/M,
    // cache-write $2.50/M, cache-read $0.20/M, output $10/M. (This comment and
    // the figure below previously carried Sonnet-4.6's rates while naming them
    // Sonnet 5's, so the test asserted the very drift it was meant to guard.)
    scriptedMessages = [
      { type: 'system', subtype: 'init', session_id: 'sess-cache' },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        session_id: 'sess-cache',
        message: {
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 1_000_000,
            cache_creation_input_tokens: 1_000_000,
            cache_read_input_tokens: 1_000_000,
            output_tokens: 1_000_000,
          },
        },
      },
      { type: 'result', subtype: 'success', result: 'done', session_id: 'sess-cache' },
    ];
    const turnCompletes: number[] = [];
    const client = new AnthropicSdkClient({ apiKey: 'sk-ant-test' });
    await client.runSession(
      {
        model: 'claude-sonnet-5',
        systemPrompt: '# strategist',
        initialContext: [],
        initialMessage: 'hi',
        maxTurns: 5,
        allowedTools: [],
        deniedTools: [],
        mcpServers: [],
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      },
      {
        onPartial: () => {},
        onToolCall: async () => ({ kind: 'allow' }),
        onTurnComplete: (t) => {
          turnCompletes.push(t.cost_usd);
          return { kind: 'continue' };
        },
      },
    );
    // 1M input @ $2 + 1M cache-write @ $2.50 + 1M cache-read @ $0.20 + 1M output @ $10 = $14.70
    expect(turnCompletes).toEqual([14.7]);
  });

  it('accounts each assistant message id once when the SDK repeats frames', async () => {
    // Regression: the SDK emits multiple `assistant` frames per turn (one per
    // content block), each carrying the SAME cumulative message.usage. Counting
    // every frame double-billed the turn (observed 2-4x cost/token inflation).
    // Frames sharing a message.id must be accounted exactly once.
    scriptedMessages = [
      { type: 'system', subtype: 'init', session_id: 'sess-dupe' },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        session_id: 'sess-dupe',
        message: {
          id: 'msg-A',
          content: [{ type: 'text', text: 'part one ' }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, cache_read_input_tokens: 500, output_tokens: 7 },
        },
      },
      {
        // Same message.id, same usage — a repeated frame for the same turn.
        type: 'assistant',
        parent_tool_use_id: null,
        session_id: 'sess-dupe',
        message: {
          id: 'msg-A',
          content: [{ type: 'text', text: 'part one ' }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, cache_read_input_tokens: 500, output_tokens: 7 },
        },
      },
      {
        // A genuinely new turn — different message.id, counts separately.
        type: 'assistant',
        parent_tool_use_id: null,
        session_id: 'sess-dupe',
        message: {
          id: 'msg-B',
          content: [{ type: 'text', text: 'part two' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 2, output_tokens: 3 },
        },
      },
      { type: 'result', subtype: 'success', result: 'final', session_id: 'sess-dupe' },
    ];
    const turnOutputs: number[] = [];
    const client = new AnthropicSdkClient({ apiKey: 'sk-ant-test' });
    await client.runSession(
      {
        model: 'claude-sonnet-4-5',
        systemPrompt: '# strategist',
        initialContext: [],
        initialMessage: 'hi',
        maxTurns: 5,
        allowedTools: [],
        deniedTools: [],
        mcpServers: [],
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      },
      {
        onPartial: () => {},
        onToolCall: async () => ({ kind: 'allow' }),
        onTurnComplete: (t) => {
          turnOutputs.push(t.output_tokens);
          return { kind: 'continue' };
        },
      },
    );
    // msg-A counted once (7), msg-B once (3) — the repeated msg-A frame is dropped.
    expect(turnOutputs).toEqual([7, 3]);
  });

  it('skips subagent assistant frames from turn accounting', async () => {
    // Subagent messages (nested tool activity) have parent_tool_use_id set and
    // must not count as turns.
    scriptedMessages = [
      { type: 'system', subtype: 'init', session_id: 'sess-subagent' },
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_123',
        session_id: 'sess-subagent',
        message: {
          content: [{ type: 'text', text: 'nested subagent narration' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        session_id: 'sess-subagent',
        message: {
          content: [{ type: 'text', text: 'mainline answer' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'mainline answer',
        session_id: 'sess-subagent',
      },
    ];
    const turnCompletes: number[] = [];
    const client = new AnthropicSdkClient({ apiKey: 'sk-ant-test' });
    await client.runSession(
      {
        model: 'claude-sonnet-4-5',
        systemPrompt: '# strategist',
        initialContext: [],
        initialMessage: 'hi',
        maxTurns: 5,
        allowedTools: [],
        deniedTools: [],
        mcpServers: [],
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      },
      {
        onPartial: () => {},
        onToolCall: async () => ({ kind: 'allow' }),
        onTurnComplete: (t) => {
          turnCompletes.push(t.output_tokens);
          return { kind: 'continue' };
        },
      },
    );
    expect(turnCompletes).toEqual([5]);
  });
});
