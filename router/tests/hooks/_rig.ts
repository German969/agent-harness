// Shared test rig for hook tests.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { SessionContext, ToolCallContext } from '../../src/hooks/index.js';
import { type Db, applyMigrations, openDb } from '../../src/state/index.js';

export function mkTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'router-hooks-test-'));
}

export function mkDb(): Db {
  const db = openDb({ path: ':memory:' });
  applyMigrations(db);
  return db;
}

export function mkCtx(overrides: Partial<SessionContext> = {}): SessionContext {
  const devTeamRoot = overrides.devTeamRoot ?? '/tmp/nonexistent-devteam';
  const targetProjectRoot = overrides.targetProjectRoot ?? '/tmp/nonexistent-target';
  return {
    agent: 'strategist',
    skill: undefined,
    sessionId: 42,
    claudeSessionId: undefined,
    workspaceDir: undefined,
    trigger: { kind: 'webhook:slack' },
    env: {},
    devTeamRoot,
    targetProjectRoot,
    projectName: 'testproj',
    db: overrides.db ?? mkDb(),
    log: pino({ level: 'silent' }),
    ...overrides,
  };
}

export function mkToolCtx(
  overrides: Partial<ToolCallContext> & { tool: string; input: unknown },
): ToolCallContext {
  return {
    ...mkCtx(overrides),
    tool: overrides.tool,
    action: overrides.action,
    input: overrides.input,
  };
}
