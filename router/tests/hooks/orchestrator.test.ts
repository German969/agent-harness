import { describe, expect, it } from 'vitest';
import { runSessionPhase, runToolCallPhase } from '../../src/hooks/index.js';
import { mkCtx, mkToolCtx } from './_rig.js';

// Uses handlers registered in the registry. These tests focus on aggregation +
// gate/deny short-circuit behavior, not on individual handler correctness
// (covered by commands.test.ts).

describe('runSessionPhase', () => {
  it('collects context from multiple load-like entries', async () => {
    const ctx = mkCtx();
    const result = await runSessionPhase(
      [
        { command: 'load', paths: [] }, // no paths → error
      ],
      ctx,
      'SessionStart',
    );
    expect(result.errors).toHaveLength(1);
  });

  it('first gate short-circuits the phase', async () => {
    const ctx = mkCtx();
    const result = await runSessionPhase(
      [
        {
          command: 'check',
          if_missing: ['/never-exists-1'],
          context: 'gate1',
        },
        // This would run if gate1 didn't stop the chain:
        {
          command: 'check',
          if_missing: ['/never-exists-2'],
          context: 'gate2',
        },
      ],
      ctx,
      'SessionStart',
    );
    expect(result.gate).toBeDefined();
    if (result.gate) expect(result.gate.reason).toBe('gate1');
  });

  it('unknown command is skipped with a warning', async () => {
    const ctx = mkCtx();
    const result = await runSessionPhase([{ command: 'unknown_command_xyz' }], ctx, 'SessionStart');
    // No error, no gate, no context — just a silent skip.
    expect(result.errors).toEqual([]);
    expect(result.gate).toBeUndefined();
  });

  it('entry with no command is skipped', async () => {
    const ctx = mkCtx();
    const result = await runSessionPhase([{}], ctx, 'SessionStart');
    expect(result.errors).toEqual([]);
  });
});

describe('runToolCallPhase', () => {
  it('first deny short-circuits the phase', async () => {
    const ctx = mkToolCtx({ tool: 'mcp__cms__publish', action: 'publish', input: {} });
    const result = await runToolCallPhase(
      [
        {
          tool: '*',
          block_if_action_matches: ['publish'],
          message: 'nope',
        },
        // A second hook that would allow this — but never runs because first denies.
        {
          tool: '*',
          block_if_action_matches: ['nonexistent-verb'],
        },
      ],
      ctx,
      'PreToolUse',
    );
    expect(result.deny).toEqual({ message: 'nope' });
  });

  it('all allow → no deny, no side-effects', async () => {
    const ctx = mkToolCtx({ tool: 'Read', input: {} });
    const result = await runToolCallPhase(
      [
        {
          tool: 'Write',
          block_if_action_matches: ['publish'],
        },
      ],
      ctx,
      'PreToolUse',
    );
    expect(result.deny).toBeUndefined();
    expect(result.errors).toEqual([]);
  });

  it('side-effect handlers accumulate summaries', async () => {
    const ctx = mkToolCtx({ tool: 'Write', input: { path: '/tmp/x.txt' } });
    const result = await runToolCallPhase(
      [{ command: 'validate_structured_data', tool: 'Write' }],
      ctx,
      'PostToolUse',
    );
    expect(result.sideEffects).toHaveLength(1);
  });

  it('supports shape-based inference for block_if_action_matches', async () => {
    const ctx = mkToolCtx({ tool: 'mcp__cms__publish', action: 'publish', input: {} });
    // Note: no `command:` field — inferred from shape
    const result = await runToolCallPhase(
      [{ tool: '*', block_if_action_matches: ['publish'] }],
      ctx,
      'PreToolUse',
    );
    expect(result.deny).toBeDefined();
  });

  // Followup #9 regression: the `patterns` + `deny_always` shape used by every
  // agent's push-to-main gate must be inferred and actually deny (was skipped).
  it('infers block_if_command_matches from `patterns` + `deny_always` and denies push-to-main', async () => {
    const ctx = mkToolCtx({ tool: 'Bash', input: { command: 'git push origin main' } });
    const result = await runToolCallPhase(
      [
        {
          tool: 'Bash',
          patterns: ['git push.*\\b(main|master|staging)\\b'],
          deny_always: true,
          message: '🛑 PR-only.',
        },
      ],
      ctx,
      'PreToolUse',
    );
    expect(result.deny).toEqual({ message: '🛑 PR-only.' });
  });

  it('infers a flat tool denial from bare `deny_always`', async () => {
    const ctx = mkToolCtx({ tool: 'mcp__github__merge_pull_request', input: {} });
    const result = await runToolCallPhase(
      [{ tool: 'mcp__github__merge_pull_request', deny_always: true, message: 'humans merge' }],
      ctx,
      'PreToolUse',
    );
    expect(result.deny).toEqual({ message: 'humans merge' });
  });

  // This used to assert the opposite — that an `if_url_or_query_matches` entry was
  // SKIPPED, because inferCommand excluded the shape from block_if_command_matches
  // "so we never over-block them". The exclusion was right; the consequence was
  // that Marketer's login-gated-fetch policy never blocked anything either. It now
  // routes to its own handler, which checks the URL and query rather than the
  // generic command haystack — so the original over-blocking concern is still
  // honoured, which is what the second half of this test pins.
  it('routes a deny_always guarded by if_url_or_query_matches to its own handler', async () => {
    const entry = {
      tool: ['WebFetch', 'WebSearch'],
      if_url_or_query_matches: ['login'],
      deny_always: true,
    };

    const denied = await runToolCallPhase(
      [entry],
      mkToolCtx({ tool: 'WebFetch', input: { url: 'https://x.com/login' } }),
      'PreToolUse',
    );
    expect(denied.deny).toBeDefined();

    // Not over-blocked: a URL that does not match the rule still passes, and the
    // rule is checked against the URL, not against a stringified input blob.
    const allowed = await runToolCallPhase(
      [entry],
      mkToolCtx({ tool: 'WebFetch', input: { url: 'https://x.com/pricing' } }),
      'PreToolUse',
    );
    expect(allowed.deny).toBeUndefined();
  });
});
