import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadIdentities } from '../../src/routing/index.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'router-loader-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeYml(name: string, contents: string): void {
  writeFileSync(join(dir, `${name}.yml`), contents, 'utf-8');
}

describe('loadIdentities', () => {
  it('returns empty on missing directory', () => {
    const result = loadIdentities('/nonexistent/dir/path');
    expect(result.identities).toEqual([]);
    expect(result.errors[0]?.reason).toMatch(/unreadable dir/);
  });

  it('loads a well-formed identity file', () => {
    writeYml(
      'strategist',
      `
agent: strategist
github:
  app_slug: strategist-bot
  app_id: 12345
  bot_username: strategist-bot[bot]
linear:
  agent_handle: strategist-bot
  agent_id: agent_abc
  user_id: usr_xyz
slack:
  app_id: A0123
  bot_user_id: U0123
routing:
  linear_labels: [prd, research]
  slack_default_channels: []
continuation_timeout_days: 30
secrets:
  github_webhook_secret: GITHUB_APP_WEBHOOK_SECRET_strategist
  linear_webhook_secret: LINEAR_WEBHOOK_SECRET_strategist
  slack_signing_secret: SLACK_SIGNING_SECRET_strategist
`,
    );
    const { identities, errors } = loadIdentities(dir);
    expect(errors).toEqual([]);
    expect(identities).toHaveLength(1);
    expect(identities[0]?.agent).toBe('strategist');
    expect(identities[0]?.github?.app_id).toBe(12345);
    expect(identities[0]?.slack?.bot_user_id).toBe('U0123');
  });

  it('tolerates YAML null placeholders (~)', () => {
    writeYml(
      'guardian',
      `
agent: guardian
github:
  app_slug: guardian-bot
  app_id: ~
  bot_username: guardian-bot[bot]
linear:
  agent_handle: guardian-bot
  agent_id: ~
  user_id: ~
`,
    );
    const { identities, errors } = loadIdentities(dir);
    expect(errors).toEqual([]);
    expect(identities[0]?.github?.app_id).toBeNull();
  });

  it('rejects unknown agent id', () => {
    writeYml('bogus', 'agent: not-a-real-agent');
    const { identities, errors } = loadIdentities(dir);
    expect(identities).toEqual([]);
    expect(errors[0]?.reason).toMatch(/unknown agent id/);
  });

  it('skips non-yml files (README.md etc.)', () => {
    writeFileSync(join(dir, 'README.md'), '# not a YAML file', 'utf-8');
    writeYml(
      'strategist',
      `
agent: strategist
github: { app_slug: x, bot_username: x }
`,
    );
    const { identities, errors } = loadIdentities(dir);
    expect(identities).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('surfaces schema errors without blocking other files', () => {
    writeYml('broken', 'this: is: bad: yaml: because: [colons');
    writeYml('strategist', 'agent: strategist');
    const { identities, errors } = loadIdentities(dir);
    // Broken file should error, but strategist should still load.
    expect(errors).toHaveLength(1);
    expect(identities.some((i) => i.agent === 'strategist')).toBe(true);
  });
});
