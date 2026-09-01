// Platform's production-safety backstop.
//
// `permissions.deny` becomes the SDK's disallowedTools, whose Bash rules are
// PREFIX rules: `Bash(terraform apply:*)` matches a command that STARTS WITH
// `terraform apply`. Platform's config says a hook re-checks the final invocation
// for exactly that reason — and the hook had no handler, so nothing did.
//
// Each denial below is a command the SDK's prefix rule does NOT match.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAgentConfigCache } from '../../src/config/agentLoader.js';
import {
  bashDenyPrefixes,
  commandSegments,
  reCheckAgainstDenyPatternsHandler as handler,
} from '../../src/hooks/commands/re_check_against_deny_patterns.js';
import { getToolCallHandler, inferCommand } from '../../src/hooks/registry.js';
import { mkToolCtx } from './_rig.js';

const HOOK = { tool: 'Bash', re_check_against_deny_patterns: true, on_block_message: '🛑 nope' };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recheck-'));
  const dir = join(root, 'agents', 'platform');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), '# platform', 'utf-8');
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      model: 'claude-sonnet-5',
      max_turns: 40,
      costCap: {
        perJobCostUsd: 6,
        monthlyCostUsd: 100,
        warnAtPercent: 80,
        onCapReached: 'refuse_session',
      },
      permissions: {
        allow: ['Bash(ls:*)'],
        ask: [],
        deny: [
          'Bash(terraform apply:*)',
          'Bash(terraform destroy:*)',
          'Bash(kubectl delete:*)',
          'mcp__secrets__*',
        ],
      },
      writeScope: { allowedPaths: [], deniedPaths: [] },
      hooks: { SessionStart: [], PreToolUse: [], PostToolUse: [], SessionEnd: [] },
    }),
    'utf-8',
  );
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: {} }), 'utf-8');
  clearAgentConfigCache();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(command: string) {
  return handler(
    HOOK,
    mkToolCtx({ tool: 'Bash', input: { command }, agent: 'platform', devTeamRoot: root }),
  );
}

describe('re_check_against_deny_patterns', () => {
  it('is inferred from its shape — it carries no command, patterns or validate key', async () => {
    expect(inferCommand({ tool: 'Bash', re_check_against_deny_patterns: true })).toBe(
      're_check_against_deny_patterns',
    );
  });

  it('is registered, so the dispatcher actually reaches it', () => {
    // Inference without registration is still a no-op hook — which is the exact
    // failure this whole handler exists to correct.
    expect(getToolCallHandler('re_check_against_deny_patterns')).toBe(handler);
  });

  it('denies a chained command the prefix rule misses', async () => {
    // `git status && terraform apply` starts with `git status`, so disallowedTools
    // never matches it. This is the plain, no-adversary version of the bypass.
    const r = await run('git status && terraform apply -auto-approve');
    expect(r.kind).toBe('deny');
    if (r.kind === 'deny') expect(r.message).toBe('🛑 nope');
  });

  it('denies through a shell wrapper', async () => {
    expect((await run('sh -c "terraform destroy -auto-approve"')).kind).toBe('deny');
  });

  it('denies through command substitution', async () => {
    expect((await run('echo $(kubectl delete pod web-1)')).kind).toBe('deny');
    expect((await run('echo `terraform apply`')).kind).toBe('deny');
  });

  it('denies a command split by quotes', async () => {
    expect((await run('terraform "app"ly -auto-approve')).kind).toBe('deny');
  });

  it('denies past sudo and leading env assignments', async () => {
    expect((await run('sudo terraform apply')).kind).toBe('deny');
    expect((await run('TF_LOG=debug terraform apply')).kind).toBe('deny');
  });

  it('still denies the plain form the SDK rule already covers', async () => {
    expect((await run('terraform apply')).kind).toBe('deny');
  });

  it('allows an ordinary command', async () => {
    expect((await run('git status')).kind).toBe('allow');
    expect((await run('terraform plan')).kind).toBe('allow');
  });

  it('does not fire on a mention of a denied command inside another argument', async () => {
    // Over-blocking is its own outage. These are prefix comparisons, so a denied
    // string appearing as an argument is not a denied invocation.
    expect((await run('echo "run terraform apply by hand"')).kind).toBe('allow');
    expect((await run('grep -r "kubectl delete" docs/')).kind).toBe('allow');
  });

  it('does not deny a prefix that is only a word-prefix of the program', async () => {
    // `terraform applyx` is not `terraform apply`.
    expect((await run('terraform applyx')).kind).toBe('allow');
  });

  it('ignores tools it is not configured for, and inputs with no command', async () => {
    const other = await handler(
      HOOK,
      mkToolCtx({ tool: 'Write', input: { command: 'terraform apply' }, agent: 'platform' }),
    );
    expect(other.kind).toBe('allow');
    expect((await run('   ')).kind).toBe('allow');
  });

  it('fails open when the agent config cannot be read — the SDK rule still stands', async () => {
    const r = await handler(
      HOOK,
      mkToolCtx({
        tool: 'Bash',
        input: { command: 'terraform apply' },
        agent: 'platform',
        devTeamRoot: join(root, 'does-not-exist'),
      }),
    );
    expect(r.kind).toBe('allow');
  });
});

describe('bashDenyPrefixes', () => {
  it('reads Bash(...) rules and drops the :* marker, ignoring non-Bash denials', () => {
    expect(
      bashDenyPrefixes(['Bash(terraform apply:*)', 'mcp__secrets__*', 'Bash(rm -rf /)', 'Write']),
    ).toEqual(['terraform apply', 'rm -rf /']);
  });
});

describe('commandSegments', () => {
  it('yields every command a shell would run, not just the first', () => {
    expect(commandSegments('a && b || c; d | e')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('terminates on nested substitution rather than spinning', () => {
    expect(() => commandSegments('$(a $(b $(c)))'.repeat(20))).not.toThrow();
  });
});
