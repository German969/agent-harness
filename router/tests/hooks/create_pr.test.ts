// `create_pr: true` reaching the PR-open path at all.
//
// The unit tests for the API client live in tests/github/pullRequest.test.ts.
// This is the wiring half: before this change the handler returned "PR queued"
// as side-effect data that nothing consumed, and four agents carried the flag
// without a PR ever being opened. What is asserted here is that the handler now
// TRIES — and that when it cannot, it says so loudly instead of reporting success.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitCommitIfChangedHandler } from '../../src/hooks/commands/git_commit_if_changed.js';
import { MemoryAlertPoster } from '../../src/observability/alerts.js';
import { mkCtx, mkTmpDir } from './_rig.js';

/** A real git repo with a real (local, bare) origin and one branch off main. */
function mkRepoOnBranch(): string {
  const root = mkTmpDir();
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  execFileSync('git', ['-C', work, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', work, 'config', 'user.name', 't']);
  mkdirSync(join(work, 'drafts'), { recursive: true });
  writeFileSync(join(work, 'drafts', 'seed.md'), 'seed', 'utf-8');
  execFileSync('git', ['-C', work, 'add', '-A']);
  execFileSync('git', ['-C', work, 'commit', '-qm', 'seed']);
  execFileSync('git', ['-C', work, 'remote', 'add', 'origin', origin]);
  execFileSync('git', ['-C', work, 'push', '-q', 'origin', 'main']);
  execFileSync('git', ['-C', work, 'checkout', '-qb', 'agent/marketer-bot/launch']);
  writeFileSync(join(work, 'drafts', 'launch.md'), 'draft body', 'utf-8');
  return work;
}

function cfg(repo: string) {
  return {
    repo,
    paths: ['**'],
    message_template: '[marketer] campaign-lead: Q4 launch',
    create_pr: true,
    pr_label: 'agent:marketer-bot',
  };
}

describe('git_commit_if_changed with create_pr', () => {
  it('commits, pushes, and reports the PR could not be opened without a token', async () => {
    // The failure path is the one reachable without a network, and it is the one
    // that matters: it proves the handler now runs the PR step. The old handler
    // returned "PR queued" here and called it a success.
    const work = mkRepoOnBranch();
    const alerts = new MemoryAlertPoster();
    const ctx = mkCtx({ agent: 'marketer', workspaceDir: work, alertPoster: alerts, env: {} });

    const res = await gitCommitIfChangedHandler(cfg(work), ctx);

    expect(res.kind).toBe('side-effect');
    const summary = (res as { summary: string }).summary;
    expect(summary).toContain('PR NOT opened');
    expect(summary).toContain('GITHUB_APP_INSTALLATION_TOKEN');
    expect(summary).not.toContain('PR queued');

    // The commit and the push still landed — the PR is best-effort on top.
    const log = execFileSync('git', ['-C', work, 'log', '--oneline', '-1'], { encoding: 'utf-8' });
    expect(log).toContain('[marketer] campaign-lead: Q4 launch');
    const remote = execFileSync(
      'git',
      ['-C', work, 'ls-remote', '--heads', 'origin', 'agent/marketer-bot/launch'],
      { encoding: 'utf-8' },
    );
    expect(remote.trim().length).toBeGreaterThan(0);
  });

  it('alerts, because a draft that commits and never surfaces looks like silence', async () => {
    const work = mkRepoOnBranch();
    const alerts = new MemoryAlertPoster();
    const ctx = mkCtx({ agent: 'marketer', workspaceDir: work, alertPoster: alerts, env: {} });

    await gitCommitIfChangedHandler(cfg(work), ctx);

    expect(alerts.messages).toHaveLength(1);
    expect(alerts.messages[0]?.title).toBe('pr_open_failed');
    expect(alerts.messages[0]?.channel).toBe('#agents-alerts');
  });

  it('refuses to open a PR from the default branch onto itself', async () => {
    const work = mkRepoOnBranch();
    execFileSync('git', ['-C', work, 'checkout', '-q', 'main']);
    writeFileSync(join(work, 'drafts', 'onmain.md'), 'x', 'utf-8');
    const ctx = mkCtx({
      agent: 'marketer',
      workspaceDir: work,
      env: { GITHUB_APP_INSTALLATION_TOKEN: 'ghs_fake' },
    });

    const res = await gitCommitIfChangedHandler(cfg(work), ctx);

    // Reached before any network call, so this asserts the guard and not a 4xx.
    expect((res as { summary: string }).summary).toContain('HEAD is the default branch');
  });

  it('a session with no alerter still succeeds', async () => {
    const work = mkRepoOnBranch();
    const ctx = mkCtx({ agent: 'marketer', workspaceDir: work, env: {} });
    const res = await gitCommitIfChangedHandler(cfg(work), ctx);
    expect(res.kind).toBe('side-effect');
  });
});
