#!/bin/sh
# git-pull-loop.sh — keeps the mounted dev-team repo synced with origin.
#
# The router uses filesystem paths from DEV_TEAM_ROOT for hot-reload
# (agents/*, identities/*, scheduler/schedules.yml). This script clones on
# first boot and `git pull --rebase` every 60s afterward.
#
# Runs inside the `alpine/git` container from docker-compose.yml.

set -eu

REPO_URL="${REPO_URL:?REPO_URL env var required}"
REPO_BRANCH="${REPO_BRANCH:-main}"
PULL_INTERVAL="${PULL_INTERVAL:-60}"
REPO_DIR=/repo
# Opt-in: hand the checkout to another uid after every write. Set only for a repo
# the ROUTER must write to — see hand_over() below. Unset leaves ownership as-is.
REPO_OWNER="${REPO_OWNER:-}"

# hand_over() is what makes this necessary. Once the checkout belongs to uid 1001
# and this container is still root, git refuses to run in it at all:
#
#   fatal: detected dubious ownership in repository at '/repo'
#
# exit 128 from every command — so the pull loop below fetched, failed, and logged
# "fetch failed — will retry" on every tick, forever, while the mirror the router
# reads stayed frozen at whatever commit it was cloned at. The router image
# declares `safe.directory '*'` (deploy/Dockerfile); alpine/git carries no config
# of its own, so it has to be declared here.
#
# safe.directory is honoured only from PROTECTED configuration — system, global,
# and the command level (`-c` / GIT_CONFIG_*). A repo-local value is ignored on
# purpose, so an untrusted repo cannot mark itself safe. GIT_CONFIG_GLOBAL puts it
# at global level without depending on $HOME being set in the image.
export GIT_CONFIG_GLOBAL=/tmp/sidecar-gitconfig
git config --global --add safe.directory "$REPO_DIR"

# This container runs as root, so everything it clones is root-owned. A repo the
# router only reads is fine that way; one it must write is not. `git worktree add`
# creates a branch ref, which means mkdir inside .git/refs/heads — and the router
# is uid 1001, so against a root-owned .git that fails with
#   fatal: cannot lock ref '...': unable to create directory for .git/refs/heads/...
# Note the image's `chown -R agents:agents /var/lib/agents` cannot cover this: it
# runs at BUILD time, while this volume is mounted over that path at RUN time.
hand_over() {
  [ -n "$REPO_OWNER" ] || return 0
  chown -R "$REPO_OWNER" "$REPO_DIR"
}

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "[git-pull-loop] cloning $REPO_URL into $REPO_DIR"
  # `git init` first so we can clone into the pre-mounted volume dir.
  git init "$REPO_DIR"
  cd "$REPO_DIR"
  git remote add origin "$REPO_URL"
  git fetch --depth=1 origin "$REPO_BRANCH"
  git checkout -B "$REPO_BRANCH" "origin/$REPO_BRANCH"
  hand_over
else
  cd "$REPO_DIR"
  git remote set-url origin "$REPO_URL"
  # Covers a volume cloned before this script grew hand_over, which would
  # otherwise stay root-owned until the next upstream commit happened to land.
  hand_over
fi

while true; do
  # Keep the git error instead of discarding it: "fetch failed" with no reason is
  # indistinguishable between bad credentials, no network, and the ownership fault
  # above — which is exactly why the last one went unnoticed.
  if fetch_err="$(git fetch --quiet origin "$REPO_BRANCH" 2>&1)"; then
    if ! git diff --quiet "HEAD..origin/$REPO_BRANCH"; then
      echo "[git-pull-loop] $(date -u +%FT%TZ) pulling updates from origin/$REPO_BRANCH"
      git reset --hard "origin/$REPO_BRANCH"
      # reset --hard writes new objects and refs as root; re-hand them over, or the
      # next pull would silently take the checkout back from the router.
      hand_over
    fi
  else
    echo "[git-pull-loop] $(date -u +%FT%TZ) fetch failed — will retry: $fetch_err" >&2
  fi
  sleep "$PULL_INTERVAL"
done
