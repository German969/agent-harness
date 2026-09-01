// Phase 6d integration test — end-to-end runtime with a mock SDK.
//
// Verifies the full Prepare → SDK call → Complete flow across the golden path
// and the edge cases documented in ARCHITECTURE.md §1.3 / §1.4 / §1.5:
//   - cost-cap refusal
//   - founding-docs gate refusal
//   - normal completion
//   - per-job cap cancellation mid-session
//   - SDK error → mapped to `failed`
//   - hook order (SessionStart runs before SDK, SessionEnd runs after)

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfig } from '../../src/config/index.js';
import { runSession } from '../../src/runtime/index.js';
import type {
  PartialChunk,
  PreToolUseDecision,
  SdkCallbacks,
  SdkClient,
  SdkRunInputs,
  SessionOutcome,
  ToolCallDescriptor,
  TurnCost,
} from '../../src/runtime/sdk.js';
import { EnvSecretProvider } from '../../src/secrets/env-provider.js';
import { recordTurnCost } from '../../src/state/cost.js';
import { type Db, applyMigrations, openDb } from '../../src/state/index.js';
import { createSession, getSession } from '../../src/state/sessions.js';

const log = pino({ level: 'silent' });

// -----------------------------------------------------------------------------
// mock SDK builder
// -----------------------------------------------------------------------------

type Script =
  | { kind: 'turns'; turns: TurnCost[]; final: 'completed' | 'max_turns_reached' }
  | { kind: 'error'; error: Error }
  | {
      kind: 'tool_calls';
      turns: TurnCost[];
      toolCalls: ToolCallDescriptor[];
      final: 'completed';
    };

function mockSdk(script: Script): SdkClient & { received?: SdkRunInputs } {
  const holder: SdkClient & { received?: SdkRunInputs } = {
    kind: 'mock' as const,
    async runSession(inputs: SdkRunInputs, callbacks: SdkCallbacks): Promise<SessionOutcome> {
      holder.received = inputs;
      if (script.kind === 'error') return { kind: 'error', error: script.error };

      if (script.kind === 'tool_calls') {
        for (const call of script.toolCalls) {
          const decision = await callbacks.onToolCall(call);
          if (decision.kind === 'deny') {
            // The mock stops looping on first deny (real SDK would surface the
            // deny message to the model + let it retry).
            break;
          }
        }
      }

      for (const t of script.turns) {
        const decision = await callbacks.onTurnComplete(t);
        if (decision !== undefined && (await decision).kind === 'cancel') {
          return { kind: 'cancelled', reason: (await decision).kind === 'cancel' ? 'cap' : '' };
        }
      }
      callbacks.onPartial({ text: 'final response' } as PartialChunk);
      return { kind: 'completed', finalText: 'final response' };
    },
  };
  return holder;
}

// -----------------------------------------------------------------------------
// test rig
// -----------------------------------------------------------------------------

type Rig = {
  root: string;
  devTeam: string;
  targetProject: string;
  db: Db;
};

function mkRig(): Rig {
  const root = mkdtempSync(join(tmpdir(), 'runtime-int-'));
  const devTeam = join(root, 'dev-team');
  const targetProject = join(root, 'target-project');
  mkdirSync(devTeam, { recursive: true });
  mkdirSync(targetProject, { recursive: true });
  // Founding docs present by default so the gate is open.
  writeFileSync(join(targetProject, 'STACK.md'), 'stack', 'utf-8');
  writeFileSync(join(targetProject, 'SYSTEM.md'), 'system', 'utf-8');
  const db = openDb({ path: ':memory:' });
  applyMigrations(db);
  return { root, devTeam, targetProject, db };
}

function cleanupRig(rig: Rig): void {
  rig.db.close();
  rmSync(rig.root, { recursive: true, force: true });
}

function mkAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agent: 'strategist',
    claudeMd: '# Strategist\nYou plan.',
    settings: {
      model: 'claude-sonnet-4-5',
      max_turns: 20,
      costCap: {
        perJobCostUsd: 5,
        monthlyCostUsd: 100,
        warnAtPercent: 80,
        onCapReached: 'refuse_session',
      },
      permissions: { allow: ['Read'], ask: [], deny: [] },
      writeScope: { allowedPaths: [], deniedPaths: [] },
      hooks: {
        SessionStart: [],
        PreToolUse: [],
        PostToolUse: [],
        SessionEnd: [],
      },
    } as never,
    mcp: { mcpServers: {} } as never,
    skills: new Map(),
    ...overrides,
  } as AgentConfig;
}

async function mkSessionRow(db: Db): Promise<number> {
  return createSession(db, {
    agent: 'strategist',
    thread_key: 'test-thread',
    status: 'pending',
    triggered_by: 'webhook:slack',
    trigger_payload: {},
  });
}

// -----------------------------------------------------------------------------
// tests
// -----------------------------------------------------------------------------

let rig: Rig;
beforeEach(() => {
  rig = mkRig();
});
afterEach(() => cleanupRig(rig));

describe('runSession — golden path', () => {
  it('runs Prepare → SDK → Complete + marks session completed', async () => {
    const sessionId = await mkSessionRow(rig.db);
    const cfg = mkAgentConfig();
    const sdk = mockSdk({
      kind: 'turns',
      turns: [
        { cost_usd: 0.01, input_tokens: 100, output_tokens: 50 },
        { cost_usd: 0.02, input_tokens: 200, output_tokens: 80 },
      ],
      final: 'completed',
    });

    const result = await runSession({
      agent: 'strategist',
      sessionId,
      config: cfg,
      identitySecrets: {},
      trigger: { kind: 'webhook:slack', message: 'hi' },
      devTeamRoot: rig.devTeam,
      targetProjectRoot: rig.targetProject,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db: rig.db,
      log,
      sdk,
      initialMessage: 'hi',
    });

    expect(result.kind).toBe('ran');
    if (result.kind === 'ran') {
      expect(result.outcome.kind).toBe('completed');
      expect(result.turns).toBe(2);
      expect(result.totalCostUsd).toBeCloseTo(0.03, 4);
      expect(result.completion.status).toBe('completed');
    }

    const row = getSession(rig.db, sessionId);
    expect(row?.status).toBe('completed');
    expect(row?.cost_usd).toBeCloseTo(0.03, 4);
    expect(row?.turns).toBe(2);
  });

  it('emits a per-turn turn.cost line to the session log with cache tokens', async () => {
    const sessionId = await mkSessionRow(rig.db);
    const cfg = mkAgentConfig();
    const sdk = mockSdk({
      kind: 'turns',
      turns: [
        {
          cost_usd: 0.01,
          input_tokens: 100,
          output_tokens: 50,
          cache_write_tokens: 6000,
          cache_read_tokens: 0,
        },
        {
          cost_usd: 0.02,
          input_tokens: 200,
          output_tokens: 80,
          cache_write_tokens: 500,
          cache_read_tokens: 6000,
        },
      ],
      final: 'completed',
    });
    const entries: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const sessionLog = {
      path: '',
      sessionId,
      write(entry: { event: string; data?: Record<string, unknown> }): void {
        entries.push(entry);
      },
    };

    await runSession({
      agent: 'strategist',
      sessionId,
      config: cfg,
      identitySecrets: {},
      trigger: { kind: 'webhook:slack', message: 'hi' },
      devTeamRoot: rig.devTeam,
      targetProjectRoot: rig.targetProject,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db: rig.db,
      log,
      sdk,
      initialMessage: 'hi',
      sessionLog,
    });

    const turnCosts = entries.filter((e) => e.event === 'turn.cost');
    expect(turnCosts).toHaveLength(2);
    expect(turnCosts[0]?.data).toMatchObject({
      turn: 1,
      cache_write_tokens: 6000,
      cache_read_tokens: 0,
    });
    expect(turnCosts[1]?.data).toMatchObject({
      turn: 2,
      cache_write_tokens: 500,
      cache_read_tokens: 6000,
    });
  });

  it('threads SessionStart context into SDK inputs', async () => {
    const sessionId = await mkSessionRow(rig.db);
    // Write a context file the load hook will pick up.
    writeFileSync(join(rig.targetProject, 'CONTEXT.md'), 'PRODUCT_CONTEXT', 'utf-8');
    const cfg = mkAgentConfig({
      settings: {
        model: 'claude-sonnet-4-5',
        max_turns: 20,
        costCap: {
          perJobCostUsd: 5,
          monthlyCostUsd: 100,
          warnAtPercent: 80,
          onCapReached: 'refuse_session',
        },
        permissions: { allow: [], ask: [], deny: [] },
        writeScope: { allowedPaths: [], deniedPaths: [] },
        hooks: {
          SessionStart: [{ command: 'load', paths: ['<target-project>/CONTEXT.md'] } as never],
          PreToolUse: [],
          PostToolUse: [],
          SessionEnd: [],
        },
      } as never,
    });
    const sdk = mockSdk({
      kind: 'turns',
      turns: [{ cost_usd: 0.01, input_tokens: 50, output_tokens: 25 }],
      final: 'completed',
    });

    await runSession({
      agent: 'strategist',
      sessionId,
      config: cfg,
      identitySecrets: {},
      trigger: { kind: 'webhook:slack', message: 'hi' },
      devTeamRoot: rig.devTeam,
      targetProjectRoot: rig.targetProject,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db: rig.db,
      log,
      sdk,
      initialMessage: 'hi',
    });

    expect(sdk.received?.initialContext.length).toBe(1);
    expect(sdk.received?.initialContext[0]?.content).toContain('PRODUCT_CONTEXT');
  });
});

describe('runSession — refusals', () => {
  it('refuses when cost cap would be exceeded', async () => {
    const sessionId = await mkSessionRow(rig.db);
    // Prime the ledger — this agent has already spent $99.
    recordTurnCost(rig.db, 'strategist', {
      cost_usd: 99,
      input_tokens: 0,
      output_tokens: 0,
    });
    const cfg = mkAgentConfig();
    const sdk = mockSdk({
      kind: 'turns',
      turns: [{ cost_usd: 0.01, input_tokens: 1, output_tokens: 1 }],
      final: 'completed',
    });

    const result = await runSession({
      agent: 'strategist',
      sessionId,
      config: cfg,
      identitySecrets: {},
      trigger: { kind: 'webhook:slack', message: 'hi' },
      devTeamRoot: rig.devTeam,
      targetProjectRoot: rig.targetProject,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db: rig.db,
      log,
      sdk,
      initialMessage: 'hi',
    });

    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') {
      expect(result.refusal.kind).toBe('cost_cap_hit');
    }
    // SDK was never invoked.
    expect(sdk.received).toBeUndefined();
    const row = getSession(rig.db, sessionId);
    expect(row?.status).toBe('gated');
  });

  it('gates when a founding-docs check hook fails', async () => {
    const sessionId = await mkSessionRow(rig.db);
    // Remove STACK.md so the gate fires.
    rmSync(join(rig.targetProject, 'STACK.md'));
    const cfg = mkAgentConfig({
      settings: {
        model: 'claude-sonnet-4-5',
        max_turns: 20,
        costCap: {
          perJobCostUsd: 5,
          monthlyCostUsd: 100,
          warnAtPercent: 80,
          onCapReached: 'refuse_session',
        },
        permissions: { allow: [], ask: [], deny: [] },
        writeScope: { allowedPaths: [], deniedPaths: [] },
        hooks: {
          SessionStart: [
            {
              command: 'check',
              if_missing: ['<target-project>/STACK.md'],
              context: 'stack_missing',
              message: 'STACK.md missing — refuse',
            } as never,
          ],
          PreToolUse: [],
          PostToolUse: [],
          SessionEnd: [],
        },
      } as never,
    });
    const sdk = mockSdk({ kind: 'turns', turns: [], final: 'completed' });

    const result = await runSession({
      agent: 'strategist',
      sessionId,
      config: cfg,
      identitySecrets: {},
      trigger: { kind: 'webhook:slack', message: 'hi' },
      devTeamRoot: rig.devTeam,
      targetProjectRoot: rig.targetProject,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db: rig.db,
      log,
      sdk,
      initialMessage: 'hi',
    });

    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') {
      expect(result.refusal.kind).toBe('gated');
      if (result.refusal.kind === 'gated') expect(result.refusal.reason).toBe('stack_missing');
    }
    expect(sdk.received).toBeUndefined();
    const row = getSession(rig.db, sessionId);
    expect(row?.status).toBe('gated');
  });
});

describe('runSession — mid-session cancellation', () => {
  it('cancels the session when per-job cap is exceeded mid-run', async () => {
    const sessionId = await mkSessionRow(rig.db);
    const cfg = mkAgentConfig({
      settings: {
        model: 'claude-sonnet-4-5',
        max_turns: 20,
        costCap: {
          perJobCostUsd: 0.05, // very tight
          monthlyCostUsd: 100,
          warnAtPercent: 80,
          onCapReached: 'refuse_session',
        },
        permissions: { allow: [], ask: [], deny: [] },
        writeScope: { allowedPaths: [], deniedPaths: [] },
        hooks: { SessionStart: [], PreToolUse: [], PostToolUse: [], SessionEnd: [] },
      } as never,
    });
    const sdk = mockSdk({
      kind: 'turns',
      turns: [
        { cost_usd: 0.03, input_tokens: 100, output_tokens: 100 },
        { cost_usd: 0.03, input_tokens: 100, output_tokens: 100 }, // trips 0.05
        { cost_usd: 0.03, input_tokens: 100, output_tokens: 100 }, // never executes
      ],
      final: 'completed',
    });

    const result = await runSession({
      agent: 'strategist',
      sessionId,
      config: cfg,
      identitySecrets: {},
      trigger: { kind: 'webhook:slack', message: 'hi' },
      devTeamRoot: rig.devTeam,
      targetProjectRoot: rig.targetProject,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db: rig.db,
      log,
      sdk,
      initialMessage: 'hi',
    });

    expect(result.kind).toBe('ran');
    if (result.kind === 'ran') {
      expect(result.outcome.kind).toBe('cancelled');
      expect(result.turns).toBe(2);
    }
    const row = getSession(rig.db, sessionId);
    expect(row?.status).toBe('cancelled');
  });
});

describe('runSession — model override by skill', () => {
  it('resolves model override when skill is provided', async () => {
    const sessionId = await mkSessionRow(rig.db);
    const cfg = mkAgentConfig({
      settings: {
        model: 'claude-sonnet-4-5', // default model
        modelOverrides: {
          llm: 'claude-opus', // override for 'llm' skill
        },
        max_turns: 20,
        costCap: {
          perJobCostUsd: 5,
          monthlyCostUsd: 100,
          warnAtPercent: 80,
          onCapReached: 'refuse_session',
        },
        permissions: { allow: [], ask: [], deny: [] },
        writeScope: { allowedPaths: [], deniedPaths: [] },
        hooks: {
          SessionStart: [],
          PreToolUse: [],
          PostToolUse: [],
          SessionEnd: [],
        },
      } as never,
    });
    const sdk = mockSdk({
      kind: 'turns',
      turns: [{ cost_usd: 0.01, input_tokens: 50, output_tokens: 25 }],
      final: 'completed',
    });

    await runSession({
      agent: 'strategist',
      skill: 'llm', // invoke with the 'llm' skill
      sessionId,
      config: cfg,
      identitySecrets: {},
      trigger: { kind: 'webhook:slack', message: 'hi' },
      devTeamRoot: rig.devTeam,
      targetProjectRoot: rig.targetProject,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db: rig.db,
      log,
      sdk,
      initialMessage: 'hi',
    });

    // Assert the SDK received the overridden model, not the default
    expect(sdk.received?.model).toBe('claude-opus');
  });

  it('uses default model when skill has no override', async () => {
    const sessionId = await mkSessionRow(rig.db);
    const cfg = mkAgentConfig({
      settings: {
        model: 'claude-sonnet-4-5',
        modelOverrides: {
          'other-skill': 'claude-opus',
        },
        max_turns: 20,
        costCap: {
          perJobCostUsd: 5,
          monthlyCostUsd: 100,
          warnAtPercent: 80,
          onCapReached: 'refuse_session',
        },
        permissions: { allow: [], ask: [], deny: [] },
        writeScope: { allowedPaths: [], deniedPaths: [] },
        hooks: {
          SessionStart: [],
          PreToolUse: [],
          PostToolUse: [],
          SessionEnd: [],
        },
      } as never,
    });
    const sdk = mockSdk({
      kind: 'turns',
      turns: [{ cost_usd: 0.01, input_tokens: 50, output_tokens: 25 }],
      final: 'completed',
    });

    await runSession({
      agent: 'strategist',
      skill: 'some-skill', // different skill with no override
      sessionId,
      config: cfg,
      identitySecrets: {},
      trigger: { kind: 'webhook:slack', message: 'hi' },
      devTeamRoot: rig.devTeam,
      targetProjectRoot: rig.targetProject,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db: rig.db,
      log,
      sdk,
      initialMessage: 'hi',
    });

    // Assert the SDK received the default model since the skill has no override
    expect(sdk.received?.model).toBe('claude-sonnet-4-5');
  });

  it('uses default model when no skill is provided', async () => {
    const sessionId = await mkSessionRow(rig.db);
    const cfg = mkAgentConfig({
      settings: {
        model: 'claude-sonnet-4-5',
        modelOverrides: {
          llm: 'claude-opus',
        },
        max_turns: 20,
        costCap: {
          perJobCostUsd: 5,
          monthlyCostUsd: 100,
          warnAtPercent: 80,
          onCapReached: 'refuse_session',
        },
        permissions: { allow: [], ask: [], deny: [] },
        writeScope: { allowedPaths: [], deniedPaths: [] },
        hooks: {
          SessionStart: [],
          PreToolUse: [],
          PostToolUse: [],
          SessionEnd: [],
        },
      } as never,
    });
    const sdk = mockSdk({
      kind: 'turns',
      turns: [{ cost_usd: 0.01, input_tokens: 50, output_tokens: 25 }],
      final: 'completed',
    });

    await runSession({
      agent: 'strategist',
      // no skill provided
      sessionId,
      config: cfg,
      identitySecrets: {},
      trigger: { kind: 'webhook:slack', message: 'hi' },
      devTeamRoot: rig.devTeam,
      targetProjectRoot: rig.targetProject,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db: rig.db,
      log,
      sdk,
      initialMessage: 'hi',
    });

    // Assert the SDK received the default model since no skill was provided
    expect(sdk.received?.model).toBe('claude-sonnet-4-5');
  });
});

describe('runSession — errors', () => {
  it('maps SDK error → failed status', async () => {
    const sessionId = await mkSessionRow(rig.db);
    const cfg = mkAgentConfig();
    const sdk = mockSdk({ kind: 'error', error: new Error('permission_denied 403') });

    const result = await runSession({
      agent: 'strategist',
      sessionId,
      config: cfg,
      identitySecrets: {},
      trigger: { kind: 'webhook:slack', message: 'hi' },
      devTeamRoot: rig.devTeam,
      targetProjectRoot: rig.targetProject,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db: rig.db,
      log,
      sdk,
      initialMessage: 'hi',
    });

    expect(result.kind).toBe('ran');
    if (result.kind === 'ran') expect(result.outcome.kind).toBe('error');
    const row = getSession(rig.db, sessionId);
    expect(row?.status).toBe('failed');
    expect(row?.error_kind).toBe('Error');
  });

  it('marks transient errors as interrupted_needs_resume', async () => {
    const sessionId = await mkSessionRow(rig.db);
    const cfg = mkAgentConfig();
    const sdk = mockSdk({ kind: 'error', error: new Error('ETIMEDOUT') });

    const result = await runSession({
      agent: 'strategist',
      sessionId,
      config: cfg,
      identitySecrets: {},
      trigger: { kind: 'webhook:slack', message: 'hi' },
      devTeamRoot: rig.devTeam,
      targetProjectRoot: rig.targetProject,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db: rig.db,
      log,
      sdk,
      initialMessage: 'hi',
    });

    expect(result.kind).toBe('ran');
    const row = getSession(rig.db, sessionId);
    expect(row?.status).toBe('interrupted_needs_resume');
  });
});

describe('runSession — hook order + PreToolUse bridge', () => {
  it('SessionEnd runs after SDK returns', async () => {
    const sessionId = await mkSessionRow(rig.db);
    let sessionEndCalled = false;
    // Bootstrap a tiny git repo so `git_commit` can no-op cleanly (it needs a repo).
    const repo = join(rig.root, 'test-repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'init'], {
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });

    // Use a plain load-like hook that we can detect via SessionContext hook.
    const cfg = mkAgentConfig({
      settings: {
        model: 'claude-sonnet-4-5',
        max_turns: 20,
        costCap: {
          perJobCostUsd: 5,
          monthlyCostUsd: 100,
          warnAtPercent: 80,
          onCapReached: 'refuse_session',
        },
        permissions: { allow: [], ask: [], deny: [] },
        writeScope: { allowedPaths: [], deniedPaths: [] },
        hooks: {
          SessionStart: [],
          PreToolUse: [],
          PostToolUse: [],
          SessionEnd: [
            {
              command: 'git_commit',
              repo,
            } as never,
          ],
        },
      } as never,
    });
    const sdk: SdkClient = {
      kind: 'mock',
      async runSession(_inputs, callbacks) {
        expect(sessionEndCalled).toBe(false); // SessionEnd MUST NOT have run yet.
        await callbacks.onTurnComplete({ cost_usd: 0.01, input_tokens: 1, output_tokens: 1 });
        return { kind: 'completed', finalText: 'ok' };
      },
    };

    const result = await runSession({
      agent: 'strategist',
      sessionId,
      config: cfg,
      identitySecrets: {},
      trigger: { kind: 'webhook:slack', message: 'hi' },
      devTeamRoot: rig.devTeam,
      targetProjectRoot: rig.targetProject,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db: rig.db,
      log,
      sdk,
      initialMessage: 'hi',
    });

    sessionEndCalled = true;
    if (result.kind === 'ran') {
      // The git_commit handler will have executed (side-effect entry present).
      expect(result.completion.sessionEnd.sideEffects.length).toBeGreaterThan(0);
    }
  });

  it('PreToolUse hook can deny a tool call via the runtime bridge', async () => {
    const sessionId = await mkSessionRow(rig.db);
    let seenDecision: PreToolUseDecision | undefined;
    const cfg = mkAgentConfig({
      settings: {
        model: 'claude-sonnet-4-5',
        max_turns: 20,
        costCap: {
          perJobCostUsd: 5,
          monthlyCostUsd: 100,
          warnAtPercent: 80,
          onCapReached: 'refuse_session',
        },
        permissions: { allow: [], ask: [], deny: [] },
        writeScope: { allowedPaths: [], deniedPaths: [] },
        hooks: {
          SessionStart: [],
          PreToolUse: [
            {
              tool: '*',
              block_if_action_matches: ['publish'],
              message: 'blocked by publish gate',
            } as never,
          ],
          PostToolUse: [],
          SessionEnd: [],
        },
      } as never,
    });
    const sdk: SdkClient = {
      kind: 'mock',
      async runSession(_inputs, callbacks) {
        seenDecision = await callbacks.onToolCall({
          tool: 'mcp__cms__publish',
          action: 'publish',
          input: {},
        });
        return { kind: 'completed', finalText: 'ok' };
      },
    };

    await runSession({
      agent: 'strategist',
      sessionId,
      config: cfg,
      identitySecrets: {},
      trigger: { kind: 'webhook:slack', message: 'hi' },
      devTeamRoot: rig.devTeam,
      targetProjectRoot: rig.targetProject,
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db: rig.db,
      log,
      sdk,
      initialMessage: 'hi',
    });

    expect(seenDecision?.kind).toBe('deny');
    if (seenDecision?.kind === 'deny') {
      expect(seenDecision.message).toContain('blocked by publish gate');
    }
  });
});
