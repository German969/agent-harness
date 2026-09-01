#!/bin/sh
# ops.sh — READ-ONLY diagnostics, run ON the VPS by the `ops` GitHub Action.
#
# Deliberately NOT a shell: every operation is an explicit allowlisted case. Nothing
# here mutates state — no deploys, no restarts, no writes. The `sql` op opens the DB
# with sqlite3 -readonly AND rejects anything but a single SELECT, so even a crafted
# query cannot write. Trigger is workflow_dispatch (repo maintainers only).
#
# Usage: ops.sh <op> [args...]
#   ps                      docker ps (names + status)
#   health                  router /health
#   logs <svc> [tail]       docker logs for an allowlisted service (default tail 30)
#   sessions [n]            recent session cost rows (default 10)
#   turncost <sessionId>    per-turn cost lines from a session's jsonl
#   sessionlog <sessionId>  full jsonl event log for a session (started/turns/completed/outcome)
#   sql "<SELECT ...>"      read-only single-SELECT against state.sqlite
#   statels [subpath]       list *.md under dev-team-state (optionally a subdir)
#   state <relpath>         cat a *.md artifact under dev-team-state/{projects,global}/
#   workspace               worktree state + whether the router can actually write one

set -eu

DB=/var/lib/agents/state.sqlite
LOGDIR=/var/log/agents/sessions
STATEDIR=/var/lib/agents/dev-team-state

op="${1:-}"
[ -n "$op" ] && shift || true

case "$op" in
  ps)
    docker ps --format 'table {{.Names}}\t{{.Status}}'
    ;;

  health)
    docker exec dev-team-router curl -fsS http://localhost:8080/health && echo
    ;;

  logs)
    svc="${1:-}"
    tail="${2:-30}"
    case "$svc" in
      router)            c=dev-team-router ;;
      cloudflared)       c=dev-team-cloudflared ;;
      git-pull)          c=dev-team-git-pull ;;
      chatbots-git-pull) c=dev-team-chatbots-git-pull ;;
      state-init)        c=dev-team-state-init ;;
      *) echo "logs: unknown service '$svc' (router|cloudflared|git-pull|chatbots-git-pull|state-init)" >&2; exit 2 ;;
    esac
    case "$tail" in ''|*[!0-9]*) echo "logs: tail must be a number" >&2; exit 2 ;; esac
    docker logs "$c" --tail "$tail"
    ;;

  sessions)
    n="${1:-10}"
    case "$n" in ''|*[!0-9]*) echo "sessions: n must be a number" >&2; exit 2 ;; esac
    docker exec dev-team-router sqlite3 -readonly "$DB" \
      "SELECT id,agent,skill,cost_usd,cost_cache_write_tokens,cost_cache_read_tokens FROM sessions ORDER BY id DESC LIMIT $n"
    ;;

  turncost)
    sid="${1:-}"
    case "$sid" in ''|*[!0-9]*) echo "turncost: session id required (numeric)" >&2; exit 2 ;; esac
    docker exec dev-team-router sh -c "grep turn.cost ${LOGDIR}/${sid}.jsonl 2>/dev/null || echo 'no turn.cost lines for session ${sid}'"
    ;;

  sessionlog)
    sid="${1:-}"
    case "$sid" in ''|*[!0-9]*) echo "sessionlog: session id required (numeric)" >&2; exit 2 ;; esac
    docker exec dev-team-router sh -c "cat ${LOGDIR}/${sid}.jsonl 2>/dev/null || echo 'sessionlog: no log for session ${sid}'"
    ;;

  sql)
    q="${1:-}"
    # Read-only guard: single SELECT only. `-readonly` is the hard stop; these
    # checks are defense-in-depth + a clearer error than a DB-level failure.
    case "$q" in
      [Ss][Ee][Ll][Ee][Cc][Tt]\ *) : ;;
      *) echo "sql: only SELECT queries are allowed" >&2; exit 2 ;;
    esac
    case "$q" in *';'*) echo "sql: ';' not allowed (single statement only)" >&2; exit 2 ;; esac
    docker exec dev-team-router sqlite3 -readonly "$DB" "$q"
    ;;

  statels)
    sub="${1:-}"
    # Reject traversal / absolute / shell-unsafe chars. Empty sub = whole tree.
    case "$sub" in
      *[!A-Za-z0-9._/-]*) echo "statels: illegal characters in path" >&2; exit 2 ;;
    esac
    case "$sub" in
      *..*) echo "statels: '..' not allowed" >&2; exit 2 ;;
      /*)   echo "statels: path must be relative" >&2; exit 2 ;;
    esac
    docker exec dev-team-router sh -c \
      "find \"$STATEDIR/$sub\" -type f -name '*.md' 2>/dev/null | sed \"s|$STATEDIR/||\" | sort || true"
    ;;

  state)
    rel="${1:-}"
    case "$rel" in '') echo "state: relpath required (e.g. shared/process/harness-behavior.md)" >&2; exit 2 ;; esac
    # Read-only + tightly bounded: charset allowlist, no traversal, must be a .md
    # under projects/, global/ or shared/. cat only — nothing here can write.
    #
    # `shared/` is the fleet-wide vault tier (dev-team-state#2). It was missing here
    # while `statels` had no such restriction, so the tier could be listed and not
    # read — which is the half that matters when checking what an agent actually
    # wrote. Adding a third top-level name changes nothing about the guarantees:
    # same charset allowlist, same no-`..`, same relative-only, same .md-only, and
    # still cat with no write path.
    case "$rel" in
      *[!A-Za-z0-9._/-]*) echo "state: illegal characters in path" >&2; exit 2 ;;
    esac
    case "$rel" in
      *..*)          echo "state: '..' not allowed" >&2; exit 2 ;;
      /*)            echo "state: path must be relative" >&2; exit 2 ;;
      projects/*|global/*|shared/*) : ;;
      *)             echo "state: path must be under projects/, global/ or shared/" >&2; exit 2 ;;
    esac
    case "$rel" in
      *.md) : ;;
      *)    echo "state: only .md files are readable" >&2; exit 2 ;;
    esac
    docker exec dev-team-router sh -c \
      "cat \"$STATEDIR/$rel\" 2>/dev/null || echo \"state: not found — $rel\""
    ;;

  # A workspace failure reads as `setup_failed` with a git error and nothing about
  # WHY git could not write — and the answer is almost always ownership, since the
  # pull sidecar runs as root while the router is uid 1001. Report the three facts
  # that separate the causes: who the router is, who owns the refs directory it must
  # mkdir into, and what git already has registered. Compare the uid from `id` against
  # the owner of refs/heads — if they differ and the mode is 0755, that is the failure.
  # Read-only like every other op (no write probe, which would break that guarantee),
  # takes no arguments, and runs a fixed command, so there is nothing to inject into.
  #
  # It also reports how fresh the mirror is. The pull sidecar logs "fetch failed —
  # will retry" to stderr and keeps serving the last synced tree, so a mirror stuck
  # weeks behind looks exactly like a healthy one from every other angle.
  # The state repo is written from BOTH sides now — agents commit to it via
  # SessionEnd hooks, and vault content (shared/) arrives from GitHub through the
  # state-init sidecar's fetch+rebase. When those two diverge the sidecar refuses to
  # force it and says "needs a human to reconcile", which is correct and also
  # unactionable without knowing WHY. This reports the facts that separate the
  # causes: a dirty tree the stash missed, unpushed agent commits, a shallow clone
  # with no usable merge base, or a genuine content conflict.
  #
  # Read-only and argument-free, exactly like `workspace`: status/log/rev-list only,
  # no fetch, no checkout, no reset. Nothing takes input, so there is nothing to
  # inject.
  stategit)
    docker exec dev-team-router sh -c '
      d="/var/lib/agents/dev-team-state"
      cd "$d" 2>/dev/null || { echo "stategit: $d not present"; exit 0; }
      echo "router: $(id)"
      echo "--- branch ---"
      git rev-parse --abbrev-ref HEAD 2>&1
      echo "--- uncommitted (first 20) ---"
      git status --porcelain 2>&1 | head -20
      echo "--- local history ---"
      git log --oneline -5 2>&1
      echo "--- origin/main ---"
      git log --oneline origin/main -3 2>&1
      echo "--- behind/ahead vs origin/main (left=origin, right=local) ---"
      git rev-list --left-right --count origin/main...HEAD 2>&1
      echo "--- shallow? ---"
      test -f .git/shallow && echo yes || echo no
      echo "--- merge base with origin/main ---"
      git merge-base origin/main HEAD 2>&1
      echo "--- local commits not on origin/main ---"
      git log --oneline origin/main..HEAD 2>&1 | head -10
    '
    ;;

  workspace)
    # WORKTREE_ROOT is absent from the container: it has a schema default in
    # config.ts and compose never sets it. Mirror that default here rather than
    # ls an empty string. TARGET_PROJECT_ROOT is set, defaulted for symmetry.
    docker exec dev-team-router sh -c '
      repo="${TARGET_PROJECT_ROOT:-/var/lib/agents/chatbots}"
      trees="${WORKTREE_ROOT:-/var/lib/agents/worktrees}"
      echo "router: $(id)"
      echo "--- mirror ownership ($repo) — the router uid must be able to mkdir in refs/heads ---"
      ls -ld "$repo" "$repo/.git" "$repo/.git/refs/heads" 2>&1
      echo "--- worktree root ($trees) ---"
      ls -ld "$trees" 2>&1
      echo "--- registered worktrees ---"
      git -C "$repo" worktree list 2>&1
      b="$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null)"
      echo "--- mirror freshness: local HEAD vs last-fetched origin/$b ---"
      git -C "$repo" log -1 --format="%h %ad %s" --date=short HEAD 2>&1
      if git -C "$repo" rev-parse --verify -q "origin/$b" >/dev/null; then
        git -C "$repo" log -1 --format="%h %ad %s" --date=short "origin/$b" 2>&1
      else
        echo "(no remote-tracking origin/$b — this mirror has never fetched it)"
      fi
    '
    ;;

  *)
    echo "usage: ops.sh {ps|health|logs <svc> [tail]|sessions [n]|turncost <sid>|sessionlog <sid>|sql \"<SELECT...>\"|statels [subpath]|state <relpath>|stategit|workspace}" >&2
    exit 2
    ;;
esac
