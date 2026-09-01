import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitSessionEnv, githubHttpsAuthEnv } from '../../src/runtime/gitEnv.js';

let repo: string;

/**
 * Run git with ONLY the given overrides on top of a deliberately identity-free
 * environment. GIT_CONFIG_GLOBAL/SYSTEM are neutered so the developer's own
 * ~/.gitconfig cannot supply user.name and make a failing case pass locally —
 * the router container has no git identity, and these tests have to model that.
 */
function git(args: string[], overrides: Record<string, string> = {}): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      ...overrides,
    },
  });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'git-env-'));
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'f.txt'), 'hello\n');
  execFileSync('git', ['-C', repo, 'add', 'f.txt']);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('gitSessionEnv identity', () => {
  it('names the agent as author and committer', () => {
    const env = gitSessionEnv('builder-server', undefined);
    expect(env.GIT_AUTHOR_NAME).toBe('builder-server-agent');
    expect(env.GIT_AUTHOR_EMAIL).toBe('builder-server@dev-team.local');
    expect(env.GIT_COMMITTER_NAME).toBe('builder-server-agent');
    expect(env.GIT_COMMITTER_EMAIL).toBe('builder-server@dev-team.local');
  });

  // The defect this fixes: the router image configures no user.name/user.email, so
  // an agent that wrote code could not commit it. Without the env this throws.
  it('is enough for `git commit` to succeed with no configured user', () => {
    expect(() => git(['commit', '-m', 'x'])).toThrow();

    git(['commit', '-m', 'landed'], gitSessionEnv('builder-server', undefined));

    expect(git(['log', '-1', '--pretty=%an <%ae>']).trim()).toBe(
      'builder-server-agent <builder-server@dev-team.local>',
    );
  });
});

describe('githubHttpsAuthEnv', () => {
  it('carries the token as a basic-auth header for x-access-token', () => {
    const env = githubHttpsAuthEnv('ghs_tok');
    const header = env.GIT_CONFIG_VALUE_1 ?? '';
    const encoded = header.replace('Authorization: Basic ', '');
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('x-access-token:ghs_tok');
  });

  it('declares a count matching the pairs it sets', () => {
    const env = githubHttpsAuthEnv('ghs_tok');
    const count = Number(env.GIT_CONFIG_COUNT);
    for (let i = 0; i < count; i++) {
      expect(env[`GIT_CONFIG_KEY_${i}`], `key ${i}`).toBeTypeOf('string');
      expect(env[`GIT_CONFIG_VALUE_${i}`], `value ${i}`).toBeTypeOf('string');
    }
    // A count that overruns its pairs makes every later git command fail outright.
    expect(env[`GIT_CONFIG_KEY_${count}`]).toBeUndefined();
  });

  // Proves the encoding is one git actually accepts — a malformed count or key
  // makes git exit non-zero rather than ignore it, so this would fail loudly.
  it('is applied by real git as config', () => {
    const env = githubHttpsAuthEnv('ghs_tok');
    expect(git(['config', '--get', 'url.https://github.com/.insteadOf'], env).trim()).toBe(
      'git@github.com:',
    );
    expect(git(['config', '--get', 'http.https://github.com/.extraheader'], env).trim()).toContain(
      'Authorization: Basic ',
    );
  });

  // The rewrite is what routes a push away from the container's pinned
  // dev-team-state deploy key and onto the App token.
  it('rewrites the mirror ssh remote to https', () => {
    git(['remote', 'add', 'origin', 'git@github.com:German969/chatbots.git']);
    const env = githubHttpsAuthEnv('ghs_tok');
    expect(git(['remote', 'get-url', 'origin'], env).trim()).toBe(
      'https://github.com/German969/chatbots.git',
    );
  });
});

describe('gitSessionEnv auth', () => {
  it('leaves an ssh remote alone when there is no token', () => {
    const env = gitSessionEnv('builder-server', undefined);
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();

    git(['remote', 'add', 'origin', 'git@github.com:German969/chatbots.git']);
    expect(git(['remote', 'get-url', 'origin'], env).trim()).toBe(
      'git@github.com:German969/chatbots.git',
    );
  });

  it('combines identity and auth when a token is present', () => {
    const env = gitSessionEnv('builder-server', 'ghs_tok');
    expect(env.GIT_AUTHOR_NAME).toBe('builder-server-agent');
    expect(env.GIT_CONFIG_KEY_0).toBe('url.https://github.com/.insteadOf');
  });
});
