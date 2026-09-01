// Git environment for an agent session's own `git` commands.
//
// This is NOT the hook path. `hooks/commands/git_commit.ts` runs git as a child of
// the ROUTER, inheriting the router's process env; everything here lands in
// `sessionEnv`, which the Agent SDK hands to the session's Bash tool. The two are
// deliberately separate — the hook commits dev-team-state over ssh with the key
// pinned by the container's GIT_SSH_COMMAND, and must not be redirected by the
// HTTPS rewrite below.
//
// Two things stop a Builder from landing a commit, and both live here.

import { commitEnv } from '../hooks/commands/git_commit.js';

/**
 * Auth for github.com over HTTPS, using the session's GitHub App installation token.
 *
 * The target-project worktree inherits `origin` from the mirror, which is cloned over
 * ssh — and the router container pins GIT_SSH_COMMAND to the *dev-team-state* deploy
 * key with IdentitiesOnly=yes. So an agent's `git push` either offers the wrong deploy
 * key or none at all; either way github refuses it.
 *
 * Rather than rewrite the remote, redirect ssh→HTTPS for this process only and attach
 * the installation token as a header. Two reasons for env over `git config`:
 *
 *   - A worktree SHARES .git/config with its source repo (per-worktree config needs
 *     the worktreeConfig extension). Writing a remote URL from one session would
 *     therefore rewrite the mirror's config for the pull sidecar and every other
 *     agent's worktree.
 *   - An installation token expires in an hour, and worktrees are reused across
 *     sessions. Persisted, it would outlive its validity AND leave a live credential
 *     on disk. In the env it dies with the session.
 */
export function githubHttpsAuthEnv(installationToken: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${installationToken}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf',
    GIT_CONFIG_VALUE_0: 'git@github.com:',
    GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_1: `Authorization: Basic ${basic}`,
  };
}

/**
 * Everything a session needs for `git commit` and `git push` to work.
 *
 * Identity is unconditional: the router image configures no `user.name`/`user.email`,
 * so without it every `git commit` an agent runs dies on "Please tell me who you are"
 * — regardless of whether it has a worktree or a token. It reuses the hook's
 * `commitEnv` so an agent's commits carry one identity wherever they land.
 *
 * Auth is conditional: with no token, leaving the ssh remote alone is strictly better
 * than rewriting it to an HTTPS URL we cannot authenticate.
 */
export function gitSessionEnv(
  agent: string,
  installationToken: string | undefined,
): Record<string, string> {
  return {
    ...commitEnv(agent),
    ...(installationToken ? githubHttpsAuthEnv(installationToken) : {}),
  };
}
