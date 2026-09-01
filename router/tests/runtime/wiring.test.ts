// Phase 13a wiring tests — verify that when the runtime is given sessionLog +
// replyStreamer factory + metrics, all three actually fire at the right moments.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfig } from '../../src/config/index.js';
import { createMetrics, openSessionLog, scrape } from '../../src/observability/index.js';
import { ReplyStreamer } from '../../src/reply/index.js';
import type { FetchLike } from '../../src/reply/types.js';
import { FLEET_DENIED_TOOLS } from '../../src/runtime/fleetDeniedTools.js';
import { runSession } from '../../src/runtime/index.js';
import type {
  SdkCallbacks,
  SdkClient,
  SdkRunInputs,
  SessionOutcome,
} from '../../src/runtime/sdk.js';
import { EnvSecretProvider } from '../../src/secrets/env-provider.js';
import {
  type Db,
  applyMigrations,
  createSession,
  getSession,
  openDb,
} from '../../src/state/index.js';

const log = pino({ level: 'silent' });

function mkAgentConfig(): AgentConfig {
  return {
    agent: 'strategist',
    claudeMd: '# strategist',
    settings: {
      model: 'claude-sonnet-4-5',
      max_turns: 5,
      costCap: {
        perJobCostUsd: 5,
        monthlyCostUsd: 100,
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
}

function mockSdk(): SdkClient {
  return {
    kind: 'mock',
    async runSession(_inputs: SdkRunInputs, cb: SdkCallbacks): Promise<SessionOutcome> {
      await cb.onTurnComplete({ cost_usd: 0.05, input_tokens: 100, output_tokens: 50 });
      cb.onPartial({ text: 'Hello ' });
      cb.onPartial({ text: 'world.' });
      return { kind: 'completed', finalText: 'Hello world.' };
    },
  };
}

let db: Db;
let tmp: string;

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  applyMigrations(db);
  tmp = mkdtempSync(join(tmpdir(), 'wiring-'));
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('runtime wiring — denied tools', () => {
  it('the fleet-wide denials reach the SDK, on top of the agent’s own', async () => {
    // The helper being correct is not the same as it being wired. permissions.deny
    // is the only field that restricts anything, so this is the whole boundary:
    // if it does not arrive at the SDK, Agent/Workflow/Cron* are available to
    // every agent regardless of what fleetDeniedTools.ts says.
    const sessionId = createSession(db, {
      agent: 'strategist',
      thread_key: 't-denied',
      status: 'pending',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
    });
    const config = mkAgentConfig();
    (config.settings as unknown as { permissions: { deny: string[] } }).permissions.deny = [
      'Bash(terraform apply:*)',
    ];

    let seen: SdkRunInputs | undefined;
    const sdk: SdkClient = {
      kind: 'mock',
      async runSession(inputs: SdkRunInputs, cb: SdkCallbacks): Promise<SessionOutcome> {
        seen = inputs;
        await cb.onTurnComplete({ cost_usd: 0.01, input_tokens: 1, output_tokens: 1 });
        return { kind: 'completed', finalText: 'ok' };
      },
    };

    await runSession({
      agent: 'strategist',
      sessionId,
      config,
      identitySecrets: {},
      trigger: { kind: 'webhook:slack' },
      devTeamRoot: tmp,
      targetProjectRoot: tmp,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db,
      log,
      sdk,
      initialMessage: 'hi',
    });

    expect(seen).toBeDefined();
    for (const tool of FLEET_DENIED_TOOLS) {
      expect(seen?.deniedTools).toContain(tool);
    }
    expect(seen?.deniedTools).toContain('Bash(terraform apply:*)');
  });

  it('the built-in tool restriction reaches the SDK, reduced to bare names', async () => {
    // `allow` only becomes a boundary through `tools`; the helper being right is
    // not the same as it arriving.
    const sessionId = createSession(db, {
      agent: 'strategist',
      thread_key: 't-tools',
      status: 'pending',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
    });
    const config = mkAgentConfig();
    (config.settings as unknown as { permissions: { allow: string[] } }).permissions.allow = [
      'Read',
      'Bash(git log:*)',
      'Bash(git diff:*)',
      'mcp__linear__create_issue',
    ];

    let seen: SdkRunInputs | undefined;
    const sdk: SdkClient = {
      kind: 'mock',
      async runSession(inputs: SdkRunInputs, cb: SdkCallbacks): Promise<SessionOutcome> {
        seen = inputs;
        await cb.onTurnComplete({ cost_usd: 0.01, input_tokens: 1, output_tokens: 1 });
        return { kind: 'completed', finalText: 'ok' };
      },
    };

    await runSession({
      agent: 'strategist',
      sessionId,
      config,
      identitySecrets: {},
      trigger: { kind: 'webhook:slack' },
      devTeamRoot: tmp,
      targetProjectRoot: tmp,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db,
      log,
      sdk,
      initialMessage: 'hi',
    });

    expect(seen?.builtinTools).toEqual(['Bash', 'Read']);
    // The MCP entry must not leak into a list that governs built-ins only.
    expect(seen?.builtinTools).not.toContain('mcp__linear__create_issue');
  });
});

describe('runtime wiring — sessionLog', () => {
  it('writes session.started + session.completed to the jsonl file', async () => {
    const sessionId = createSession(db, {
      agent: 'strategist',
      thread_key: 't',
      status: 'pending',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
    });
    const writer = openSessionLog({ logDir: tmp, sessionId });

    await runSession({
      agent: 'strategist',
      sessionId,
      config: mkAgentConfig(),
      identitySecrets: {},
      trigger: { kind: 'webhook:slack' },
      devTeamRoot: tmp,
      targetProjectRoot: tmp,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db,
      log,
      sdk: mockSdk(),
      initialMessage: 'hi',
      sessionLog: writer,
    });

    expect(existsSync(writer.path)).toBe(true);
    const lines = readFileSync(writer.path, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const events = lines.map((l) => l.event);
    expect(events).toContain('session.started');
    expect(events).toContain('session.completed');
    const completedLine = lines.find((l) => l.event === 'session.completed');
    expect(completedLine.data.status).toBe('completed');
    expect(completedLine.data.turns).toBe(1);
  });
});

describe('runtime wiring — metrics', () => {
  it('increments session_total + observes duration + adds cost', async () => {
    const sessionId = createSession(db, {
      agent: 'strategist',
      thread_key: 't',
      status: 'pending',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
    });
    const metrics = createMetrics({ includeDefault: false });

    await runSession({
      agent: 'strategist',
      skill: 'pjm',
      sessionId,
      config: mkAgentConfig(),
      identitySecrets: {},
      trigger: { kind: 'webhook:slack' },
      devTeamRoot: tmp,
      targetProjectRoot: tmp,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db,
      log,
      sdk: mockSdk(),
      initialMessage: 'hi',
      metrics,
    });

    const text = await scrape(metrics);
    expect(text).toMatch(
      /agent_session_total\{agent="strategist",skill="pjm",outcome="completed"\}\s+1/,
    );
    expect(text).toMatch(/agent_session_cost_usd\{agent="strategist"\}\s+0\.05/);
    expect(text).toMatch(/agent_session_duration_seconds_count\{.*strategist.*pjm.*\}\s+1/);
  });

  it('increments in_flight up + down across the session', async () => {
    const sessionId = createSession(db, {
      agent: 'strategist',
      thread_key: 't',
      status: 'pending',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
    });
    const metrics = createMetrics({ includeDefault: false });

    await runSession({
      agent: 'strategist',
      sessionId,
      config: mkAgentConfig(),
      identitySecrets: {},
      trigger: { kind: 'webhook:slack' },
      devTeamRoot: tmp,
      targetProjectRoot: tmp,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db,
      log,
      sdk: mockSdk(),
      initialMessage: 'hi',
      metrics,
    });

    const text = await scrape(metrics);
    // in_flight starts at 0, goes to 1 during session, returns to 0.
    expect(text).toMatch(/router_in_flight_sessions\s+0/);
  });
});

describe('runtime wiring — claude_session_id persistence', () => {
  it('persists outcome.claudeSessionId onto the sessions row for thread continuation', async () => {
    const sessionId = createSession(db, {
      agent: 'strategist',
      thread_key: 't',
      status: 'pending',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
    });

    const sdkWithSessionId: SdkClient = {
      kind: 'mock',
      async runSession(_inputs: SdkRunInputs, cb: SdkCallbacks): Promise<SessionOutcome> {
        await cb.onTurnComplete({ cost_usd: 0.01, input_tokens: 10, output_tokens: 5 });
        return { kind: 'completed', finalText: 'ok', claudeSessionId: 'sess_abc123' };
      },
    };

    await runSession({
      agent: 'strategist',
      sessionId,
      config: mkAgentConfig(),
      identitySecrets: {},
      trigger: { kind: 'webhook:slack' },
      devTeamRoot: tmp,
      targetProjectRoot: tmp,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db,
      log,
      sdk: sdkWithSessionId,
      initialMessage: 'hi',
    });

    const row = getSession(db, sessionId);
    expect(row?.claude_session_id).toBe('sess_abc123');
    expect(row?.status).toBe('completed');
  });
});

describe('runtime wiring — reply streamer', () => {
  it('streams chunks + finalizes with footer via the streamer factory', async () => {
    const sessionId = createSession(db, {
      agent: 'strategist',
      thread_key: 't',
      status: 'pending',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
    });

    // Capture Slack HTTP calls via injected fetch.
    const calls: Array<{ url: string; body: unknown }> = [];
    const captureFetch: FetchLike = async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true, ts: '1.0' }), { status: 200 });
    };

    await runSession({
      agent: 'strategist',
      skill: 'pjm',
      sessionId,
      config: mkAgentConfig(),
      identitySecrets: {},
      trigger: { kind: 'webhook:slack' },
      devTeamRoot: tmp,
      targetProjectRoot: tmp,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db,
      log,
      sdk: mockSdk(),
      initialMessage: 'hi',
      buildReplyStreamer: () =>
        new ReplyStreamer({
          target: { provider: 'slack', channel: 'C-test', token: 'xoxb-x' },
          fetch: captureFetch,
        }),
    });

    // The final call must be chat.update (post-then-edit) OR chat.postMessage
    // (first send) with the finalized text containing chunks + footer.
    expect(calls.length).toBeGreaterThan(0);
    const finalCall = calls[calls.length - 1];
    const text = (finalCall?.body as { text: string }).text;
    expect(text).toContain('Hello');
    expect(text).toContain('world');
    expect(text).toContain('@strategist-agent');
    expect(text).toContain('session `');

    // Session completed cleanly.
    expect(getSession(db, sessionId)?.status).toBe('completed');
  });

  it('runs the session normally when buildReplyStreamer returns undefined', async () => {
    const sessionId = createSession(db, {
      agent: 'strategist',
      thread_key: 't',
      status: 'pending',
      triggered_by: 'webhook:slack',
      trigger_payload: {},
    });
    const result = await runSession({
      agent: 'strategist',
      sessionId,
      config: mkAgentConfig(),
      identitySecrets: {},
      trigger: { kind: 'webhook:slack' },
      devTeamRoot: tmp,
      targetProjectRoot: tmp,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db,
      log,
      sdk: mockSdk(),
      initialMessage: 'hi',
      buildReplyStreamer: () => undefined,
    });
    expect(result.kind).toBe('ran');
  });
});
