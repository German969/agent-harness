import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blockIfActionMatchesHandler } from '../../src/hooks/commands/block_if_action_matches.js';
import { blockIfCommandMatchesHandler } from '../../src/hooks/commands/block_if_command_matches.js';
import { blockIfPathMatchesHandler } from '../../src/hooks/commands/block_if_path_matches.js';
import { checkHandler } from '../../src/hooks/commands/check.js';
import { conditionalLoadHandler } from '../../src/hooks/commands/conditional_load.js';
import { loadHandler } from '../../src/hooks/commands/load.js';
import { validateStructuredDataHandler } from '../../src/hooks/commands/validate_structured_data.js';
import { mkCtx, mkTmpDir, mkToolCtx } from './_rig.js';

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------
describe('load handler', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmpDir();
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('returns concatenated context with per-file headers', async () => {
    writeFileSync(join(tmp, 'a.md'), 'AAA', 'utf-8');
    writeFileSync(join(tmp, 'b.md'), 'BBB', 'utf-8');
    const ctx = mkCtx({ devTeamRoot: tmp });
    const r = await loadHandler({ command: 'load', paths: [`${tmp}/a.md`, `${tmp}/b.md`] }, ctx);
    expect(r.kind).toBe('context');
    if (r.kind === 'context') {
      expect(r.content).toContain('AAA');
      expect(r.content).toContain('BBB');
      expect(r.content).toContain(`# ${tmp}/a.md`);
    }
  });

  it('warns + skips missing files under default policy', async () => {
    const ctx = mkCtx();
    const r = await loadHandler({ command: 'load', paths: [`${tmp}/never-exists.md`] }, ctx);
    expect(r.kind).toBe('context');
    if (r.kind === 'context') expect(r.content).toBe('');
  });

  it('expands ${PROJECT} in the label and surfaces the real on-disk path for state files', async () => {
    // dev-team-state resolves to <devTeamRoot>/../dev-team-state. Lay that out so the
    // load resolves to a real file, and assert the header carries BOTH the resolved
    // logical label (iris, not ${PROJECT}) and the absolute path agents write back to.
    const devTeamRoot = join(tmp, 'dev-team');
    const stateFile = join(tmp, 'dev-team-state', 'projects', 'iris', 'strategist');
    mkdirSync(stateFile, { recursive: true });
    writeFileSync(join(stateFile, 'founding-discussion.md'), 'PRIOR NOTES', 'utf-8');
    const ctx = mkCtx({ devTeamRoot, projectName: 'iris' });

    const r = await loadHandler(
      {
        command: 'load',
        paths: ['dev-team-state/projects/${PROJECT}/strategist/founding-discussion.md'],
      },
      ctx,
    );
    expect(r.kind).toBe('context');
    if (r.kind === 'context') {
      expect(r.content).toContain('PRIOR NOTES');
      // Label has ${PROJECT} expanded to iris, not left literal.
      expect(r.content).toContain(
        '# dev-team-state/projects/iris/strategist/founding-discussion.md',
      );
      // And the real on-disk absolute path is surfaced for reliable read/write.
      expect(r.content).toContain(join(stateFile, 'founding-discussion.md'));
      expect(r.content).toContain('read & write this file at its on-disk path');
    }
  });

  it('only_skills: loads when the session skill is in the list', async () => {
    writeFileSync(join(tmp, 'heavy.md'), 'HEAVY', 'utf-8');
    const ctx = mkCtx({ skill: 'pm' });
    const r = await loadHandler(
      { command: 'load', only_skills: ['pm', 'founding'], paths: [`${tmp}/heavy.md`] },
      ctx,
    );
    expect(r.kind).toBe('context');
    if (r.kind === 'context') expect(r.content).toContain('HEAVY');
  });

  it('only_skills: skips (no read) when the session skill is not in the list', async () => {
    writeFileSync(join(tmp, 'heavy.md'), 'HEAVY', 'utf-8');
    const ctx = mkCtx({ skill: 'conversational' });
    const r = await loadHandler(
      { command: 'load', only_skills: ['pm', 'founding'], paths: [`${tmp}/heavy.md`] },
      ctx,
    );
    expect(r.kind).toBe('side-effect'); // skipped, not loaded
  });

  it('only_skills: skips when the session has no skill', async () => {
    const ctx = mkCtx({ skill: undefined });
    const r = await loadHandler(
      { command: 'load', only_skills: ['pm'], paths: [`${tmp}/heavy.md`] },
      ctx,
    );
    expect(r.kind).toBe('side-effect');
  });

  it('returns error when missing file has policy: error', async () => {
    const ctx = mkCtx();
    const r = await loadHandler(
      { command: 'load', paths: [`${tmp}/nope.md`], missing: 'error' },
      ctx,
    );
    expect(r.kind).toBe('error');
  });

  it('respects per-path missingException override', async () => {
    const ctx = mkCtx();
    const r = await loadHandler(
      {
        command: 'load',
        paths: [`${tmp}/a.md`, `${tmp}/b.md`],
        missing: 'error',
        missingException: { [`${tmp}/b.md`]: 'ignore' },
      },
      ctx,
    );
    // `a.md` is missing and policy 'error' → error
    expect(r.kind).toBe('error');
  });

  it('resolves <target-project> / dev-team-state prefixes', async () => {
    mkdirSync(join(tmp, 'target'), { recursive: true });
    writeFileSync(join(tmp, 'target', 'PRODUCT.md'), 'PRODUCT', 'utf-8');
    const ctx = mkCtx({ targetProjectRoot: join(tmp, 'target') });
    const r = await loadHandler({ command: 'load', paths: ['<target-project>/PRODUCT.md'] }, ctx);
    expect(r.kind).toBe('context');
    if (r.kind === 'context') expect(r.content).toContain('PRODUCT');
  });
});

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------
describe('check handler', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmpDir();
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('returns gate when a required file is missing', async () => {
    const ctx = mkCtx();
    const r = await checkHandler(
      {
        command: 'check',
        if_missing: [`${tmp}/STACK.md`],
        context: 'stack_missing=true',
        message: 'STACK.md is required',
      },
      ctx,
    );
    expect(r.kind).toBe('gate');
    if (r.kind === 'gate') {
      expect(r.reason).toBe('stack_missing=true');
      expect(r.message).toContain('STACK.md');
    }
  });

  it('returns side-effect when all required files present', async () => {
    writeFileSync(join(tmp, 'STACK.md'), 'x', 'utf-8');
    const ctx = mkCtx();
    const r = await checkHandler({ command: 'check', if_missing: [`${tmp}/STACK.md`] }, ctx);
    expect(r.kind).toBe('side-effect');
  });
});

// ---------------------------------------------------------------------------
// conditional_load
// ---------------------------------------------------------------------------
describe('conditional_load handler', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmpDir();
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('loads paths for the active skill', async () => {
    writeFileSync(join(tmp, 'baseline.md'), 'BASELINE', 'utf-8');
    const ctx = mkCtx({ skill: 'llm-security' });
    const r = await conditionalLoadHandler(
      {
        command: 'conditional_load',
        by_skill: {
          'llm-security': [`${tmp}/baseline.md`],
        },
      },
      ctx,
    );
    expect(r.kind).toBe('context');
    if (r.kind === 'context') expect(r.content).toContain('BASELINE');
  });

  it('skips when no active skill', async () => {
    const ctx = mkCtx({ skill: undefined });
    const r = await conditionalLoadHandler(
      { command: 'conditional_load', by_skill: { x: ['nope'] } },
      ctx,
    );
    expect(r.kind).toBe('side-effect');
  });

  it('skips when active skill has no entry', async () => {
    const ctx = mkCtx({ skill: 'unrelated' });
    const r = await conditionalLoadHandler(
      { command: 'conditional_load', by_skill: { 'llm-security': ['nope'] } },
      ctx,
    );
    expect(r.kind).toBe('side-effect');
  });
});

// ---------------------------------------------------------------------------
// block_if_path_matches
// ---------------------------------------------------------------------------
describe('block_if_path_matches handler', () => {
  it('denies when path matches a glob pattern', async () => {
    const ctx = mkToolCtx({
      tool: 'Write',
      input: { file_path: '/repo/server/src/api.ts' },
    });
    const r = await blockIfPathMatchesHandler(
      {
        tool: 'Write',
        block_if_path_matches: ['/repo/server/**/*.ts'],
        message: 'no server writes',
      },
      ctx,
    );
    expect(r.kind).toBe('deny');
    if (r.kind === 'deny') expect(r.message).toBe('no server writes');
  });

  it('allows when path does not match', async () => {
    const ctx = mkToolCtx({
      tool: 'Write',
      input: { file_path: '/repo/client/src/App.tsx' },
    });
    const r = await blockIfPathMatchesHandler(
      { tool: 'Write', block_if_path_matches: ['/repo/server/**'] },
      ctx,
    );
    expect(r.kind).toBe('allow');
  });

  it('allows when tool does not match', async () => {
    const ctx = mkToolCtx({ tool: 'Read', input: { file_path: '/repo/server/x.ts' } });
    const r = await blockIfPathMatchesHandler(
      { tool: 'Write', block_if_path_matches: ['/repo/server/**'] },
      ctx,
    );
    expect(r.kind).toBe('allow');
  });

  it('supports tool: "*" wildcard', async () => {
    const ctx = mkToolCtx({ tool: 'AnyTool', input: { path: '/etc/hosts' } });
    const r = await blockIfPathMatchesHandler(
      { tool: '*', block_if_path_matches: ['/etc/**'] },
      ctx,
    );
    expect(r.kind).toBe('deny');
  });

  it('allows when input has no path field', async () => {
    const ctx = mkToolCtx({ tool: 'Write', input: { other: 'x' } });
    const r = await blockIfPathMatchesHandler(
      { tool: 'Write', block_if_path_matches: ['/x/**'] },
      ctx,
    );
    expect(r.kind).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// block_if_action_matches (Marketer publish-gate)
// ---------------------------------------------------------------------------
describe('block_if_action_matches handler', () => {
  it('denies when action verb matches a pattern (case-insensitive)', async () => {
    const ctx = mkToolCtx({
      tool: 'mcp__cms__publish',
      action: 'publish',
      input: {},
    });
    const r = await blockIfActionMatchesHandler(
      {
        tool: '*',
        block_if_action_matches: ['publish', 'send_now', 'launch'],
        deny_always: true,
        message: '🛑 no publishing',
      },
      ctx,
    );
    expect(r.kind).toBe('deny');
    if (r.kind === 'deny') expect(r.message).toContain('no publishing');
  });

  it('denies when tool NAME contains a pattern (fallback)', async () => {
    const ctx = mkToolCtx({
      tool: 'mcp__email__send_now',
      input: {},
    });
    const r = await blockIfActionMatchesHandler(
      { tool: '*', block_if_action_matches: ['send_now'] },
      ctx,
    );
    expect(r.kind).toBe('deny');
  });

  it('allows unrelated actions', async () => {
    const ctx = mkToolCtx({
      tool: 'mcp__cms__create_draft',
      action: 'create_draft',
      input: {},
    });
    const r = await blockIfActionMatchesHandler(
      { tool: '*', block_if_action_matches: ['publish', 'send'] },
      ctx,
    );
    expect(r.kind).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// block_if_command_matches (git-push-to-main gate + flat tool denials, followup #9)
// ---------------------------------------------------------------------------
describe('block_if_command_matches handler', () => {
  const pushGate = {
    tool: 'Bash',
    patterns: [
      'git push.*\\b(main|master|staging|production|prod)\\b',
      '--no-verify',
      '--force(-with-lease)?\\s+origin/(main|staging)',
    ],
    deny_always: true,
    message: '🛑 PR-only. Push to a feature branch.',
  };

  it('denies a Bash command that matches a push-to-main regex', async () => {
    const ctx = mkToolCtx({ tool: 'Bash', input: { command: 'git push origin main' } });
    const r = await blockIfCommandMatchesHandler(pushGate, ctx);
    expect(r.kind).toBe('deny');
    if (r.kind === 'deny') expect(r.message).toContain('PR-only');
  });

  it('denies a --no-verify bypass attempt', async () => {
    const ctx = mkToolCtx({
      tool: 'Bash',
      input: { command: 'git commit --no-verify -m x' },
    });
    const r = await blockIfCommandMatchesHandler(pushGate, ctx);
    expect(r.kind).toBe('deny');
  });

  it('allows a safe feature-branch push', async () => {
    const ctx = mkToolCtx({
      tool: 'Bash',
      input: { command: 'git push origin HEAD:agent/harness/task-1' },
    });
    const r = await blockIfCommandMatchesHandler(pushGate, ctx);
    expect(r.kind).toBe('allow');
  });

  it('does not fire when the tool filter does not match', async () => {
    const ctx = mkToolCtx({ tool: 'Read', input: { command: 'git push origin main' } });
    const r = await blockIfCommandMatchesHandler(pushGate, ctx);
    expect(r.kind).toBe('allow');
  });

  it('flat-denies a tool with no patterns when deny_always is set', async () => {
    const ctx = mkToolCtx({ tool: 'mcp__github__merge_pull_request', input: {} });
    const r = await blockIfCommandMatchesHandler(
      { tool: 'mcp__github__merge_pull_request', deny_always: true, message: 'humans merge' },
      ctx,
    );
    expect(r.kind).toBe('deny');
    if (r.kind === 'deny') expect(r.message).toContain('humans merge');
  });

  it('flat-denies via a glob tool filter (mcp__infisical__*)', async () => {
    const ctx = mkToolCtx({ tool: 'mcp__infisical__create_secret', input: {} });
    const r = await blockIfCommandMatchesHandler(
      { tool: ['mcp__infisical__*', 'mcp__secrets__*'], deny_always: true },
      ctx,
    );
    expect(r.kind).toBe('deny');
  });

  it('allows an unrelated tool under a flat deny_always filter', async () => {
    const ctx = mkToolCtx({ tool: 'mcp__github__get_file_contents', input: {} });
    const r = await blockIfCommandMatchesHandler(
      { tool: 'mcp__github__merge_pull_request', deny_always: true },
      ctx,
    );
    expect(r.kind).toBe('allow');
  });

  it('supports the singular `pattern` string form', async () => {
    const ctx = mkToolCtx({ tool: 'Bash', input: { command: 'git push origin staging' } });
    const r = await blockIfCommandMatchesHandler(
      { tool: 'Bash', pattern: 'git push.*(main|staging)', deny_always: true },
      ctx,
    );
    expect(r.kind).toBe('deny');
  });

  it('skips an invalid regex without denying', async () => {
    const ctx = mkToolCtx({ tool: 'Bash', input: { command: 'anything' } });
    const r = await blockIfCommandMatchesHandler(
      { tool: 'Bash', patterns: ['('], deny_always: true },
      ctx,
    );
    expect(r.kind).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// validate_structured_data
// ---------------------------------------------------------------------------
describe('validate_structured_data handler', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmpDir();
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('returns ok when JSON parses', async () => {
    const path = join(tmp, 'x.json');
    writeFileSync(path, '{"a":1}', 'utf-8');
    const ctx = mkToolCtx({ tool: 'Write', input: { path } });
    const r = await validateStructuredDataHandler({ tool: 'Write' }, ctx);
    expect(r.kind).toBe('side-effect');
    if (r.kind === 'side-effect') expect(r.summary).toContain('ok');
  });

  it('flags invalid JSON via side-effect data', async () => {
    const path = join(tmp, 'bad.json');
    writeFileSync(path, 'not json', 'utf-8');
    const ctx = mkToolCtx({ tool: 'Write', input: { path } });
    const r = await validateStructuredDataHandler({ tool: 'Write' }, ctx);
    expect(r.kind).toBe('side-effect');
    if (r.kind === 'side-effect') {
      expect(r.summary).toContain('INVALID');
      expect(r.data?.invalid).toBe(true);
    }
  });

  it('ok on YAML', async () => {
    const path = join(tmp, 'x.yml');
    writeFileSync(path, 'a: 1\nb: [1,2,3]', 'utf-8');
    const ctx = mkToolCtx({ tool: 'Write', input: { path } });
    const r = await validateStructuredDataHandler({ tool: 'Write' }, ctx);
    expect(r.kind).toBe('side-effect');
    if (r.kind === 'side-effect') expect(r.summary).toContain('ok');
  });

  it('skips unsupported extensions', async () => {
    const path = join(tmp, 'x.txt');
    writeFileSync(path, 'plain', 'utf-8');
    const ctx = mkToolCtx({ tool: 'Write', input: { path } });
    const r = await validateStructuredDataHandler({ tool: 'Write' }, ctx);
    expect(r.kind).toBe('side-effect');
    if (r.kind === 'side-effect') expect(r.summary).toContain('unsupported');
  });
});
