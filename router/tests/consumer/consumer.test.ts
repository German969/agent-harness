// Consumer bridge tests — from a WebhookEvent → dispatched session (with mock SDK).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAgentConfigCache } from '../../src/config/agentLoader.js';
import { handleEvent } from '../../src/consumer/consumer.js';
import type { WebhookEvent } from '../../src/ingress/types.js';
import { buildRegistry } from '../../src/routing/index.js';
import type { Identity } from '../../src/routing/schema.js';
import type {
  SdkCallbacks,
  SdkClient,
  SdkRunInputs,
  SessionOutcome,
} from '../../src/runtime/sdk.js';
import { EnvSecretProvider } from '../../src/secrets/env-provider.js';
import { type Db, applyMigrations, getSession, openDb } from '../../src/state/index.js';

const log = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// fixtures — build a self-contained dev-team dir with one minimal agent
// ---------------------------------------------------------------------------

function mkDevTeam(tmp: string, agent: string): void {
  const dir = join(tmp, 'agents', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), `# ${agent}\nYou are ${agent}.`, 'utf-8');
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

function mkIdentity(agent: 'strategist'): Identity {
  return {
    agent,
    github: { app_id: '111', bot_username: `${agent}-bot`, installation_url: 'x' },
    linear: { agent_id: 'agent_x', user_id: 'user_x' },
    slack: {
      app_id: 'A123',
      bot_user_id: 'U-STRAT',
      channels: { primary: '#planning' },
    },
    continuation_timeout_days: 30,
    secrets: {},
  } as Identity;
}

// A mock SDK that runs one turn + completes.
function mockSdk(): SdkClient & { called: boolean; lastInputs?: SdkRunInputs } {
  const holder: SdkClient & { called: boolean; lastInputs?: SdkRunInputs } = {
    kind: 'mock' as const,
    called: false,
    async runSession(inputs: SdkRunInputs, callbacks: SdkCallbacks): Promise<SessionOutcome> {
      holder.called = true;
      holder.lastInputs = inputs;
      await callbacks.onTurnComplete({ cost_usd: 0.01, input_tokens: 100, output_tokens: 50 });
      callbacks.onPartial({ text: 'ok' });
      return { kind: 'completed', finalText: 'ok' };
    },
  };
  return holder;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

let db: Db;
let tmp: string;

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  applyMigrations(db);
  tmp = mkdtempSync(join(tmpdir(), 'consumer-test-'));
  mkDevTeam(tmp, 'strategist');
  clearAgentConfigCache();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('handleEvent', () => {
  it('classifies + dispatches a matching event → session marked completed', async () => {
    const registry = buildRegistry([mkIdentity('strategist')]);
    const sdk = mockSdk();

    const event: WebhookEvent = {
      provider: 'slack',
      delivery_id: 'd-1',
      event_type: 'app_mention',
      agent_hint: 'U-STRAT',
      payload: {
        event: {
          type: 'app_mention',
          text: '<@U-STRAT> plan Q4',
          channel: 'C-planning',
          ts: '1234567890.1234',
          user: 'U-HUMAN',
        },
      },
      received_at: Date.now(),
    };

    const outcome = await handleEvent(event, {
      db,
      registry,
      secretProvider: new EnvSecretProvider(),
      sdk,
      log,
      devTeamRoot: tmp,
      targetProjectRoot: tmp,
      projectName: 'test',
    });

    expect(outcome.kind).toBe('dispatched');
    expect(sdk.called).toBe(true);
    if (outcome.kind === 'dispatched') {
      const row = getSession(db, outcome.sessionId);
      expect(row?.status).toBe('completed');
      expect(row?.agent).toBe('strategist');
      expect(row?.cost_usd).toBeCloseTo(0.01, 4);
      // Consumer strips the leading self-mention before dispatching so the
      // agent doesn't echo its own tag back at the start of the reply.
      expect(sdk.lastInputs?.initialMessage).toBe('plan Q4');
    }
  });

  it('records "unmatched" when no agent matches', async () => {
    const registry = buildRegistry([mkIdentity('strategist')]);
    const sdk = mockSdk();

    const event: WebhookEvent = {
      provider: 'slack',
      delivery_id: 'd-nope',
      event_type: 'app_mention',
      agent_hint: 'U-UNKNOWN',
      payload: { event: { text: 'nothing relevant', channel: 'C-random' } },
      received_at: Date.now(),
    };

    const outcome = await handleEvent(event, {
      db,
      registry,
      secretProvider: new EnvSecretProvider(),
      sdk,
      log,
      devTeamRoot: tmp,
      targetProjectRoot: tmp,
      projectName: 'test',
    });
    expect(outcome.kind).toBe('unmatched');
    expect(sdk.called).toBe(false);
  });

  it('config_load_failed when agent dir missing', async () => {
    // Add a marketer identity but no config on disk.
    const registry = buildRegistry([
      mkIdentity('strategist'),
      {
        ...mkIdentity('strategist'),
        agent: 'marketer',
        slack: { app_id: 'A-mkt', bot_user_id: 'U-MKT', channels: { primary: '#marketing' } },
      } as Identity,
    ]);
    const sdk = mockSdk();
    const event: WebhookEvent = {
      provider: 'slack',
      delivery_id: 'd-mkt',
      event_type: 'app_mention',
      agent_hint: 'U-MKT',
      payload: { event: { text: '<@U-MKT> draft post' } },
      received_at: Date.now(),
    };
    const outcome = await handleEvent(event, {
      db,
      registry,
      secretProvider: new EnvSecretProvider(),
      sdk,
      log,
      devTeamRoot: tmp,
      targetProjectRoot: tmp,
      projectName: 'test',
    });
    expect(outcome.kind).toBe('config_load_failed');
    expect(sdk.called).toBe(false);
  });

  it('creates session with continuation link when classifier returns continuation', async () => {
    const registry = buildRegistry([mkIdentity('strategist')]);
    const sdk = mockSdk();

    // Seed a prior session in the same thread that ended recently. Thread key
    // format matches buildSlackThreadKey: `slack:<channel>/<thread_ts>`.
    const priorId = db
      .prepare(
        `INSERT INTO sessions (agent, thread_key, status, triggered_by, trigger_payload,
                               started_at, ended_at, claude_session_id, turns, cost_usd,
                               cost_input_tokens, cost_output_tokens)
         VALUES ('strategist', 'slack:C-planning/1234567890.1234', 'completed', 'webhook:slack',
                 '{}', ?, ?, 'claude-abc', 0, 0, 0, 0)`,
      )
      .run(Date.now() - 60_000, Date.now() - 30_000).lastInsertRowid as number;

    const event: WebhookEvent = {
      provider: 'slack',
      delivery_id: 'd-2',
      event_type: 'app_mention',
      agent_hint: 'U-STRAT',
      payload: {
        event: {
          type: 'app_mention',
          text: '<@U-STRAT> follow up',
          channel: 'C-planning',
          thread_ts: '1234567890.1234',
          ts: '1234567891.5678',
        },
      },
      received_at: Date.now(),
    };

    const outcome = await handleEvent(event, {
      db,
      registry,
      secretProvider: new EnvSecretProvider(),
      sdk,
      log,
      devTeamRoot: tmp,
      targetProjectRoot: tmp,
      projectName: 'test',
    });

    expect(outcome.kind).toBe('dispatched');
    if (outcome.kind === 'dispatched') {
      const row = getSession(db, outcome.sessionId);
      expect(row?.triggered_by_session_id).toBe(priorId);
      // The SDK should have received the prior claude_session_id.
      expect(sdk.lastInputs?.claudeSessionId).toBe('claude-abc');
    }
  });
});
