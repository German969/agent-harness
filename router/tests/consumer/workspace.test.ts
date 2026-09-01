// Worktree acquisition — a work trigger must land the session in a writable
// checkout of the target project.
//
// Regression for 2026-08-28: `acquireWorkspace` was hardcoded false and
// sdkCall pinned cwd to the dev-team repo, so Builder-Server had nowhere to
// write. It could read the target project (mounted read-only) and narrate an
// implementation, but never produce one.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAgentConfigCache } from '../../src/config/agentLoader.js';
import { handleEvent } from '../../src/consumer/consumer.js';
import type { WebhookEvent } from '../../src/ingress/types.js';
import { buildRegistry } from '../../src/routing/index.js';
import type { Identity } from '../../src/routing/schema.js';
import type { SdkCallbacks, SdkClient, SdkRunInputs } from '../../src/runtime/sdk.js';
import type { SessionOutcome } from '../../src/runtime/sdk.js';
import { EnvSecretProvider } from '../../src/secrets/env-provider.js';
import { type Db, applyMigrations, openDb } from '../../src/state/index.js';

const log = pino({ level: 'silent' });

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
}

/** A real git repo — `git worktree add` needs one, and needs it writable. */
function mkSourceRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--initial-branch=main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'README.md'), '# target project', 'utf-8');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'initial');
}

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
    linear: { agent_handle: 'strategist-bot', agent_id: null, user_id: null, webhook_id: 'wh-s' },
    routing: { linear_labels: ['prd'] },
    continuation_timeout_days: 30,
    secrets: {},
  } as unknown as Identity;
}

function mockSdk(): SdkClient & { lastInputs?: SdkRunInputs } {
  const holder: SdkClient & { lastInputs?: SdkRunInputs } = {
    kind: 'mock' as const,
    async runSession(inputs: SdkRunInputs, callbacks: SdkCallbacks): Promise<SessionOutcome> {
      holder.lastInputs = inputs;
      await callbacks.onTurnComplete({ cost_usd: 0.01, input_tokens: 10, output_tokens: 5 });
      callbacks.onPartial({ text: 'ok' });
      return { kind: 'completed', finalText: 'ok' };
    },
  };
  return holder;
}

/** A ticket labelled `prd` — linear_label, which is a work trigger. */
function labelEvent(): WebhookEvent {
  return {
    provider: 'linear',
    delivery_id: 'd-w1',
    event_type: 'Issue.update',
    agent_hint: 'wh-s',
    payload: { data: { identifier: 'IRS-46', labels: [{ name: 'prd' }] } },
    received_at: Date.now(),
  };
}

/** A bare comment with no label — a question, not work. */
function questionEvent(): WebhookEvent {
  return {
    provider: 'linear',
    delivery_id: 'd-w2',
    event_type: 'Comment.create',
    agent_hint: 'wh-s',
    payload: {
      data: { issue: { identifier: 'IRS-46' }, body: 'hey @strategist-bot what is this?' },
    },
    received_at: Date.now(),
  };
}

let db: Db;
let tmp: string;
let source: string;
let worktreeRoot: string;

beforeEach(() => {
  db = openDb({ path: ':memory:' });
  applyMigrations(db);
  tmp = mkdtempSync(join(tmpdir(), 'ws-test-'));
  mkDevTeam(tmp, 'strategist');
  source = join(tmp, 'target');
  mkSourceRepo(source);
  worktreeRoot = join(tmp, 'worktrees');
  clearAgentConfigCache();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function deps(sdk: SdkClient, withWorktrees = true) {
  return {
    db,
    registry: buildRegistry([mkIdentity()]),
    secretProvider: new EnvSecretProvider(),
    sdk,
    log,
    devTeamRoot: tmp,
    targetProjectRoot: source,
    projectName: 'test',
    ...(withWorktrees ? { worktreeRoot, targetBaseBranch: 'main' } : {}),
  };
}

describe('worktree acquisition', () => {
  it('puts a work session in a writable worktree, not the dev-team repo', async () => {
    const sdk = mockSdk();
    const outcome = await handleEvent(labelEvent(), deps(sdk));
    expect(outcome.kind).toBe('dispatched');
    // Surface WHY if the session never reached the SDK — a setup failure is
    // otherwise invisible behind a 'dispatched' outcome.
    if (outcome.kind === 'dispatched') {
      expect(JSON.stringify(outcome.result)).not.toContain('setup_failed');
    }

    const cwd = sdk.lastInputs?.cwd;
    expect(cwd).toBeDefined();
    expect(cwd).not.toBe(tmp); // NOT the dev-team repo — that was the bug
    expect(cwd?.startsWith(worktreeRoot)).toBe(true);
    // A real checkout, not just a directory.
    expect(existsSync(join(cwd as string, 'README.md'))).toBe(true);
    expect(existsSync(join(cwd as string, '.git'))).toBe(true);
  });

  it('still lets the session read the dev-team repo for house style', async () => {
    const sdk = mockSdk();
    await handleEvent(labelEvent(), deps(sdk));
    expect(sdk.lastInputs?.additionalDirectories).toContain(tmp);
  });

  it('gives a question no worktree — it has nothing to build', async () => {
    const sdk = mockSdk();
    const outcome = await handleEvent(questionEvent(), deps(sdk));
    expect(outcome.kind).toBe('dispatched');
    expect(sdk.lastInputs?.cwd).toBe(tmp);
    expect(existsSync(worktreeRoot)).toBe(false);
  });

  it('acquires nothing when no worktree root is configured', async () => {
    const sdk = mockSdk();
    const outcome = await handleEvent(labelEvent(), deps(sdk, false));
    expect(outcome.kind).toBe('dispatched');
    expect(sdk.lastInputs?.cwd).toBe(tmp);
  });

  it('reuses one worktree across two events about the same ticket', async () => {
    const sdk = mockSdk();
    await handleEvent(labelEvent(), deps(sdk));
    const first = sdk.lastInputs?.cwd;
    const second = { ...labelEvent(), delivery_id: 'd-w3' };
    await handleEvent(second, deps(sdk));
    expect(sdk.lastInputs?.cwd).toBe(first);
  });
});
