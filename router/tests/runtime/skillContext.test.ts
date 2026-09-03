// Delivering the resolved skill's procedure to the session.
//
// `AgentConfig.skills` has been loaded and unread since agentLoader was written:
// the classifier resolved a SkillId, the router used it for model / MCP / hook
// gating, and the session was never told which skill it was in or what that skill
// says to do. The wiring test at the bottom is the load-bearing half — the block
// being correct is not the same as it reaching the SDK.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConfig } from '../../src/config/index.js';
import { runSession } from '../../src/runtime/index.js';
import type {
  SdkCallbacks,
  SdkClient,
  SdkRunInputs,
  SessionOutcome,
} from '../../src/runtime/sdk.js';
import { skillContextBlock } from '../../src/runtime/skillContext.js';
import { EnvSecretProvider } from '../../src/secrets/env-provider.js';
import { type Db, applyMigrations, openDb } from '../../src/state/index.js';
import { createSession } from '../../src/state/sessions.js';

const log = pino({ level: 'silent' });

function cfgWith(skills: Record<string, string>): AgentConfig {
  return {
    agent: 'builder-server',
    claudeMd: '# Builder-Server',
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
      hooks: { SessionStart: [], PreToolUse: [], PostToolUse: [], SessionEnd: [] },
    } as never,
    mcp: { mcpServers: {} } as never,
    skills: new Map(Object.entries(skills)),
  } as AgentConfig;
}

const meta = { agent: 'builder-server' as const, sessionId: 1, log };

describe('skillContextBlock', () => {
  it('names the active skill and carries its body', () => {
    const block = skillContextBlock(
      cfgWith({ 'pr-feedback': '## Procedure\n1. Identify the event type.' }),
      'pr-feedback',
      meta,
    );
    // The name matters on its own: every CLAUDE.md refers to skills by name
    // ("see the `pr-feedback` skill"), so a body with no label reads as one more
    // reference document rather than as the procedure for this session.
    expect(block?.content).toContain('# Active skill: pr-feedback');
    expect(block?.content).toContain('1. Identify the event type.');
    expect(block?.tag).toBe('active-skill');
  });

  it('returns undefined — never throws — when the skill has no file', () => {
    // Exactly today's behaviour for every session, and an agent that still has its
    // CLAUDE.md beats a refused session. The CI gate below keeps it from being silent.
    expect(skillContextBlock(cfgWith({}), 'pr-feedback', meta)).toBeUndefined();
  });

  it('returns undefined when no skill resolved', () => {
    expect(skillContextBlock(cfgWith({ backend: 'x' }), undefined, meta)).toBeUndefined();
  });
});

describe('every skill the router can resolve to has a file', () => {
  // The gate that makes the mapping safe. Routing to a skill with no file
  // delivers no procedure at all — the same silent gap one level up. Also
  // enforced in validate-fleet-config.ts, which runs on `agents/**` edits; this
  // one runs on `router/**`, where the mapping itself lives.
  const agentsDir = join(process.cwd(), '..', 'agents');
  const agents = readdirSync(agentsDir).filter((n) => statSync(join(agentsDir, n)).isDirectory());

  it.each(agents)('%s has conversational.md', (agent) => {
    expect(existsSync(join(agentsDir, agent, 'skills', 'conversational.md'))).toBe(true);
  });

  it('both Builders have the pr-feedback.md the router now routes PR events to', () => {
    for (const agent of ['builder-server', 'builder-client']) {
      expect(existsSync(join(agentsDir, agent, 'skills', 'pr-feedback.md'))).toBe(true);
    }
  });
});

describe('wiring — the block reaches the SDK', () => {
  let db: Db;
  let root: string;

  beforeEach(() => {
    db = openDb({ path: ':memory:' });
    applyMigrations(db);
    root = mkdtempSync(join(tmpdir(), 'skillctx-'));
    mkdirSync(join(root, 'dev-team'), { recursive: true });
    mkdirSync(join(root, 'target'), { recursive: true });
    writeFileSync(join(root, 'target', 'STACK.md'), 'stack', 'utf-8');
    writeFileSync(join(root, 'target', 'SYSTEM.md'), 'system', 'utf-8');
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function capturingSdk(): SdkClient & { received?: SdkRunInputs } {
    const holder: SdkClient & { received?: SdkRunInputs } = {
      kind: 'mock' as const,
      async runSession(inputs: SdkRunInputs, cb: SdkCallbacks): Promise<SessionOutcome> {
        holder.received = inputs;
        await cb.onTurnComplete({ cost_usd: 0.01, input_tokens: 10, output_tokens: 5 });
        return { kind: 'completed', finalText: 'ok' };
      },
    };
    return holder;
  }

  async function run(skill: string | undefined, skills: Record<string, string>) {
    const sdk = capturingSdk();
    const sessionId = await createSession(db, {
      agent: 'builder-server',
      thread_key: 't',
      status: 'pending',
      triggered_by: 'webhook:github',
      trigger_payload: {},
    });
    await runSession({
      agent: 'builder-server',
      ...(skill ? { skill } : {}),
      sessionId,
      config: cfgWith(skills),
      identitySecrets: {},
      trigger: { kind: 'webhook:github', message: 'review comment' },
      devTeamRoot: join(root, 'dev-team'),
      targetProjectRoot: join(root, 'target'),
      projectName: 'test',
      acquireWorkspace: false,
      secretProvider: new EnvSecretProvider(),
      db,
      log,
      sdk,
      initialMessage: 'review comment',
    } as never);
    return sdk;
  }

  it('leads initialContext with the active skill', async () => {
    const sdk = await run('pr-feedback', { 'pr-feedback': 'LESSON CAPTURE STEP' });
    expect(sdk.received?.initialContext?.[0]?.tag).toBe('active-skill');
    expect(sdk.received?.initialContext?.[0]?.content).toContain('LESSON CAPTURE STEP');
  });

  it('sends nothing extra when the skill has no file', async () => {
    const sdk = await run('pr-feedback', {});
    expect(sdk.received?.initialContext?.some((c) => c.tag === 'active-skill')).toBe(false);
  });
});
