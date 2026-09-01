import { describe, expect, it } from 'vitest';
import { pickChildBaseEnv, resolveMcpEnv } from '../../src/mcp/env.js';
import { McpEnvResolutionError } from '../../src/mcp/types.js';

describe('resolveMcpEnv', () => {
  it('resolves ${VAR} placeholders from the session env', () => {
    const out = resolveMcpEnv(
      'linear',
      { LINEAR_API_KEY: '${LINEAR_TOKEN}' },
      { LINEAR_TOKEN: 'xoxb-secret' },
    );
    expect(out).toEqual({ LINEAR_API_KEY: 'xoxb-secret' });
  });

  it('passes literal values through unchanged', () => {
    const out = resolveMcpEnv('slack', { SLACK_TEAM_ID: 'T12345' }, {});
    expect(out).toEqual({ SLACK_TEAM_ID: 'T12345' });
  });

  it('handles a mix of placeholders and literals', () => {
    const out = resolveMcpEnv(
      'slack',
      { SLACK_BOT_TOKEN: '${SLACK_TOKEN}', SLACK_TEAM_ID: 'T12345' },
      { SLACK_TOKEN: 'xoxb-abc' },
    );
    expect(out).toEqual({ SLACK_BOT_TOKEN: 'xoxb-abc', SLACK_TEAM_ID: 'T12345' });
  });

  it('throws McpEnvResolutionError on missing ${VAR}', () => {
    expect(() => resolveMcpEnv('github', { GITHUB_TOKEN: '${GH_TOKEN}' }, { OTHER: 'x' })).toThrow(
      McpEnvResolutionError,
    );
  });

  it('error carries server + envKey + missingVar for observability', () => {
    try {
      resolveMcpEnv('github', { GITHUB_TOKEN: '${GH_TOKEN}' }, {});
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(McpEnvResolutionError);
      const e = err as McpEnvResolutionError;
      expect(e.server).toBe('github');
      expect(e.envKey).toBe('GITHUB_TOKEN');
      expect(e.missingVar).toBe('GH_TOKEN');
    }
  });

  it('returns an empty object when env block is empty', () => {
    expect(resolveMcpEnv('any', {}, {})).toEqual({});
  });

  it('substitutes embedded ${VAR} placeholders (needed for HTTP MCP headers)', () => {
    // HTTP MCP servers reference secrets via headers like
    // `"Authorization": "Bearer ${GITHUB_APP_INSTALLATION_TOKEN}"` — an
    // embedded placeholder. The resolver substitutes every ${VAR} match, not
    // only whole-string ones.
    const out = resolveMcpEnv('x', { KEY: 'prefix-${TOKEN}-suffix' }, { TOKEN: 'v' });
    expect(out.KEY).toBe('prefix-v-suffix');
  });

  it('substitutes multiple embedded placeholders in one value', () => {
    const out = resolveMcpEnv(
      'x',
      { AUTH: 'Basic ${USER}:${PASS}' },
      { USER: 'alice', PASS: 'secret' },
    );
    expect(out.AUTH).toBe('Basic alice:secret');
  });

  it('throws when an embedded placeholder is missing from sessionEnv', () => {
    expect(() => resolveMcpEnv('x', { AUTH: 'Bearer ${MISSING}' }, {})).toThrow(
      /MCP env resolution failed/,
    );
  });
});

// pickChildBaseEnv is what gives MCP children a PATH. It used to live in spawn.ts
// beside the router's own spawn call; now the SDK is the only thing that spawns, and
// runtime/sdkCall.ts merges this into every stdio config it hands over. Without it the
// SDK's spawn hits ENOENT on command lookup, so this is load-bearing.
describe('pickChildBaseEnv', () => {
  const BASELINE = ['PATH', 'HOME', 'NODE_PATH', 'LANG', 'LC_ALL'];

  it('forwards PATH so command lookup works in the child', () => {
    expect(pickChildBaseEnv().PATH).toBe(process.env.PATH);
  });

  it("forwards nothing outside the baseline set — never the router's own secrets", () => {
    expect(Object.keys(pickChildBaseEnv()).every((k) => BASELINE.includes(k))).toBe(true);
  });

  it('every forwarded value matches the router env verbatim', () => {
    for (const [key, value] of Object.entries(pickChildBaseEnv())) {
      expect(value).toBe(process.env[key]);
    }
  });

  // A baseline key the router does not have must be ABSENT, not present-and-undefined:
  // assigning undefined into a child env would coerce to the string "undefined".
  it('omits baseline keys the router env does not define', () => {
    const base = pickChildBaseEnv();
    for (const key of BASELINE) {
      if (process.env[key] === undefined) expect(key in base).toBe(false);
    }
    expect(Object.values(base).every((v) => typeof v === 'string')).toBe(true);
  });
});
