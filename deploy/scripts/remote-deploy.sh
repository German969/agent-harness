#!/bin/sh
# remote-deploy.sh — idempotent deploy, run ON the VPS by the `deploy` GitHub Action.
#
# The Action SSHes in and runs this from /opt/dev-team. It resyncs the checkout to
# origin/main, rebuilds the router image, and recreates any changed services. Config
# (agents/*, identities/*) still hot-reloads via the git-pull sidecar independently;
# this script is what lands ROUTER SOURCE + compose changes.
#
# Safe to re-run. `reset --hard` only touches tracked files — deploy/.env and
# cloudflared credentials are gitignored, so they're left alone.

set -eu

REPO_DIR="${REPO_DIR:-/opt/dev-team}"
BRANCH="${DEPLOY_BRANCH:-main}"
COMPOSE="docker compose -f deploy/docker-compose.yml"

cd "$REPO_DIR"

echo "[deploy] fetching origin/$BRANCH"
git fetch --quiet origin "$BRANCH"
git reset --hard "origin/$BRANCH"
echo "[deploy] HEAD now $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"

echo "[deploy] building router image (docker layer cache makes this a no-op when source is unchanged)"
$COMPOSE build router

echo "[deploy] recreating changed services"
$COMPOSE up -d

# The git sidecars run their script ONCE, at container start, and mount it as a bind
# mount (./scripts/*.sh:/x.sh:ro). Editing the script changes its CONTENT but not the
# service DEFINITION, so `up -d` above sees nothing to recreate and the container keeps
# running the version it started with — possibly weeks ago.
#
# That is not hypothetical. git-clone-once.sh was changed from clone-once to
# fetch-and-rebase so vault content merged on GitHub could reach the box; the deploy
# went green, the script on disk was the new one, and the sidecar never re-ran it. The
# shared/ tier stayed absent and `statels` showed the same eight files as before.
#
# Restarting is safe and cheap: both scripts are idempotent by construction (clone if
# empty else fetch/rebase; the pull loop re-execs its loop) and each ends in
# `tail -f /dev/null` or a sleep, so a restart costs a second and re-runs the sync once.
#
# All THREE sidecars, not just the state one. The comment above said "both scripts"
# while the command named one service, so a change to git-pull-loop.sh — which two
# services bind-mount — would have gone the same way the state one did.
# `|| true` because a sidecar that is absent on some box must not fail a deploy that
# has otherwise succeeded.
echo "[deploy] restarting git sidecars so their (bind-mounted) scripts re-run"
$COMPOSE restart dev-team-state-init git-pull chatbots-git-pull || true

echo "[deploy] waiting for router health"
i=1
while [ "$i" -le 20 ]; do
  if docker exec dev-team-router curl -fsS http://localhost:8080/health >/dev/null 2>&1; then
    echo "[deploy] healthy after ${i} attempt(s)"
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done

echo "[deploy] router health check FAILED after 20 attempts" >&2
docker logs dev-team-router --tail 40 >&2 || true
exit 1
