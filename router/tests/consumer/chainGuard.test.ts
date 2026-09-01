// Loop guard — the depth cap on agent→agent chains, exercised through the real
// dispatch path (handleEvent), not the primitives in isolation.
//
// Regression for 2026-08-28: one Linear comment spawned sessions 211-273 because
// nothing ever called chainDepth. `agent_chain` stayed empty and the documented
// cap (ARCHITECTURE.md §3.1) never bound.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAgentConfigCache } from '../../src/config/agentLoader.js';
import { MAX_CHAIN_DEPTH } from '../../src/consumer/chainGuard.js';
import { handleEvent } from '../../src/consumer/consumer.js';
import type { WebhookEvent } from '../../src/ingress/types.js';
import { MemoryAlertPoster } from '../../src/observability/alerts.js';
import { buildRegistry } from '../../src/routing/index.js';
import type { Identity } from '../../src/routing/schema.js';
import type { SdkCallbacks, SdkClient, SdkRunInputs } from '../../src/runtime/sdk.js';
import type { SessionOutcome } from '../../src/runtime/sdk.js';
import { EnvSecretProvider } from '../../src/secrets/env-provider.js';
import { type Db, applyMigrations, openDb } from '../../src/state/index.js';

const log = pino({ level: 'silent' });

function mkDevTeam(tmp: string, agent: string): void {
  const dir = join(tmp, 'agents', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), `# ${agent}`, 'utf-8');
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_turns: 5,
      costCap: {
        perJobCostUsd: 1,
        monthlyCostUsd: 100,
        warnAtPercent: 80,
        onCapReached: 'refuse_session',
      },
      permissions: { allow: [], ask: [], deny: [] },
      writeScope: { allowedPaths: [], deniedPaths: [] },
      hooks: { SessionStart: [], PreToolUse: [], PostToolUse: [], SessionEnd: [] },
    }),
    'utf-8',
  );
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: {} }), 'utf-8');
}

function mkIdentity(): Identity {
  return {
    agent: 'strategist',
    github: { app_id: '111', bot_username: 'strategist-bot', installation_url: 'x' },
    linear: { agent_id: 'agent_x', user_id: 'user_x' },
    slack: {
      app_id: 'A123',
      bot_user_id: 'U-STRAT',
      channels: { primary: '#planning', alerts: '#agents-alerts' },
    },
    continuation_timeout_days: 30,
    secrets: {},
  } as Identity;
}

// Continuation only engages when the prior session recorded a claude_session_id,
// so the mock must return one or every event looks like a fresh thread.
function mockSdk(): SdkClient {
  return {
    kind: 'mock' as const,
    async runSession(_inputs: SdkRunInputs, callbacks: SdkCallbacks): Promise<SessionOutcome> {
      await callbacks.onTurnComplete({ cost_usd: 0.01, input_tokens: 10, output_tokens: 5 });
      callbacks.onPartial({ text: 'ok' });
      return { kind: 'completed', finalText: 'ok', claudeSessionId: 'claude-abc' };
    },
  };
}

let db: Db;
let tmp: string;
let alerts: MemoryAlertPoster;

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  applyMigrations(db);
  tmp = mkdtempSync(join(tmpdir(), 'chainguard-test-'));
  mkDevTeam(tmp, 'strategist');
  clearAgentConfigCache();
  alerts = new MemoryAlertPoster();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** One Slack message in a fixed thread. `authoredByAgent` decides bot vs human. */
function threadEvent(n: number, authoredByAgent: boolean): WebhookEvent {
  return {
    provider: 'slack',
    delivery_id: `d-${n}`,
    event_type: 'app_mention',
    agent_hint: 'U-STRAT',
    payload: {
      event: {
        type: 'app_mention',
        text: `<@U-STRAT> turn ${n}`,
        channel: 'C-planning',
        ts: `100.${n}`,
        thread_ts: '100.0',
        ...(authoredByAgent ? { bot_id: 'B-STRAT' } : { user: 'U-HUMAN' }),
      },
    },
    received_at: Date.now(),
  };
}

function deps() {
  return {
    db,
    registry: buildRegistry([mkIdentity()]),
    secretProvider: new EnvSecretProvider(),
    sdk: mockSdk(),
    log,
    devTeamRoot: tmp,
    targetProjectRoot: tmp,
    projectName: 'test',
    alertPoster: alerts,
  };
}

function sessionCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
}

describe('agent-to-agent chain depth cap', () => {
  it('refuses the hop past MAX_CHAIN_DEPTH and dispatches nothing', async () => {
    const d = deps();
    // The first event opens the thread (no parent, depth 0); each later one is a
    // hop. So MAX_CHAIN_DEPTH hops are allowed after the opener.
    for (let i = 0; i <= MAX_CHAIN_DEPTH; i++) {
      const outcome = await handleEvent(threadEvent(i, true), d);
      expect(outcome.kind).toBe('dispatched');
    }

    const before = sessionCount();
    const refused = await handleEvent(threadEvent(MAX_CHAIN_DEPTH + 1, true), d);

    expect(refused.kind).toBe('loop_refused');
    if (refused.kind === 'loop_refused') {
      expect(refused.depth).toBe(MAX_CHAIN_DEPTH + 1);
      expect(refused.agent).toBe('strategist');
    }
    // The refusal must happen before the session row is created — otherwise a
    // runaway still costs a row (and a spawn) per hop.
    expect(sessionCount()).toBe(before);
  });

  it('posts coordination_loop_suspected to the alerts channel', async () => {
    const d = deps();
    for (let i = 0; i <= MAX_CHAIN_DEPTH; i++) await handleEvent(threadEvent(i, true), d);
    await handleEvent(threadEvent(MAX_CHAIN_DEPTH + 1, true), d);

    expect(alerts.messages).toHaveLength(1);
    expect(alerts.messages[0]?.title).toBe('coordination_loop_suspected');
    expect(alerts.messages[0]?.channel).toBe('#agents-alerts');
    expect(alerts.messages[0]?.fields?.depth).toBe(MAX_CHAIN_DEPTH + 1);
  });

  it('never trips on a human conversation, however long', async () => {
    // The clause that makes this safe to ship: only agent-authored triggers extend
    // a chain. Without it, the sixth reply to a person would be silently refused.
    const d = deps();
    for (let i = 0; i < MAX_CHAIN_DEPTH * 3; i++) {
      const outcome = await handleEvent(threadEvent(i, false), d);
      expect(outcome.kind).toBe('dispatched');
    }
    expect(alerts.messages).toHaveLength(0);
  });

  it('a human turn clears the chain so the agent can answer again', async () => {
    const d = deps();
    for (let i = 0; i <= MAX_CHAIN_DEPTH; i++) await handleEvent(threadEvent(i, true), d);
    expect((await handleEvent(threadEvent(90, true), d)).kind).toBe('loop_refused');

    // A person speaks: that turn is dispatched and records no chain link, so the
    // next agent-authored hop measures its depth from the human turn.
    expect((await handleEvent(threadEvent(91, false), d)).kind).toBe('dispatched');
    expect((await handleEvent(threadEvent(92, true), d)).kind).toBe('dispatched');
  });
});
