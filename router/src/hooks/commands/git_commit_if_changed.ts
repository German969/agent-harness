// SessionEnd hook — command: 'git_commit_if_changed' with optional `create_pr: true`
//
// - Stages + commits the requested paths (like `git_commit`).
// - If `create_pr: true`: pushes the branch and OPENS the PR.
//
// That last part used to be a promise. The handler returned the PR intent as
// side-effect data, deferring the call to "Phase 6d's SessionEnd runner", and
// nothing anywhere consumed it — four agents carry the flag and none has ever
// opened a PR. It now opens one, over the REST API, with the App installation
// token the session already holds.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { minimatch } from 'minimatch';
import {
  type OpenPullRequestResult,
  PullRequestClient,
  parseGithubRemote,
} from '../../github/pullRequest.js';
import { contextVars, resolveVars } from '../placeholder.js';
import type { HookHandler, HookResult, SessionContext } from '../types.js';
import {
  type PushResult,
  gitEnvFor,
  isRepoWritable,
  pushToOrigin,
  resolveAddPaths,
  resolveRepoPath,
} from './git_commit.js';

const execFileP = promisify(execFile);

type GitCommitIfChangedConfig = {
  repo: string;
  paths?: unknown;
  message_template?: string;
  /**
   * Push the commit to origin. Required for `<workspace>`: a leased worktree is
   * reclaimed by the idle pruner (`git worktree remove --force`, which does not
   * care about unpushed commits), so a commit that is never pushed is a commit
   * that gets deleted. Both Builders configured `push: true` from the day the
   * `<workspace>` hook shipped; this handler ignored it, so the truncation-
   * durability fix committed the work and the pruner then removed it.
   */
  push?: boolean;
  create_pr?: boolean;
  // `pr_template` used to sit here. Nothing ever read it, and Harness was the only
  // config to set it (`"harness"`), naming a template that exists nowhere. The PR
  // body it wanted is PROTOCOLS.md §7's Harness Change Protocol structure — Summary /
  // Rationale / Changes / Cross-impact / Test plan / Risk / Agents affected — which
  // the agent writes with real content rather than a static string. Use
  // `pr_body_template` for a fixed preamble; anything else the agent authors.
  /** Labels applied to the opened PR. `pr_label` (a single string) is the older
   *  spelling three agents still use; both are read so neither is silently
   *  dropped — an `agent:<name>` owner label going missing is what makes the
   *  GitHub classifier stop routing that PR's events to its owner. */
  pr_labels?: string[];
  pr_label?: string;
  pr_body_template?: string;
  auto_apply_conditional_labels?: Record<string, string>;
};

export const gitCommitIfChangedHandler: HookHandler = async (config, ctx): Promise<HookResult> => {
  const cfg = config as GitCommitIfChangedConfig;
  const repoPath = resolveRepoPath(cfg.repo, ctx);
  if (!repoPath) {
    // `<workspace>` on a session that leased no worktree — nothing to commit.
    ctx.log.debug({ repo: cfg.repo }, 'git_commit_if_changed: no path for repo alias; skipped');
    return {
      kind: 'side-effect',
      summary: `git_commit_if_changed: ${cfg.repo} not present; skipped`,
    };
  }
  const vars = contextVars(ctx);
  const messageTemplate =
    cfg.message_template ?? `[${ctx.agent}] session ${ctx.sessionId} — auto-commit`;
  const message = resolveVars(messageTemplate, vars);

  if (!(await isRepoWritable(repoPath))) {
    ctx.log.debug(
      { repo: cfg.repo, repoPath },
      'git_commit_if_changed: repo mount is read-only; skipped',
    );
    return {
      kind: 'side-effect',
      summary: `git_commit_if_changed: ${cfg.repo} mount is read-only; skipped`,
    };
  }

  const paths = resolveAddPaths(cfg.paths, repoPath, vars);
  if (paths.length === 0) {
    return {
      kind: 'side-effect',
      summary: `git_commit_if_changed: no matching paths in ${cfg.repo}`,
    };
  }

  try {
    await execFileP('git', ['-C', repoPath, 'add', '--', ...paths]);
    const { stdout } = await execFileP('git', ['-C', repoPath, 'status', '--porcelain']);
    if (stdout.trim().length === 0) {
      return { kind: 'side-effect', summary: `git_commit_if_changed: no changes in ${cfg.repo}` };
    }

    const gitEnv = gitEnvFor(cfg.repo, ctx);
    await execFileP('git', ['-C', repoPath, 'commit', '-m', message], { env: gitEnv });

    // Off-box durability. Best-effort, exactly as in git_commit: the local commit
    // has already landed, so a push failure is a warning, never a session error.
    let push: PushResult | undefined;
    if (cfg.push) {
      push = await pushToOrigin(repoPath, gitEnv, ctx.log);
    }

    if (cfg.create_pr === true) {
      // A PR needs a head ref on the remote. `push` is a separate option and three
      // of the four create_pr configs do not set it, so the PR path pushes on its
      // own behalf rather than opening a PR against a branch that is not there.
      if (!push) push = await pushToOrigin(repoPath, gitEnv, ctx.log);

      const pr = await openPr(repoPath, message, cfg, ctx);
      const suffix = pr.ok
        ? ` — PR #${pr.result.number}${pr.result.reused ? ' (already open)' : ''} ${pr.result.url}`
        : ` — PR NOT opened: ${pr.reason}`;
      return {
        kind: 'side-effect',
        summary: `git_commit_if_changed: committed to ${cfg.repo}${push ? ` (push: ${push})` : ''}${suffix}`,
        data: {
          repo: cfg.repo,
          message,
          ...(push ? { push } : {}),
          create_pr: true,
          ...(pr.ok
            ? { pr_number: pr.result.number, pr_url: pr.result.url, pr_reused: pr.result.reused }
            : { pr_error: pr.reason }),
        },
      };
    }

    return {
      kind: 'side-effect',
      summary: `git_commit_if_changed: committed to ${cfg.repo}${push ? ` (push: ${push})` : ''}`,
      data: { repo: cfg.repo, message, ...(push ? { push } : {}) },
    };
  } catch (err) {
    ctx.log.error({ repo: cfg.repo, err: (err as Error).message }, 'git_commit_if_changed: failed');
    return { kind: 'error', error: err as Error };
  }
};

/**
 * Compute the effective set of PR labels: `pr_labels` / `pr_label`, then every
 * `auto_apply_conditional_labels` rule whose condition holds.
 *
 * The condition-key mini-DSL:
 *   - a path glob (e.g. `agents/harness/**`) — any changed path matches it
 *   - `_multiple_agents` — the changed paths fall under two or more `agents/<name>/` dirs
 *   - `_misbehavior_debugger` — the active skill is misbehavior-debugger
 *
 * Until HAR-13 only the last was implemented; the two path-based kinds waited on a
 * "Phase 6d" that never came, so `meta-self-modify`, `router-change` and
 * `cross-agent` were declared on Harness and applied by nothing. `changedPaths` is
 * the PR's diff against its base (`changedPathsForPr`). When it is undefined — the
 * diff could not be read — path conditions are skipped rather than guessed, and the
 * caller logs that it happened.
 */
export function computeLabels(
  cfg: {
    pr_labels?: string[];
    pr_label?: string;
    auto_apply_conditional_labels?: Record<string, string>;
  },
  ctx: { skill?: string | undefined },
  changedPaths?: readonly string[],
): string[] {
  const labels = new Set([...(cfg.pr_labels ?? []), ...(cfg.pr_label ? [cfg.pr_label] : [])]);
  const rules = cfg.auto_apply_conditional_labels ?? {};

  for (const [condition, label] of Object.entries(rules)) {
    if (conditionHolds(condition, ctx, changedPaths)) labels.add(label);
  }

  return [...labels];
}

function conditionHolds(
  condition: string,
  ctx: { skill?: string | undefined },
  changedPaths: readonly string[] | undefined,
): boolean {
  if (condition === '_misbehavior_debugger') return ctx.skill === 'misbehavior-debugger';
  if (changedPaths === undefined) return false;
  if (condition === '_multiple_agents') return agentsTouched(changedPaths).size >= 2;
  // Any other `_`-prefixed key is a condition this code does not know. Not matching
  // it is the safe reading: a label applied on a guess is worse than one missing.
  if (condition.startsWith('_')) return false;
  return changedPaths.some((path) => minimatch(path, condition, { dot: true }));
}

/** The agents whose own directory a set of paths touches. `agents/PROTOCOLS.md` and
 *  other files directly under `agents/` belong to no one agent and are not counted. */
export function agentsTouched(paths: readonly string[]): Set<string> {
  const agents = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    if (parts[0] === 'agents' && parts.length >= 3 && parts[1]) agents.add(parts[1]);
  }
  return agents;
}

/**
 * Paths the PR changes: `git diff --name-only <base>...HEAD`, the same three-dot
 * range GitHub shows as the PR's files. Tries `origin/<base>` first, then a local
 * `<base>`. Undefined when neither ref resolves — never a guess.
 */
export async function changedPathsForPr(
  repoPath: string,
  base: string,
): Promise<string[] | undefined> {
  for (const ref of [`origin/${base}`, base]) {
    try {
      const { stdout } = await execFileP('git', [
        '-C',
        repoPath,
        'diff',
        '--name-only',
        `${ref}...HEAD`,
      ]);
      return stdout.split('\n').filter((line) => line !== '');
    } catch {
      // try the next ref
    }
  }
  return undefined;
}

type PrOutcome = { ok: true; result: OpenPullRequestResult } | { ok: false; reason: string };

/**
 * Open the PR for the commit just made. Never throws: the commit and the push
 * have already landed, so a PR that cannot be opened is a warning plus an alert,
 * not a failed session — the same posture `git_commit` takes on a failed push.
 *
 * It is an ALERT rather than a log line because a draft that commits and never
 * surfaces looks exactly like a session that had nothing to say.
 */
async function openPr(
  repoPath: string,
  message: string,
  cfg: GitCommitIfChangedConfig,
  ctx: SessionContext,
): Promise<PrOutcome> {
  const token = ctx.env.GITHUB_APP_INSTALLATION_TOKEN;
  if (!token) {
    return await failPr('no GITHUB_APP_INSTALLATION_TOKEN in the session env', cfg, ctx);
  }

  let owner: string;
  let repo: string;
  let head: string;
  let base: string;
  try {
    // Branch first: "is there anything to open a PR FROM" is prior to "where would
    // it go", and it keeps the message specific when a session has committed
    // straight to the default branch — which is a different problem entirely.
    head = (
      await execFileP('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'])
    ).stdout.trim();
    base = await defaultBranch(repoPath);
    if (head === base) {
      return await failPr(
        `HEAD is the default branch (${base}); nothing to open a PR from`,
        cfg,
        ctx,
      );
    }

    const remote = (
      await execFileP('git', ['-C', repoPath, 'remote', 'get-url', 'origin'])
    ).stdout.trim();
    const parsed = parseGithubRemote(remote);
    if (!parsed) return await failPr(`origin is not a GitHub remote (${remote})`, cfg, ctx);
    owner = parsed.owner;
    repo = parsed.repo;
  } catch (err) {
    return await failPr(`could not read the repo's git refs: ${(err as Error).message}`, cfg, ctx);
  }

  const hasPathRules = Object.keys(cfg.auto_apply_conditional_labels ?? {}).some(
    (condition) => condition !== '_misbehavior_debugger',
  );
  const changedPaths = hasPathRules ? await changedPathsForPr(repoPath, base) : [];
  if (changedPaths === undefined) {
    ctx.log.warn(
      { repo: cfg.repo, base },
      'git_commit_if_changed: could not diff against the base branch; path-based PR labels skipped',
    );
  }
  const labels = computeLabels(cfg, ctx, changedPaths);
  const body = cfg.pr_body_template
    ? resolveVars(cfg.pr_body_template, contextVars(ctx))
    : undefined;

  try {
    const result = await PullRequestClient.fromToken(token).open({
      owner,
      repo,
      head,
      base,
      title: message.split('\n')[0] ?? message,
      body,
      labels,
    });
    if (result.labelError) {
      ctx.log.warn(
        { repo: cfg.repo, pr: result.number },
        `git_commit_if_changed: ${result.labelError}`,
      );
    }
    ctx.log.info(
      { repo: cfg.repo, pr: result.number, url: result.url, reused: result.reused },
      'git_commit_if_changed: pull request open',
    );
    return { ok: true, result };
  } catch (err) {
    return await failPr((err as Error).message, cfg, ctx);
  }
}

/** The default branch, from origin/HEAD; `main` when the ref is not set. */
async function defaultBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileP('git', [
      '-C',
      repoPath,
      'symbolic-ref',
      '--short',
      'refs/remotes/origin/HEAD',
    ]);
    const ref = stdout.trim();
    return ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref || 'main';
  } catch {
    return 'main';
  }
}

async function failPr(
  reason: string,
  cfg: GitCommitIfChangedConfig,
  ctx: SessionContext,
): Promise<PrOutcome> {
  ctx.log.warn({ repo: cfg.repo, reason }, 'git_commit_if_changed: could not open the PR');
  if (ctx.alertPoster) {
    try {
      const what = `Committed to ${cfg.repo} but could not open the pull request.`;
      const why = 'The commit is on a branch nobody is looking at';
      const fix = `until someone opens the PR by hand — ${reason}.`;
      await ctx.alertPoster.post({
        agent: ctx.agent,
        channel: '#agents-alerts',
        level: 'error',
        title: 'pr_open_failed',
        body: `${what} ${why} ${fix}`,
        fields: { repo: cfg.repo, sessionId: ctx.sessionId },
      });
    } catch (err) {
      ctx.log.warn({ err: (err as Error).message }, 'git_commit_if_changed: alert failed');
    }
  }
  return { ok: false, reason };
}
