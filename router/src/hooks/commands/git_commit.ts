// SessionEnd hook — command: 'git_commit'
// Stages + commits changes in a specific repo. No push, no PR — just the commit.
// Used by every agent's state commits (dev-team-state/global/<agent> + projects/<project>/<agent>).

import { execFile } from 'node:child_process';
import { existsSync, constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { githubHttpsAuthEnv } from '../../runtime/gitEnv.js';
import { contextVars, resolveVars } from '../placeholder.js';
import type { HookHandler, HookResult, SessionContext } from '../types.js';

const execFileP = promisify(execFile);

/**
 * Resolve the configured `paths` into a `git add` argument list:
 *   1. Interpolate `${VAR}` — critically `${PROJECT}`, so `projects/${PROJECT}/…`
 *      becomes `projects/chatbots/…` instead of reaching git literally.
 *   2. Strip a trailing glob segment (`foo/**` → `foo`); git recurses directories
 *      on its own, and a bare `**` pathspec isn't shell-expanded here (no shell).
 *   3. Drop entries that don't exist on disk. State subtrees are created lazily —
 *      a session that wrote no *global* state has no `global/<agent>/` dir — and
 *      `git add` fatally aborts on a pathspec that matches nothing, which would
 *      fail the whole SessionEnd hook. Filtering keeps the add tolerant of the
 *      subtrees this particular session didn't touch.
 */
export function resolveAddPaths(
  rawPaths: unknown,
  repoPath: string,
  vars: Record<string, string>,
): string[] {
  const list = Array.isArray(rawPaths) ? (rawPaths as string[]) : ['.'];
  return list
    .map((p) => {
      const resolved = resolveVars(p, vars);
      // A bare `**` means the whole repo. The trailing-glob strip below needs a
      // leading slash, so `**` survived it intact, then failed existsSync and was
      // DROPPED — meaning `paths: ["**"]`, which Marketer and Harness both use,
      // staged nothing and the hook reported "no matching paths" every session.
      if (resolved === '*' || resolved === '**' || resolved === './**') return '.';
      return resolved.replace(/\/\*{1,2}$/, '');
    })
    .filter((p) => existsSync(join(repoPath, p)));
}

/**
 * True when the repo dir is writable. Harness's `dev-team` repo is bind-mounted
 * `:ro` by design — it commits via the GitHub MCP, not local git — so every
 * `git add`/`commit` there fails with EROFS. Checking `W_OK` up front lets the
 * commit hooks skip cleanly instead of logging an error every session (followup #8).
 */
export async function isRepoWritable(repoPath: string): Promise<boolean> {
  try {
    await access(repoPath, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Author/committer identity for agent commits. The router container has no git
 * `user.name`/`user.email` configured, so `git commit` would fail with "Please
 * tell me who you are." Passing the GIT_AUTHOR_ / GIT_COMMITTER_ NAME+EMAIL env
 * vars overrides that without touching global config, and attributes each
 * dev-team-state commit to the agent that wrote it (useful for state forensics).
 */
export function commitEnv(agent: string): Record<string, string> {
  const name = `${agent}-agent`;
  const email = `${agent}@dev-team.local`;
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

/**
 * The full env for a git commit/push in `repo`: the agent's author identity plus,
 * for `<workspace>` only, an HTTPS credential for the TARGET repo.
 *
 * The workspace is the target project, not dev-team-state, so it needs the target
 * repo's credential. The container-wide GIT_SSH_COMMAND pins the dev-team-state
 * deploy key with IdentitiesOnly=yes, which would offer the wrong key and be
 * refused. Redirecting to HTTPS with the session's installation token is exactly
 * what the agent's own git does. Scoped to `<workspace>` on purpose: applying it
 * to dev-team-state would break a push that works today.
 */
export function gitEnvFor(repo: string, ctx: SessionContext): NodeJS.ProcessEnv {
  const workspaceAuth =
    repo === '<workspace>' && ctx.env?.GITHUB_APP_INSTALLATION_TOKEN
      ? githubHttpsAuthEnv(ctx.env.GITHUB_APP_INSTALLATION_TOKEN)
      : {};
  return { ...process.env, ...commitEnv(ctx.agent), ...workspaceAuth };
}

type GitCommitConfig = {
  repo: string; // 'dev-team' | 'dev-team-state' | '<target-project>' | '<target-project>-marketing'
  paths?: unknown; // paths to add (default: everything)
  message_template?: string; // e.g. "[strategist] session ${SESSION_ID} — ${SKILL}"
  push?: boolean; // when true, push the commit to origin (off-box durability for dev-team-state)
};

/** Best-effort push outcome — never throws; the local commit already succeeded. */
export type PushResult = 'pushed' | 'failed' | 'no-remote' | 'nothing-to-push';

/** Current branch name, defaulting to `main` (detached HEAD / errors → main). */
async function currentBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileP('git', [
      '-C',
      repoPath,
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ]);
    const b = stdout.trim();
    return b && b !== 'HEAD' ? b : 'main';
  } catch {
    return 'main';
  }
}

/**
 * Push the just-made commit to `origin`, concurrency-safe. Multiple agents commit
 * to the SAME dev-team-state repo from parallel sessions, so a push can be rejected
 * non-fast-forward; we `fetch` + `rebase` + retry.
 *
 * This used to say the rebase could never hit a *content* conflict, because writes
 * were to disjoint per-agent subtrees. That stopped being true when `shared/` was
 * added to every agent's commit paths: the fleet-wide tier is, by design, a place two
 * agents can edit the same file. Ordering conflicts still resolve on their own;
 * a genuine same-region conflict now aborts the rebase and returns 'failed'.
 *
 * Known limitation, worth understanding before relying on this: a failed rebase leaves
 * the commit local, and every later push re-attempts the same rebase and fails the
 * same way, so the repo stays behind until someone intervenes. The mitigation is
 * conventional rather than mechanical — shared notes are append-mostly, with dated
 * sections, so two agents rarely touch the same lines. Making the stuck state
 * self-healing or alerting is tracked separately; resolving a markdown conflict
 * automatically is not something to guess at with the fleet's memory.
 *
 * Best-effort by design: the local commit has already landed (that's the durable
 * floor), so any push failure (auth not yet wired, network, exhausted retries) is a
 * WARNING, not a session error. Auth is inherited from the process env (the router
 * provides GIT_SSH_COMMAND + a write deploy key via compose, same as the sidecars).
 */
export async function pushToOrigin(
  repoPath: string,
  env: NodeJS.ProcessEnv,
  log: SessionContext['log'],
): Promise<PushResult> {
  try {
    await execFileP('git', ['-C', repoPath, 'remote', 'get-url', 'origin']);
  } catch {
    return 'no-remote';
  }
  const branch = await currentBranch(repoPath);
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await execFileP('git', ['-C', repoPath, 'push', 'origin', `HEAD:${branch}`], { env });
      return 'pushed';
    } catch (err) {
      log.warn(
        { attempt, branch, err: (err as Error).message },
        'git_commit: push rejected — fetch + rebase + retry',
      );
      if (attempt === maxAttempts) return 'failed';
      try {
        await execFileP('git', ['-C', repoPath, 'fetch', 'origin', branch], { env });
        await execFileP('git', ['-C', repoPath, 'rebase', `origin/${branch}`], { env });
      } catch (rebaseErr) {
        await execFileP('git', ['-C', repoPath, 'rebase', '--abort']).catch(() => {});
        log.error(
          { err: (rebaseErr as Error).message },
          'git_commit: rebase after push-reject failed — commit stays local, not pushed',
        );
        return 'failed';
      }
      await new Promise((r) => setTimeout(r, attempt * 250));
    }
  }
  return 'failed';
}

/**
 * A failed push of the state repo means the fleet's memory did not leave the box,
 * and nothing downstream notices: the commit is local, the session succeeds, and the
 * summary says `push: failed` in a log nobody reads. Worse, it does not self-clear —
 * a rebase that conflicts aborts, so every later push retries the same rebase and
 * fails the same way until someone intervenes.
 *
 * Rare, and rarer still before `shared/` gave two agents a reason to edit one file.
 * But the cost of missing it is every subsequent session's memory silently not
 * persisting, so it is worth a message.
 *
 * Best-effort, like everything else on this path: no alerter configured, or an
 * alerter that throws, must not turn a successful session into a failed one.
 */
async function alertPushStuck(repo: string, ctx: SessionContext): Promise<void> {
  if (!ctx.alertPoster) return;
  // Split across locals rather than one long template — same reason consumer.ts
  // does it for the loop alert: Biome's useTemplate fix would emit a ~150-char line.
  const what = `Committed to ${repo} but could not push it to origin.`;
  const why = 'The commit is local only, and later pushes will keep failing the same way';
  const fix = 'until the repo is reconciled by hand — check for a conflict in shared/.';
  try {
    await ctx.alertPoster.post({
      agent: ctx.agent,
      channel: '#agents-alerts',
      level: 'error',
      title: 'state_push_failed',
      body: `${what} ${why} ${fix}`,
      fields: { repo, session_id: ctx.sessionId, agent: ctx.agent },
    });
  } catch (err) {
    ctx.log.warn({ err: (err as Error).message }, 'git_commit: could not post push-stuck alert');
  }
}

export const gitCommitHandler: HookHandler = async (config, ctx): Promise<HookResult> => {
  const cfg = config as GitCommitConfig;
  const repoPath = resolveRepoPath(cfg.repo, ctx);
  if (!repoPath) {
    // `<workspace>` on a session that leased no worktree. Not a failure: a
    // question or a closed-PR reply has no checkout, and nothing to commit.
    ctx.log.debug({ repo: cfg.repo }, 'git_commit: no path for repo alias; skipped');
    return { kind: 'side-effect', summary: `git_commit: ${cfg.repo} not present; skipped` };
  }
  const vars = contextVars(ctx);
  const messageTemplate =
    cfg.message_template ?? `[${ctx.agent}] session ${ctx.sessionId} — auto-commit`;
  const message = resolveVars(messageTemplate, vars);

  if (!(await isRepoWritable(repoPath))) {
    ctx.log.debug({ repo: cfg.repo, repoPath }, 'git_commit: repo mount is read-only; skipped');
    return { kind: 'side-effect', summary: `git_commit: ${cfg.repo} mount is read-only; skipped` };
  }

  const paths = resolveAddPaths(cfg.paths, repoPath, vars);
  if (paths.length === 0) {
    return { kind: 'side-effect', summary: `git_commit: no matching paths in ${cfg.repo}` };
  }

  try {
    // Stage requested paths
    await execFileP('git', ['-C', repoPath, 'add', '--', ...paths]);
    // Check if there's anything to commit; if not, skip cleanly.
    const { stdout } = await execFileP('git', ['-C', repoPath, 'status', '--porcelain']);
    if (stdout.trim().length === 0) {
      return { kind: 'side-effect', summary: `git_commit: no changes in ${cfg.repo}` };
    }
    const commitEnvVars = gitEnvFor(cfg.repo, ctx);
    await execFileP('git', ['-C', repoPath, 'commit', '-m', message], { env: commitEnvVars });

    // Off-box durability: push to origin when configured. Best-effort — the local
    // commit above is the durable floor, so a push failure never fails the session.
    let push: PushResult | undefined;
    if (cfg.push) {
      push = await pushToOrigin(repoPath, commitEnvVars, ctx.log);
      if (push === 'failed') await alertPushStuck(cfg.repo, ctx);
    }

    return {
      kind: 'side-effect',
      summary: `git_commit: committed to ${cfg.repo}${push ? ` (push: ${push})` : ''}`,
      data: { repo: cfg.repo, message, ...(push ? { push } : {}) },
    };
  } catch (err) {
    ctx.log.error({ repo: cfg.repo, err: (err as Error).message }, 'git_commit: failed');
    return { kind: 'error', error: err as Error };
  }
};

/**
 * Resolve a repo alias (`dev-team`, `dev-team-state`, `<target-project>`, `<target-project>-marketing`)
 * to an absolute filesystem path via SessionContext.
 */
export function resolveRepoPath(repo: string, ctx: SessionContext): string | undefined {
  switch (repo) {
    case 'dev-team':
      return ctx.devTeamRoot;
    case 'dev-team-state':
      return join(ctx.devTeamRoot, '..', 'dev-team-state');
    case '<target-project>':
      return ctx.targetProjectRoot;
    case '<target-project>-marketing':
      return `${ctx.targetProjectRoot}-marketing`;
    // The per-task worktree this session leased, when it leased one. Undefined for
    // a session with no workspace (a question, a closed-PR reply) — the caller
    // skips rather than falling through to a path that would be wrong.
    case '<workspace>':
      return ctx.workspaceDir;
    default:
      return repo; // assume absolute path
  }
}
