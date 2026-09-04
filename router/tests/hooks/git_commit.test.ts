// git_commit + git_commit_if_changed handlers — tested against a real temp git repo.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  gitCommitHandler,
  isRepoWritable,
  resolveRepoPath,
} from '../../src/hooks/commands/git_commit.js';
import {
  computeLabels,
  gitCommitIfChangedHandler,
} from '../../src/hooks/commands/git_commit_if_changed.js';
import { MemoryAlertPoster } from '../../src/observability/alerts.js';
import { mkCtx } from './_rig.js';

let tempDir: string;
let devTeam: string;

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'router-git-commit-test-'));
  devTeam = join(tempDir, 'dev-team');
  execFileSync('git', ['init', '-b', 'main', devTeam], { stdio: 'ignore' });
  writeFileSync(join(devTeam, 'README.md'), '# dev-team\n', 'utf-8');
  git(devTeam, ['add', '.']);
  git(devTeam, ['commit', '-m', 'init']);
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('git_commit', () => {
  it('commits staged changes with resolved message', async () => {
    // Make a change:
    writeFileSync(join(devTeam, 'README.md'), '# dev-team\n\nchanged\n', 'utf-8');
    const ctx = mkCtx({
      devTeamRoot: devTeam,
      sessionId: 77,
      agent: 'harness',
    });
    const r = await gitCommitHandler(
      {
        command: 'git_commit',
        repo: 'dev-team',
        paths: ['.'],
        message_template: '[harness] session ${SESSION_ID} — test',
      },
      ctx,
    );
    expect(r.kind).toBe('side-effect');
    // Verify the commit is on the branch.
    const log = execFileSync('git', ['-C', devTeam, 'log', '--oneline', '-1'], {
      encoding: 'utf-8',
    });
    expect(log).toContain('[harness] session 77 — test');
  });

  it('no-ops when there are no changes', async () => {
    const ctx = mkCtx({ devTeamRoot: devTeam });
    const r = await gitCommitHandler({ command: 'git_commit', repo: 'dev-team' }, ctx);
    expect(r.kind).toBe('side-effect');
    if (r.kind === 'side-effect') expect(r.summary).toContain('no changes');
  });

  it('attributes the commit to the agent (works without ambient git identity)', async () => {
    writeFileSync(join(devTeam, 'README.md'), '# dev-team\n\nagent edit\n', 'utf-8');
    const ctx = mkCtx({ devTeamRoot: devTeam, agent: 'strategist' });
    const r = await gitCommitHandler({ command: 'git_commit', repo: 'dev-team' }, ctx);
    expect(r.kind).toBe('side-effect');
    const author = execFileSync('git', ['-C', devTeam, 'log', '-1', '--format=%an <%ae>'], {
      encoding: 'utf-8',
    }).trim();
    expect(author).toBe('strategist-agent <strategist@dev-team.local>');
  });

  it('skips cleanly (no error) when the repo mount is not writable', async () => {
    // A read-only bind mount (Harness's dev-team) is not writable; the handler
    // must skip with a side-effect rather than erroring every session (followup #8).
    const ctx = mkCtx({ devTeamRoot: join(tempDir, 'does-not-exist-ro') });
    const r = await gitCommitHandler({ command: 'git_commit', repo: 'dev-team' }, ctx);
    expect(r.kind).toBe('side-effect');
    if (r.kind === 'side-effect') expect(r.summary).toContain('skipped');
  });

  it('resolves ${PROJECT} in paths and skips subtrees that do not exist', async () => {
    // The agent wrote project state but no global state, so `global/strategist/`
    // was never created. The hook must resolve ${PROJECT} → the real project name
    // AND not fatal on the missing global subtree (regression: unresolved ${PROJECT}
    // + a non-matching pathspec was aborting every SessionEnd commit).
    const projDir = join(devTeam, 'projects', 'chatbots', 'strategist');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 'founding-discussion.md'), 'notes\n', 'utf-8');
    const ctx = mkCtx({ devTeamRoot: devTeam, agent: 'strategist', projectName: 'chatbots' });

    const r = await gitCommitHandler(
      {
        command: 'git_commit',
        repo: 'dev-team',
        paths: ['global/strategist/**', 'projects/${PROJECT}/strategist/**'],
        message_template: '[strategist] ${PROJECT} state',
      },
      ctx,
    );
    expect(r.kind).toBe('side-effect');

    const files = execFileSync('git', ['-C', devTeam, 'ls-tree', '-r', '--name-only', 'HEAD'], {
      encoding: 'utf-8',
    });
    expect(files).toContain('projects/chatbots/strategist/founding-discussion.md');
    const log = execFileSync('git', ['-C', devTeam, 'log', '--oneline', '-1'], {
      encoding: 'utf-8',
    });
    expect(log).toContain('chatbots state');
  });

  it('reports no matching paths (and does not fatal) when no configured subtree exists', async () => {
    const ctx = mkCtx({ devTeamRoot: devTeam, agent: 'strategist', projectName: 'chatbots' });
    const r = await gitCommitHandler(
      {
        command: 'git_commit',
        repo: 'dev-team',
        paths: ['global/strategist/**', 'projects/${PROJECT}/strategist/**'],
      },
      ctx,
    );
    expect(r.kind).toBe('side-effect');
    if (r.kind === 'side-effect') expect(r.summary).toContain('no matching paths');
  });

  it('pushes the commit to origin when push:true', async () => {
    const origin = join(tempDir, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
    git(devTeam, ['remote', 'add', 'origin', origin]);
    git(devTeam, ['push', 'origin', 'main']); // seed origin with the init commit
    writeFileSync(join(devTeam, 'state.md'), 'agent state\n', 'utf-8');
    const ctx = mkCtx({ devTeamRoot: devTeam, agent: 'strategist', sessionId: 5 });

    const r = await gitCommitHandler({ command: 'git_commit', repo: 'dev-team', push: true }, ctx);
    expect(r.kind).toBe('side-effect');
    if (r.kind === 'side-effect') expect(r.data?.push).toBe('pushed');

    // The commit + file landed on origin's main.
    const files = execFileSync('git', ['-C', origin, 'ls-tree', '--name-only', 'main'], {
      encoding: 'utf-8',
    });
    expect(files).toContain('state.md');
  });

  it('rebases + retries when origin advanced (concurrent writer, disjoint paths)', async () => {
    const origin = join(tempDir, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
    git(devTeam, ['remote', 'add', 'origin', origin]);
    git(devTeam, ['push', 'origin', 'main']);

    // A second agent pushes a disjoint file, moving origin/main ahead of us.
    const other = join(tempDir, 'other');
    execFileSync('git', ['clone', origin, other], { stdio: 'ignore' });
    writeFileSync(join(other, 'other-agent.md'), 'other\n', 'utf-8');
    git(other, ['add', '.']);
    git(other, ['commit', '-m', 'other agent']);
    git(other, ['push', 'origin', 'main']);

    // Our commit is now behind origin. The hook's first push is rejected → it must
    // fetch + rebase (no content conflict — disjoint files) + push successfully.
    writeFileSync(join(devTeam, 'my-agent.md'), 'mine\n', 'utf-8');
    const ctx = mkCtx({ devTeamRoot: devTeam, agent: 'strategist' });
    const r = await gitCommitHandler({ command: 'git_commit', repo: 'dev-team', push: true }, ctx);
    expect(r.kind).toBe('side-effect');
    if (r.kind === 'side-effect') expect(r.data?.push).toBe('pushed');

    // Origin now carries BOTH agents' files — the rebase preserved the other commit.
    const files = execFileSync('git', ['-C', origin, 'ls-tree', '--name-only', 'main'], {
      encoding: 'utf-8',
    });
    expect(files).toContain('other-agent.md');
    expect(files).toContain('my-agent.md');
  });

  it('reports no-remote (but still commits locally) when origin is absent', async () => {
    writeFileSync(join(devTeam, 'z.md'), 'z\n', 'utf-8'); // devTeam has no origin configured
    const ctx = mkCtx({ devTeamRoot: devTeam, agent: 'strategist' });
    const r = await gitCommitHandler({ command: 'git_commit', repo: 'dev-team', push: true }, ctx);
    expect(r.kind).toBe('side-effect');
    if (r.kind === 'side-effect') expect(r.data?.push).toBe('no-remote');
    // The commit still landed locally — push is best-effort on top of a durable commit.
    const log = execFileSync('git', ['-C', devTeam, 'log', '--oneline', '-1'], {
      encoding: 'utf-8',
    });
    expect(log).toContain('strategist');
  });
});

describe('push-stuck alert', () => {
  // A failed push of the state repo means the fleet's memory did not leave the box,
  // and nothing downstream notices: the commit is local, the session succeeds, and
  // the summary says `push: failed` in a log nobody reads. It also does not
  // self-clear — a conflicted rebase aborts, so every later push fails the same way.
  it('posts state_push_failed when the push cannot land', async () => {
    git(devTeam, ['remote', 'add', 'origin', join(tempDir, 'does-not-exist.git')]);
    writeFileSync(join(devTeam, 'memory.md'), 'a lesson worth keeping\n', 'utf-8');
    const alerts = new MemoryAlertPoster();
    const ctx = mkCtx({
      devTeamRoot: devTeam,
      agent: 'builder-server',
      sessionId: 61,
      alertPoster: alerts,
    });

    const r = await gitCommitHandler({ command: 'git_commit', repo: 'dev-team', push: true }, ctx);

    expect(r.kind).toBe('side-effect');
    if (r.kind === 'side-effect') expect(r.data?.push).toBe('failed');
    expect(alerts.messages).toHaveLength(1);
    expect(alerts.messages[0]?.title).toBe('state_push_failed');
    expect(alerts.messages[0]?.level).toBe('error');
    // The local commit is still the durable floor — the alert is about reach, not loss.
    expect(
      execFileSync('git', ['-C', devTeam, 'log', '--oneline'], { encoding: 'utf-8' })
        .trim()
        .split('\n'),
    ).toHaveLength(2);
  });

  it('stays quiet when the push succeeds', async () => {
    const origin = join(tempDir, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
    git(devTeam, ['remote', 'add', 'origin', origin]);
    git(devTeam, ['push', 'origin', 'main']);
    writeFileSync(join(devTeam, 'memory.md'), 'a lesson worth keeping\n', 'utf-8');
    const alerts = new MemoryAlertPoster();
    const ctx = mkCtx({ devTeamRoot: devTeam, agent: 'builder-server', alertPoster: alerts });

    await gitCommitHandler({ command: 'git_commit', repo: 'dev-team', push: true }, ctx);

    expect(alerts.messages).toEqual([]);
  });

  it('a session with no alerter still succeeds', async () => {
    git(devTeam, ['remote', 'add', 'origin', join(tempDir, 'nope.git')]);
    writeFileSync(join(devTeam, 'memory.md'), 'x\n', 'utf-8');
    const r = await gitCommitHandler(
      { command: 'git_commit', repo: 'dev-team', push: true },
      mkCtx({ devTeamRoot: devTeam, agent: 'builder-server' }),
    );
    expect(r.kind).toBe('side-effect');
  });
});

describe('shared/ tier in dev-team-state', () => {
  // The failure this guards against is silent: resolveAddPaths DROPS a configured
  // path that does not exist on disk, so an agent could write shared/ notes all
  // session and the SessionEnd commit would skip them without a word — the same
  // shape as `push: true` on a handler that could not read it.
  it('commits a shared/ write alongside the agent’s own subtree', async () => {
    mkdirSync(join(devTeam, 'shared', 'process'), { recursive: true });
    mkdirSync(join(devTeam, 'global', 'harness'), { recursive: true });
    writeFileSync(join(devTeam, 'shared', 'process', 'note.md'), '# shared note\n', 'utf-8');
    writeFileSync(join(devTeam, 'global', 'harness', 'own.md'), '# own state\n', 'utf-8');
    const ctx = mkCtx({ devTeamRoot: devTeam, agent: 'harness', sessionId: 51 });

    const r = await gitCommitHandler(
      {
        command: 'git_commit',
        repo: 'dev-team',
        paths: ['shared/**', 'global/harness/**'],
      },
      ctx,
    );

    expect(r.kind).toBe('side-effect');
    const tracked = execFileSync('git', ['-C', devTeam, 'ls-files'], { encoding: 'utf-8' });
    expect(tracked).toContain('shared/process/note.md');
    expect(tracked).toContain('global/harness/own.md');
  });

  it('skips shared/ cleanly when the tier is not on disk yet', async () => {
    // The live VPS clone predates the shared/ tier, so this is the state a real
    // agent hits until the volume gets it. It must be a clean skip, not a fatal
    // `git add` pathspec error that fails the whole SessionEnd hook.
    mkdirSync(join(devTeam, 'global', 'harness'), { recursive: true });
    writeFileSync(join(devTeam, 'global', 'harness', 'own.md'), '# own state\n', 'utf-8');
    const ctx = mkCtx({ devTeamRoot: devTeam, agent: 'harness', sessionId: 52 });

    const r = await gitCommitHandler(
      {
        command: 'git_commit',
        repo: 'dev-team',
        paths: ['shared/**', 'global/harness/**'],
      },
      ctx,
    );

    expect(r.kind).toBe('side-effect');
    const tracked = execFileSync('git', ['-C', devTeam, 'ls-files'], { encoding: 'utf-8' });
    expect(tracked).toContain('global/harness/own.md');
  });
});

describe('isRepoWritable', () => {
  it('returns true for a writable dir and false for a missing/unwritable path', async () => {
    expect(await isRepoWritable(devTeam)).toBe(true);
    expect(await isRepoWritable(join(tempDir, 'nope'))).toBe(false);
  });
});

describe('git_commit_if_changed', () => {
  // These two used to assert `data.pr_labels` came back on the result — the "PR
  // queued" intent that nothing consumed. The handler opens the PR now, so the
  // result carries pr_number/pr_url or pr_error instead, and the labels are sent
  // to GitHub rather than returned. The label RULES keep direct coverage below;
  // the attempt is covered in tests/hooks/create_pr.test.ts.
  it('commits and attempts the PR when create_pr: true', async () => {
    writeFileSync(join(devTeam, 'x.md'), '# x\n', 'utf-8');
    const ctx = mkCtx({ devTeamRoot: devTeam, sessionId: 88, agent: 'harness' });
    const r = await gitCommitIfChangedHandler(
      {
        command: 'git_commit_if_changed',
        repo: 'dev-team',
        message_template: '[harness] test PR ${SESSION_ID}',
        create_pr: true,
        pr_labels: ['agent:harness-bot'],
      },
      ctx,
    );
    expect(r.kind).toBe('side-effect');
    if (r.kind === 'side-effect') {
      expect(r.data?.create_pr).toBe(true);
      // No remote and no token in this rig, so the attempt fails and SAYS so —
      // which is the point. Silence here was the bug.
      expect(r.data?.pr_error).toBeDefined();
      expect(r.summary).toContain('PR NOT opened');
    }
  });

  it('computes PR labels, including the conditional skill rule', () => {
    expect(
      computeLabels(
        {
          pr_labels: ['agent:harness-bot'],
          auto_apply_conditional_labels: { _misbehavior_debugger: 'urgent' },
        },
        { skill: 'misbehavior-debugger' },
      ),
    ).toEqual(['agent:harness-bot', 'urgent']);

    // `pr_label` (singular) is the spelling three agents use; dropping it is how
    // an `agent:<name>` owner label goes missing and the classifier stops routing
    // that PR's events back to its owner.
    expect(computeLabels({ pr_label: 'agent:marketer-bot' }, {})).toEqual(['agent:marketer-bot']);

    // The rule must not fire for another skill.
    expect(
      computeLabels(
        { pr_labels: ['a'], auto_apply_conditional_labels: { _misbehavior_debugger: 'urgent' } },
        { skill: 'qa' },
      ),
    ).toEqual(['a']);
  });

  it('no-ops when nothing changed', async () => {
    const ctx = mkCtx({ devTeamRoot: devTeam });
    const r = await gitCommitIfChangedHandler(
      { command: 'git_commit_if_changed', repo: 'dev-team' },
      ctx,
    );
    expect(r.kind).toBe('side-effect');
    if (r.kind === 'side-effect') expect(r.summary).toContain('no changes');
  });

  it('skips cleanly (no error) when the repo mount is not writable', async () => {
    const ctx = mkCtx({ devTeamRoot: join(tempDir, 'does-not-exist-ro'), agent: 'harness' });
    const r = await gitCommitIfChangedHandler(
      { command: 'git_commit_if_changed', repo: 'dev-team', create_pr: true },
      ctx,
    );
    expect(r.kind).toBe('side-effect');
    if (r.kind === 'side-effect') expect(r.summary).toContain('skipped');
  });

  // The regression this handler shipped with. Both Builders' `<workspace>` hook was
  // configured `push: true` from the day it landed (PR #29), and this handler had no
  // push support at all — no field, no call — so the flag was silently ignored. The
  // same PR wired the idle worktree pruner, which runs `git worktree remove --force`
  // and does not care about unpushed commits. Net: the truncation-durability fix made
  // the WIP commit and the pruner then deleted it.
  it('pushes the commit to origin when push:true', async () => {
    const origin = join(tempDir, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
    git(devTeam, ['remote', 'add', 'origin', origin]);
    git(devTeam, ['push', 'origin', 'main']);
    writeFileSync(join(devTeam, 'wip.md'), 'half-finished work\n', 'utf-8');
    const ctx = mkCtx({ devTeamRoot: devTeam, agent: 'builder-server', sessionId: 41 });

    const r = await gitCommitIfChangedHandler(
      { command: 'git_commit_if_changed', repo: 'dev-team', push: true },
      ctx,
    );

    expect(r.kind).toBe('side-effect');
    if (r.kind === 'side-effect') {
      expect(r.data?.push).toBe('pushed');
      expect(r.summary).toContain('push: pushed');
    }
    // Landing on origin is the whole point — a local commit in a worktree the
    // pruner will remove is not durability.
    const files = execFileSync('git', ['-C', origin, 'ls-tree', '--name-only', 'main'], {
      encoding: 'utf-8',
    });
    expect(files).toContain('wip.md');
  });

  it('does not push when push is not set', async () => {
    const origin = join(tempDir, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
    git(devTeam, ['remote', 'add', 'origin', origin]);
    git(devTeam, ['push', 'origin', 'main']);
    writeFileSync(join(devTeam, 'local.md'), 'local only\n', 'utf-8');
    const ctx = mkCtx({ devTeamRoot: devTeam, agent: 'guardian', sessionId: 42 });

    const r = await gitCommitIfChangedHandler(
      { command: 'git_commit_if_changed', repo: 'dev-team' },
      ctx,
    );

    expect(r.kind).toBe('side-effect');
    if (r.kind === 'side-effect') expect(r.data?.push).toBeUndefined();
    const files = execFileSync('git', ['-C', origin, 'ls-tree', '--name-only', 'main'], {
      encoding: 'utf-8',
    });
    expect(files).not.toContain('local.md');
  });

  it('a push failure never fails the session — the local commit still stands', async () => {
    // No remote configured. The commit is the durable floor; the push is best-effort.
    writeFileSync(join(devTeam, 'orphan.md'), 'no remote here\n', 'utf-8');
    const ctx = mkCtx({ devTeamRoot: devTeam, agent: 'builder-server', sessionId: 43 });

    const r = await gitCommitIfChangedHandler(
      { command: 'git_commit_if_changed', repo: 'dev-team', push: true },
      ctx,
    );

    expect(r.kind).toBe('side-effect');
    if (r.kind === 'side-effect') expect(r.data?.push).toBe('no-remote');
    const log = execFileSync('git', ['-C', devTeam, 'log', '--oneline'], { encoding: 'utf-8' });
    expect(log.trim().split('\n')).toHaveLength(2);
  });
});

describe('<workspace> repo alias', () => {
  it('resolves to the leased worktree', () => {
    const ctx = mkCtx({ devTeamRoot: devTeam, workspaceDir: '/var/lib/agents/worktrees/x/y' });
    expect(resolveRepoPath('<workspace>', ctx)).toBe('/var/lib/agents/worktrees/x/y');
  });

  // A question or a closed-PR reply leases no worktree. Returning undefined lets
  // the handler skip; before, an alias with no path fell through to `return repo`
  // and git would have been pointed at the literal string "<workspace>".
  it('is undefined when the session leased no worktree', () => {
    expect(resolveRepoPath('<workspace>', mkCtx({ devTeamRoot: devTeam }))).toBeUndefined();
  });

  it('both commit handlers skip cleanly rather than failing the session', async () => {
    const ctx = mkCtx({ devTeamRoot: devTeam });
    for (const handler of [gitCommitHandler, gitCommitIfChangedHandler]) {
      const res = await handler({ repo: '<workspace>' }, ctx);
      expect(res.kind).toBe('side-effect');
      expect(res.kind === 'side-effect' && res.summary).toContain('skipped');
    }
  });

  // The durability case: a session cut off mid-work leaves edits in the worktree.
  // Without this hook they stay uncommitted — on disk only, invisible in git.
  it('commits uncommitted worktree edits so a cut-off session leaves a real commit', async () => {
    const workspace = join(tempDir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    git(workspace, ['init', '-q', '-b', 'agent/builder-server/task']);
    writeFileSync(join(workspace, 'seed.txt'), 'seed\n');
    git(workspace, ['add', '.']);
    git(workspace, ['commit', '-q', '-m', 'seed']);

    writeFileSync(join(workspace, 'half-done.ts'), 'export const x = 1;\n');
    const ctx = mkCtx({ devTeamRoot: devTeam, workspaceDir: workspace });
    const res = await gitCommitIfChangedHandler(
      { repo: '<workspace>', message_template: '[WIP] session ${SESSION_ID}' },
      ctx,
    );

    expect(res.kind).toBe('side-effect');
    const log = execFileSync('git', ['-C', workspace, 'log', '-1', '--pretty=%s'], {
      encoding: 'utf8',
    }).trim();
    expect(log).toContain('[WIP]');
    const dirty = execFileSync('git', ['-C', workspace, 'status', '--porcelain'], {
      encoding: 'utf8',
    }).trim();
    expect(dirty).toBe('');
  });
});
