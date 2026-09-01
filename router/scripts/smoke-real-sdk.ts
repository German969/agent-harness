// One-off smoke test — invokes the real Anthropic SDK adapter against a live
// API key, no webhooks + no external services needed.
//
// Run:
//   cd router
//   ANTHROPIC_API_KEY=sk-ant-... pnpm exec tsx scripts/smoke-real-sdk.ts
//
// What this proves (in order of execution):
//   1. @anthropic-ai/claude-agent-sdk is installed + loadable
//   2. Our AnthropicSdkClient adapter constructs valid SDK Options
//   3. Anthropic accepts the key + processes the prompt
//   4. Our SdkCallbacks bridge receives partials + turn-complete + terminal result
//   5. runSession() returns a `completed` SessionOutcome
//
// Cost: ~$0.005 (one turn, ~200 tokens output).

import type { AgentConfig } from '../src/config/index.js';
import { runSession } from '../src/runtime/index.js';
import { AnthropicSdkClient } from '../src/runtime/anthropicAdapter.js';
import { EnvSecretProvider } from '../src/secrets/env-provider.js';
import { applyMigrations, createSession, openDb } from '../src/state/index.js';
import pino from 'pino';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY is required — set it in your shell or `--env-file`.');
  process.exit(1);
}

// In-memory DB — no persistence needed for a smoke test.
const db = openDb({ path: ':memory:' });
applyMigrations(db);

// A minimal agent config — bare-bones settings, no hooks, no MCPs.
const config: AgentConfig = {
  agent: 'strategist',
  claudeMd:
    'You are a router smoke test. Reply in ONE short sentence: what year is it and what is 2+2?',
  settings: {
    model: 'claude-haiku-4-5-20251001',
    max_turns: 2,
    costCap: {
      perJobCostUsd: 1,
      monthlyCostUsd: 10,
      warnAtPercent: 80,
      onCapReached: 'refuse_session',
    },
    permissions: { allow: [], ask: [], deny: [] },
    writeScope: { allowedPaths: [], deniedPaths: [] },
    hooks: { SessionStart: [], PreToolUse: [], PostToolUse: [], SessionEnd: [] },
  } as never,
  mcp: { mcpServers: {} } as never,
  skills: new Map(),
} as AgentConfig;

const sessionId = createSession(db, {
  agent: 'strategist',
  thread_key: 'smoke-test',
  status: 'pending',
  triggered_by: 'webhook:slack',
  trigger_payload: {},
});

const log = pino({ level: 'info' });

const streamedChunks: string[] = [];

console.log(`[smoke] session ${sessionId} — sending prompt to ${config.settings.model}\n`);

const result = await runSession({
  agent: 'strategist',
  sessionId,
  config,
  identitySecrets: {},
  trigger: { kind: 'webhook:slack', message: 'smoke test' },
  devTeamRoot: '/tmp',
  targetProjectRoot: '/tmp',
  projectName: 'smoke',
  acquireWorkspace: false,
  secretProvider: new EnvSecretProvider(),
  db,
  log,
  sdk: new AnthropicSdkClient({ apiKey }),
  initialMessage: 'Reply as instructed.',
  onPartial: (chunk) => {
    streamedChunks.push(chunk.text);
    process.stdout.write(chunk.text);
  },
});

process.stdout.write('\n\n');

console.log('[smoke] result:', JSON.stringify(result, null, 2));

if (result.kind === 'ran' && result.outcome.kind === 'completed') {
  console.log('\n✅ smoke test PASSED');
  console.log(`   turns: ${result.turns}`);
  console.log(`   cost:  $${result.totalCostUsd.toFixed(4)}`);
  console.log(`   streamed ${streamedChunks.length} partial chunks (${streamedChunks.join('').length} chars)`);
  process.exit(0);
} else {
  console.error('\n❌ smoke test FAILED');
  process.exit(1);
}
