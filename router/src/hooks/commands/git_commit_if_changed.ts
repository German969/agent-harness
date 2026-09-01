// SessionEnd hook — command: 'git_commit_if_changed' with optional `create_pr: true`
//
// - Stages + commits the requested paths (like `git_commit`).
// - If `create_pr: true`: pushes the branch + opens a PR via the GitHub MCP layer.
//   The actual PR-open call is wired at Phase 6d (SDK-invocation orchestrator);
//   Phase 6b returns the intent as `side-effect` data for the caller to act on.
//
// Marketer, Guardian, and Harness all use this — Harness's PR-only enforcement
// depends on `create_pr: true` being forced (its SessionEnd config sets it).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { contextVars, resolveVars } from '../placeholder.js';
import type { HookHandler, HookResult } from '../types.js';
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
  pr_template?: string;
  pr_labels?: string[];
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
      // The PR-open call needs GitHub MCP + branch push — that lands in Phase 6d.
      // For Phase 6b we return the PR intent as side-effect data so downstream
      // orchestration (Phase 6d's SessionEnd runner) can dispatch to the GitHub MCP.
      const labels = computeLabels(cfg, ctx);
      return {
        kind: 'side-effect',
        summary: `git_commit_if_changed: committed to ${cfg.repo}${push ? ` (push: ${push})` : ''}; PR queued`,
        data: {
          repo: cfg.repo,
          message,
          ...(push ? { push } : {}),
          create_pr: true,
          pr_template: cfg.pr_template,
          pr_labels: labels,
          pr_body_template: cfg.pr_body_template,
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
 * Compute the effective set of PR labels. Starts with pr_labels, then applies
 * the auto_apply_conditional_labels rules (used by Harness's meta-self-modify /
 * router-change / cross-agent / urgent auto-labels).
 *
 * The condition-key mini-DSL:
 *   - Path pattern (e.g. `agents/harness/**`) — applies label if any modified path matches
 *   - `_multiple_agents` — applies if diff touches ≥2 agents (impl in Phase 6d)
 *   - `_misbehavior_debugger` — applies if the active skill is misbehavior-debugger
 *
 * Phase 6b implements the skill-based auto-label; path-based conditions land in
 * Phase 6d when we have access to the actual diff.
 */
function computeLabels(
  cfg: { pr_labels?: string[]; auto_apply_conditional_labels?: Record<string, string> },
  ctx: { skill?: string | undefined },
): string[] {
  const labels = new Set(cfg.pr_labels ?? []);
  const rules = cfg.auto_apply_conditional_labels ?? {};

  if (ctx.skill === 'misbehavior-debugger' && rules._misbehavior_debugger) {
    labels.add(rules._misbehavior_debugger);
  }

  return [...labels];
}
