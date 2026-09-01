#!/bin/sh
# git-clone-once.sh — populate a WRITABLE repo volume, then keep it in step with
# origin without ever discarding local work.
#
# Unlike git-pull-loop.sh this NEVER does `git reset --hard`. dev-team-state is
# written from BOTH sides now: the agents commit to it via SessionEnd hooks, and
# humans/Claude sessions commit vault content (shared/) through PRs on GitHub. A
# reset would destroy the first; cloning once and never fetching starves the second
# — the shared/ tier merged to origin would simply never appear on the box, so the
# SessionEnd hooks would silently skip it (resolveAddPaths drops a path that is not
# on disk) and any SessionStart index injection would read nothing.
#
# So: clone if empty, otherwise fetch and REBASE local commits onto origin. That
# keeps agent commits and takes remote content.
#
# Fails soft on purpose. The script runs under `set -e` and ends in `tail -f`, so a
# non-zero exit would restart-loop the container and, with `restart: unless-stopped`,
# do it forever. A repo that cannot rebase cleanly is a problem for a human to look
# at, not a reason to take the sidecar down — the volume is still there and the
# router still reads it.
#
# Runs inside the `alpine/git` container from docker-compose.yml.

set -eu

REPO_URL="${REPO_URL:?REPO_URL env var required}"
REPO_BRANCH="${REPO_BRANCH:-main}"
REPO_DIR=/repo

# This container runs as root, and the last thing this script does is hand the
# checkout to uid 1001 so the router can write it. Git then refuses to touch it:
#
#   fatal: detected dubious ownership in repository at '/repo'
#
# from EVERY command, exit 128 — `git status` and `git fetch` included. The router
# image declares `safe.directory '*'` (deploy/Dockerfile), which is why the router
# side has always worked; alpine/git carries no such config, so it has to be
# declared here or every run after the first clone fails.
#
# safe.directory is honoured only from PROTECTED configuration — system, global,
# and the command level (`-c` / GIT_CONFIG_*). A repo-local value is ignored on
# purpose, so that an untrusted repo cannot mark itself safe. GIT_CONFIG_GLOBAL
# puts it at global level without depending on $HOME being set in the image.
export GIT_CONFIG_GLOBAL=/tmp/sidecar-gitconfig
git config --global --add safe.directory "$REPO_DIR"

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "[git-clone-once] cloning $REPO_URL into $REPO_DIR"
  git init "$REPO_DIR"
  cd "$REPO_DIR"
  git remote add origin "$REPO_URL"
  git fetch --depth=1 origin "$REPO_BRANCH"
  git checkout -B "$REPO_BRANCH" "origin/$REPO_BRANCH"
else
  cd "$REPO_DIR"
  echo "[git-clone-once] $REPO_DIR already initialized — fetching origin/$REPO_BRANCH"

  # `git rebase` needs real history on both sides. The original clone was --depth=1,
  # so deepen to full before the first rebase or it fails on a shallow boundary.
  if [ -f "$REPO_DIR/.git/shallow" ]; then
    echo "[git-clone-once] shallow clone — unshallowing so a rebase has history to work with"
    git fetch --unshallow origin "$REPO_BRANCH" ||
      echo "[git-clone-once] WARNING: unshallow failed — still shallow, a rebase may not find a merge base"
  fi

  # A SessionEnd hook can run at any moment. Committing here is not this script's
  # job, but rebasing over a dirty tree aborts, so stash and restore around it.
  STASHED=no
  if [ -n "$(git status --porcelain)" ]; then
    echo "[git-clone-once] uncommitted agent work present — stashing across the rebase"
    git stash push -u -m git-clone-once-autostash >/dev/null 2>&1 && STASHED=yes
  fi

  # Reported separately. A failed fetch and a failed rebase need completely
  # different fixes — credentials or network on one side, a human reconciling a
  # content conflict on the other — and folding them into one `&&` produced a
  # message that named the wrong one for weeks.
  if ! git fetch origin "$REPO_BRANCH"; then
    echo "[git-clone-once] WARNING: fetch of origin/$REPO_BRANCH failed (see the git error above)."
    echo "[git-clone-once] Nothing was changed. The volume still holds the last synced content."
  elif git rebase "origin/$REPO_BRANCH"; then
    echo "[git-clone-once] rebased local commits onto origin/$REPO_BRANCH"
  else
    git rebase --abort >/dev/null 2>&1 || true
    echo "[git-clone-once] WARNING: could not rebase onto origin/$REPO_BRANCH."
    echo "[git-clone-once] Local commits are intact and the volume is usable, but this"
    echo "[git-clone-once] repo is now diverged from origin and needs a human to reconcile."
  fi

  if [ "$STASHED" = yes ]; then
    git stash pop >/dev/null 2>&1 ||
      echo "[git-clone-once] WARNING: stashed work did not reapply — recover it with 'git stash list'"
  fi
fi

# This sidecar runs as root, so the cloned tree is root-owned — but the router
# container writes here as uid 1001 (`agents`). Without matching ownership the
# router hits EACCES creating per-agent state dirs (dev-team-state/projects/…)
# and git refuses SessionEnd commits ("dubious ownership"). Hand the whole tree
# (incl. .git) to 1001:1001. Idempotent — safe on every (re)start.
echo "[git-clone-once] chown -R 1001:1001 $REPO_DIR (router uid)"
chown -R 1001:1001 "$REPO_DIR"

# Idle so compose keeps the (populated) volume around without re-running the clone.
exec tail -f /dev/null
