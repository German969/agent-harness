// Verifies /metrics is wired into the server + returns Prometheus exposition.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAgentConfigCache } from '../../src/config/agentLoader.js';
import { createMetrics } from '../../src/observability/metrics.js';
import { buildServer } from '../../src/server.js';
import { resetDbForTests } from '../../src/state/db.js';

let tmp: string;
let dbPath: string;

beforeEach(() => {
  resetDbForTests();
  tmp = mkdtempSync(join(tmpdir(), 'metrics-'));
  dbPath = join(tmp, 'state.sqlite');
  // Minimal dev-team dir so identity load doesn't complain.
  mkdirSync(join(tmp, 'identities'), { recursive: true });
  mkdirSync(join(tmp, 'agents'), { recursive: true });
  writeFileSync(
    join(tmp, 'identities', 'strategist.yml'),
    `agent: strategist
github:
  app_slug: "s-bot"
  bot_username: "s-bot"
linear:
  agent_handle: "s"
`,
    'utf-8',
  );
  clearAgentConfigCache();
});
afterEach(() => {
  resetDbForTests();
  rmSync(tmp, { recursive: true, force: true });
});

describe('GET /metrics', () => {
  it('returns Prometheus exposition text', async () => {
    const server = await buildServer({ dbPath, devTeamRoot: tmp });
    try {
      const res = await server.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      const body = res.body;
      expect(body).toContain('# HELP agent_session_total');
      expect(body).toContain('# HELP router_in_flight_sessions');
    } finally {
      await server.close();
    }
  });

  it('accepts an injected metrics registry and returns its data', async () => {
    const m = createMetrics({ includeDefault: false });
    m.sessionTotal.inc({ agent: 'strategist', skill: 'pjm', outcome: 'completed' }, 3);
    const server = await buildServer({ dbPath, devTeamRoot: tmp, metrics: m });
    try {
      const res = await server.inject({ method: 'GET', url: '/metrics' });
      expect(res.body).toMatch(
        /agent_session_total\{agent="strategist",skill="pjm",outcome="completed"\}\s+3/,
      );
    } finally {
      await server.close();
    }
  });
});
