// Phase 12 end-to-end integration test.
//
// This test proves the whole ingress → runtime pipeline is wired:
//
//   POST /webhooks/slack/events
//     → signature verified
//     → normalized WebhookEvent
//     → enqueued
//     → consumer classifies via routing registry
//     → runSession dispatches (mocked SDK)
//     → session row lands in the DB as `completed`
//
// The only things NOT exercised here are the real Claude SDK (Phase 13) and
// the real Slack/Linear/GitHub reply APIs (Phase 7). Everything in between is
// the real code the production router runs.

import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAgentConfigCache } from '../../src/config/agentLoader.js';
import type {
  SdkCallbacks,
  SdkClient,
  SdkRunInputs,
  SessionOutcome,
} from '../../src/runtime/sdk.js';
import { buildServer } from '../../src/server.js';
import { openDb, resetDbForTests } from '../../src/state/db.js';

// ---------------------------------------------------------------------------
// fixture setup — build a minimal dev-team dir + identity + secrets in env
// ---------------------------------------------------------------------------

const SIGNING_SECRET = 'test-slack-signing-secret';
const APP_ID = 'A-STRAT-TEST';
const BOT_USER_ID = 'U-STRAT-TEST';

let tmp: string;
let dbPath: string;

function writeDevTeam(): void {
  const agentDir = join(tmp, 'agents', 'strategist');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'CLAUDE.md'), '# strategist\nYou plan.', 'utf-8');
  writeFileSync(
    join(agentDir, 'settings.json'),
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
  writeFileSync(
    join(agentDir, 'mcp.json'),
    JSON.stringify({ mcpServers: { github_gitdata: { type: 'sdk' } } }),
    'utf-8',
  );

  const idDir = join(tmp, 'identities');
  mkdirSync(idDir, { recursive: true });
  writeFileSync(
    join(idDir, 'strategist.yml'),
    `agent: strategist
github:
  app_slug: "strategist-bot"
  app_id: "999999"
  bot_username: "strategist-bot"
  installation_url: "https://example.com"
linear:
  agent_handle: "strategist"
  agent_id: "agent_strat"
  user_id: "usr_strat"
slack:
  app_id: "${APP_ID}"
  bot_user_id: "${BOT_USER_ID}"
  team_id: "T-E2E"
  channels:
    primary: ["#planning"]
routing:
  linear_labels: ["strategist"]
continuation_timeout_days: 30
secrets:
  slack_signing_secret: TEST_SLACK_SIGNING_SECRET
`,
    'utf-8',
  );
}

function mockSdk(): SdkClient & { received?: SdkRunInputs } {
  const holder: SdkClient & { received?: SdkRunInputs } = {
    kind: 'mock' as const,
    async runSession(inputs: SdkRunInputs, callbacks: SdkCallbacks): Promise<SessionOutcome> {
      holder.received = inputs;
      await callbacks.onTurnComplete({ cost_usd: 0.02, input_tokens: 100, output_tokens: 50 });
      callbacks.onPartial({ text: 'planning response' });
      return { kind: 'completed', finalText: 'planning response' };
    },
  };
  return holder;
}

/** Sign a Slack webhook body with the test secret. */
function signSlack(rawBody: string, secret: string): { sig: string; ts: string } {
  const ts = Math.floor(Date.now() / 1000).toString();
  const base = `v0:${ts}:${rawBody}`;
  const sig = `v0=${createHmac('sha256', secret).update(base).digest('hex')}`;
  return { sig, ts };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Reset the process-level DB singleton so each test opens a fresh file.
  resetDbForTests();
  tmp = mkdtempSync(join(tmpdir(), 'e2e-'));
  dbPath = join(tmp, 'state.sqlite');
  writeDevTeam();
  clearAgentConfigCache();
  // Only the signing secret needs to be in process.env — the env-secret provider
  // reads it dynamically per session. db path + dev-team root are threaded via
  // buildServer overrides so they don't collide with the module-level config.
  process.env.TEST_SLACK_SIGNING_SECRET = SIGNING_SECRET;
});
afterEach(() => {
  resetDbForTests();
  rmSync(tmp, { recursive: true, force: true });
  // biome-ignore lint/performance/noDelete: cleanup between tests
  delete process.env.TEST_SLACK_SIGNING_SECRET;
});

describe('router end-to-end (Phase 12)', () => {
  it('boots + serves /health and /ready', async () => {
    const server = await buildServer({ dbPath, devTeamRoot: tmp });
    try {
      const health = await server.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      const body = health.json();
      expect(body.ok).toBe(true);
      expect(typeof body.version).toBe('string');

      const ready = await server.inject({ method: 'GET', url: '/ready' });
      expect(ready.statusCode).toBe(200);
      const readyBody = ready.json();
      expect(readyBody.ready).toBe(true);
      expect(readyBody.subsystems.db).toBe('ready');
    } finally {
      await server.close();
    }
  });

  it('POST /webhooks/slack/events → session marked completed', async () => {
    const sdk = mockSdk();
    const server = await buildServer({
      sdk,
      dbPath,
      devTeamRoot: tmp,
      targetProjectRoot: tmp,
      projectName: 'e2e-project',
    });

    try {
      const bodyObj = {
        token: 'ignored',
        team_id: 'T-E2E',
        api_app_id: APP_ID,
        event: {
          type: 'app_mention',
          user: 'U-HUMAN',
          text: `<@${BOT_USER_ID}> plan Q4 launch`,
          channel: 'C-planning',
          ts: '9999999999.0001',
        },
        event_id: 'Ev-integ-1',
        event_time: Math.floor(Date.now() / 1000),
        type: 'event_callback',
      };
      const raw = JSON.stringify(bodyObj);
      const { sig, ts } = signSlack(raw, SIGNING_SECRET);

      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/slack/events',
        headers: {
          'content-type': 'application/json',
          'x-slack-signature': sig,
          'x-slack-request-timestamp': ts,
        },
        payload: raw,
      });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ queued: true });

      // The queue drain runs asynchronously via setImmediate/microtask. Wait
      // until the mock SDK has been called (bounded by 2s).
      await waitFor(() => sdk.received !== undefined, 2000);

      // Verify what the SDK received.
      expect(sdk.received?.systemPrompt).toContain('You plan');
      expect(sdk.received?.initialMessage).toContain('plan Q4 launch');
      // followup #4: the identity's slack.team_id must reach the session env as
      // SLACK_TEAM_ID (the slack MCP references it via `${SLACK_TEAM_ID}`).
      expect(sdk.received?.env.SLACK_TEAM_ID).toBe('T-E2E');
      // #12/#13: the `{ type: 'sdk' }` mcp.json entry opts the agent into the
      // in-process git-data MCP, surfaced to the adapter via inProcessMcp.
      expect(sdk.received?.inProcessMcp).toContain('github_gitdata');

      // Read the DB directly to assert on session state.
      const db = openDb({ path: dbPath });
      const rows = db.prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT 1').all() as Array<{
        agent: string;
        status: string;
        cost_usd: number;
      }>;
      db.close();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.agent).toBe('strategist');
      expect(rows[0]?.status).toBe('completed');
      expect(rows[0]?.cost_usd).toBeCloseTo(0.02, 4);
    } finally {
      await server.close();
    }
  });

  it('dedup: sending the same delivery twice does not double-dispatch', async () => {
    const sdk = mockSdk();
    let calls = 0;
    const countingSdk: SdkClient = {
      kind: 'mock',
      async runSession(inputs, callbacks) {
        calls++;
        await callbacks.onTurnComplete({ cost_usd: 0.01, input_tokens: 1, output_tokens: 1 });
        return { kind: 'completed', finalText: 'ok' };
      },
    };
    void sdk;
    const server = await buildServer({
      sdk: countingSdk,
      dbPath,
      devTeamRoot: tmp,
      targetProjectRoot: tmp,
    });

    try {
      const bodyObj = {
        api_app_id: APP_ID,
        event: {
          type: 'app_mention',
          user: 'U-HUMAN',
          text: `<@${BOT_USER_ID}> ping`,
          channel: 'C-planning',
          ts: '1111111111.0002',
        },
        event_id: 'Ev-dedup',
        type: 'event_callback',
      };
      const raw = JSON.stringify(bodyObj);
      const { sig, ts } = signSlack(raw, SIGNING_SECRET);
      const headers = {
        'content-type': 'application/json',
        'x-slack-signature': sig,
        'x-slack-request-timestamp': ts,
      };

      const first = await server.inject({
        method: 'POST',
        url: '/webhooks/slack/events',
        headers,
        payload: raw,
      });
      expect(first.statusCode).toBe(202);

      // Wait for the first drain to complete.
      await waitFor(() => calls === 1, 2000);

      // Same delivery_id → dedup path returns 200 without calling the SDK again.
      const second = await server.inject({
        method: 'POST',
        url: '/webhooks/slack/events',
        headers,
        payload: raw,
      });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ deduplicated: true });
      expect(calls).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('bad signature → 401 + SDK not invoked', async () => {
    const sdk = mockSdk();
    const server = await buildServer({ sdk, dbPath, devTeamRoot: tmp, targetProjectRoot: tmp });

    try {
      const bodyObj = {
        api_app_id: APP_ID,
        event: {
          type: 'app_mention',
          user: 'U-HUMAN',
          text: `<@${BOT_USER_ID}> hi`,
          channel: 'C-planning',
          ts: '2222222222.0003',
        },
        event_id: 'Ev-badsig',
        type: 'event_callback',
      };
      const raw = JSON.stringify(bodyObj);
      const { ts } = signSlack(raw, SIGNING_SECRET);
      // Provide a bogus signature.
      const res = await server.inject({
        method: 'POST',
        url: '/webhooks/slack/events',
        headers: {
          'content-type': 'application/json',
          'x-slack-signature':
            'v0=0000000000000000000000000000000000000000000000000000000000000000',
          'x-slack-request-timestamp': ts,
        },
        payload: raw,
      });
      expect(res.statusCode).toBe(401);
      expect(sdk.received).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}
