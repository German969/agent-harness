// Loop guard, across the thread boundary a new ticket creates.
//
// The same-thread cap (chainGuard.test.ts) finds its parent through
// `findContinuation`, which matches on thread_key — so it only ever sees a hop
// INSIDE one thread. A ticket an agent creates is a NEW thread: no continuation,
// no parent, depth back to zero. A fan-out built entirely out of agent-created
// tickets was therefore uncapped, and that is precisely the shape the Builder's
// decomposition rule makes easy to reach — one agent splitting work into three
// subtasks, each of which can split again.
//
// Exercised through the real dispatch path (handleEvent), like the same-thread
// cap, not against the primitives.

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
import {
  type Db,
  applyMigrations,
  chainDepth,
  openDb,
  recordArtifactOrigin,
} from '../../src/state/index.js';

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
    agent: 'builder-server',
    github: { app_id: '111', bot_username: 'builder-server-bot', installation_url: 'x' },
    linear: { agent_handle: 'builder-server-bot', user_id: 'user_bs', webhook_id: 'wh-shared' },
    slack: {
      app_id: 'A123',
      bot_user_id: 'U-BS',
      channels: { primary: '#build', alerts: '#agents-alerts' },
    },
    continuation_timeout_days: 30,
    secrets: {},
  } as unknown as Identity;
}

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

/**
 * A subtask assigned to the agent. Deliberately carries NO botActor and no reply
 * footer — that is what a real Linear `Issue` event looks like (measured absent on
 * both live IRS-46 triggers), so `isAgentAuthoredEvent` returns false for it. The
 * cross-thread link must not depend on that heuristic.
 */
function ticketEvent(id: string): WebhookEvent {
  return {
    provider: 'linear',
    delivery_id: `d-${id}`,
    event_type: 'Issue.update',
    agent_hint: 'wh-shared',
    payload: {
      data: {
        identifier: id,
        title: `subtask ${id}`,
        assignee: { id: 'user_bs' },
      },
    },
    received_at: Date.now(),
  };
}

let db: Db;
let tmp: string;
let alerts: MemoryAlertPoster;

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  applyMigrations(db);
  tmp = mkdtempSync(join(tmpdir(), 'crossticket-test-'));
  mkDevTeam(tmp, 'builder-server');
  clearAgentConfigCache();
  alerts = new MemoryAlertPoster();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

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

/** Dispatch one ticket event and return the session it opened. */
async function dispatch(d: ReturnType<typeof deps>, id: string): Promise<number> {
  const outcome = await handleEvent(ticketEvent(id), d);
  expect(outcome.kind).toBe('dispatched');
  if (outcome.kind !== 'dispatched') throw new Error('not dispatched');
  return outcome.sessionId;
}

function links(): Array<{ parent_session_id: number; child_session_id: number; via: string }> {
  return db
    .prepare('SELECT parent_session_id, child_session_id, via FROM agent_chain ORDER BY id')
    .all() as Array<{ parent_session_id: number; child_session_id: number; via: string }>;
}

describe('chain depth across an agent-created ticket', () => {
  it('links the ticket session back to the session that created the ticket', async () => {
    const d = deps();
    const parent = await dispatch(d, 'IRS-100');

    // The agent's create_issue call records who made IRS-101 before anyone acts on it.
    recordArtifactOrigin(db, { thread_key: 'linear:IRS-101', session_id: parent });
    const child = await dispatch(d, 'IRS-101');

    expect(links()).toEqual([
      { parent_session_id: parent, child_session_id: child, via: 'ticket_created' },
    ]);
    expect(chainDepth(db, child)).toBe(1);
  });

  it('a ticket a human created starts a fresh chain, however many there are', async () => {
    // No origin row means nobody in the fleet made the ticket. Depth must stay 0,
    // or a person filing a batch of tickets would eventually be refused.
    const d = deps();
    for (let i = 0; i < MAX_CHAIN_DEPTH * 3; i++) {
      const s = await dispatch(d, `IRS-2${i}`);
      expect(chainDepth(db, s)).toBe(0);
    }
    expect(links()).toEqual([]);
    expect(alerts.messages).toHaveLength(0);
  });

  it('refuses the hop past MAX_CHAIN_DEPTH and alerts, even though no event is agent-authored', async () => {
    const d = deps();
    // A fan-out: each session creates the next ticket, which wakes the next session.
    let parent = await dispatch(d, 'IRS-300');
    for (let i = 1; i <= MAX_CHAIN_DEPTH; i++) {
      const key = `IRS-30${i}`;
      recordArtifactOrigin(db, { thread_key: `linear:${key}`, session_id: parent });
      parent = await dispatch(d, key);
      expect(chainDepth(db, parent)).toBe(i);
    }

    // The next ticket is one hop too far.
    recordArtifactOrigin(db, { thread_key: 'linear:IRS-999', session_id: parent });
    const refused = await handleEvent(ticketEvent('IRS-999'), d);

    expect(refused.kind).toBe('loop_refused');
    if (refused.kind === 'loop_refused') {
      expect(refused.depth).toBe(MAX_CHAIN_DEPTH + 1);
      expect(refused.agent).toBe('builder-server');
    }
    expect(alerts.messages[0]?.title).toBe('coordination_loop_suspected');
  });

  it('a same-thread continuation still wins over the ticket origin', async () => {
    // Second event on a ticket the agent created: the parent is the session already
    // working that ticket, not the one that filed it — otherwise every later event
    // would re-link to the creator and the chain would fan out sideways.
    const d = deps();
    const creator = await dispatch(d, 'IRS-400');
    recordArtifactOrigin(db, { thread_key: 'linear:IRS-401', session_id: creator });
    const first = await dispatch(d, 'IRS-401');
    const second = await dispatch(d, 'IRS-401');

    expect(links()).toEqual([
      { parent_session_id: creator, child_session_id: first, via: 'ticket_created' },
      // A same-thread hop is only linked when the trigger is agent-authored, and
      // this Linear event is not — so it opens no link and stays at the depth its
      // predecessor reached.
    ]);
    expect(chainDepth(db, second)).toBe(0);
  });
});
