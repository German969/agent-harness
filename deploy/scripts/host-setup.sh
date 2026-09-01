#!/bin/sh
# host-setup.sh — one-time (idempotent) host prep so the router can push dev-team-state.
#
# The router container runs as uid 1001 (`agents`), but the host's /home/agents is
# owned by the *login* user (typically uid 1000). For the SessionEnd `git_commit`
# hooks with "push": true to reach origin, the router must:
#   1. TRAVERSE into /home/agents/.ssh to reach the mounted key, and
#   2. READ the dev-team-state deploy key.
#
# We do this WITHOUT `chown`-ing the whole .ssh dir — that would change the owner of
# the login user's authorized_keys and can lock you out via sshd StrictModes. Instead:
#   - `chmod o+x` on the dir grants traverse-only (execute, NOT write/read-list); sshd
#     only rejects group/other-WRITABLE dirs, so login is unaffected.
#   - chown ONLY the dev-team-state key to the router uid; other keys stay private to
#     the login user (uid 1001 still can't read them).
#
# Run once per box, and again after rotating the dev-team-state deploy key:
#   sudo sh deploy/scripts/host-setup.sh
#
# Reminder this script cannot enforce: the dev-team-state deploy key must also have
# WRITE access on GitHub (add it with the box checked — it can't be toggled later).

set -eu

SSH_DIR=/home/agents/.ssh
STATE_KEY="$SSH_DIR/dev-team-state-deploy"
ROUTER_UID=1001

if [ ! -d "$SSH_DIR" ]; then
  echo "[host-setup] $SSH_DIR not found — create the deploy keys first" >&2
  exit 1
fi
if [ ! -f "$STATE_KEY" ]; then
  echo "[host-setup] $STATE_KEY not found — add the dev-team-state deploy key first" >&2
  exit 1
fi

# 1. Traverse-only into ~/.ssh for uid 1001 (execute bit; safe for sshd login).
chmod o+x "$SSH_DIR"

# 2. Let the router uid own + read its own deploy key (keep it 0600).
chown "$ROUTER_UID:$ROUTER_UID" "$STATE_KEY"
chmod 600 "$STATE_KEY"

echo "[host-setup] done — key + dir permissions:"
ls -lan "$STATE_KEY"
ls -land "$SSH_DIR"
echo "[host-setup] REMINDER: the dev-team-state deploy key must have WRITE access on GitHub."
