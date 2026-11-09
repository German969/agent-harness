# Router deploy — Hetzner VPS runbook

End-to-end instructions for provisioning a fresh Hetzner CX32 (or equivalent)
+ running the dev-team router in production. All steps are idempotent — safe
to re-run.

## 0. Prerequisites

- A Hetzner project (or any VPS provider with Docker + a public IPv4)
- A Cloudflare account with a tunnel provisioned for the router hostname
- A GitHub deploy key with read access to the dev-team config repo
- Six configured GitHub Apps + Linear agents + Slack apps (per
  [PLAN.md](../PLAN.md) — one identity per agent)

## 1. Provision the VPS

Hetzner CX32 (Ubuntu 24.04):

```bash
# From your local machine after `ssh root@<ip>` first login.
apt update && apt upgrade -y
apt install -y docker.io docker-compose-v2 ufw

# Non-root user for the router.
useradd -m -s /bin/bash -G docker agents
mkdir -p /opt/dev-team && chown agents:agents /opt/dev-team

# Firewall — cloudflared handles inbound; only allow ssh publicly.
ufw allow ssh
ufw --force enable
```

Optional: add the deploy key to `/home/agents/.ssh/id_ed25519` so the
`git-pull` sidecar can clone the config repo.

### Deploy keys + state-push permissions

Place the per-repo deploy keys under `/home/agents/.ssh/` (`dev-team-deploy`,
`chatbots-deploy`, `dev-team-state-deploy`). The router itself (not just the
sidecars) pushes `dev-team-state` to origin via the SessionEnd `git_commit`
hooks, and it runs as uid 1001 while `/home/agents` is owned by the login user —
so it needs traverse access to `~/.ssh` and read access to the state key. Run the
idempotent helper once per box (and again after rotating that key):

```bash
sudo sh deploy/scripts/host-setup.sh
```

It `chmod o+x`'s `~/.ssh` (traverse-only — safe for sshd login) and chowns just
the `dev-team-state-deploy` key to uid 1001. The key must also have **write**
access on GitHub (checkbox at add-time; it can't be toggled afterward). Without
this, state still commits locally but pushes fail (harmless warnings in the log).

## 2. Clone the dev-team repo

```bash
sudo -u agents git clone git@github.com:<your-org>/dev-team.git /opt/dev-team
cd /opt/dev-team
```

## 3. Configure secrets

```bash
cd deploy

# Router
cp .env.example .env
# Fill in INFISICAL_PROJECT_ID + TOKEN (from step 5 below)

# Cloudflared
cp cloudflared/config.example.yml cloudflared/config.yml
# Replace CHANGE_ME_TUNNEL_UUID + drop credentials.json next to it.

# Infisical
cp infisical/.env.example infisical/.env
# Generate 32-byte hex for every CHANGE_ME:
#   openssl rand -hex 32
```

## 4. Build the router image

```bash
cd /opt/dev-team
docker compose -f deploy/docker-compose.yml build router
```

## 5. Infisical bootstrap

```bash
# Bring up Infisical first (router waits on it).
docker compose -f deploy/docker-compose.yml up -d infisical

# Wait ~15s for it to migrate + start serving.
sleep 15

# Verify.
curl -fsS http://127.0.0.1:8082/api/status && echo " ok"
```

Open `http://<host>:8082` (or via cloudflared once configured). Create:
1. Initial admin user
2. Project `dev-team-router`
3. Environment `dev` (the name the router reads from `INFISICAL_ENVIRONMENT`;
   there is one environment, not a dev/prod pair)
4. Service token with read access to `dev`
5. Add all per-agent secrets (see [infisical/README.md](infisical/README.md))

Paste the project ID + service token into `deploy/.env`.

## 6. Start the router + tunnel

```bash
cd /opt/dev-team
docker compose -f deploy/docker-compose.yml up -d
```

Verify:

```bash
# Health check.
docker exec dev-team-router curl -fsS http://localhost:8080/health

# Metrics.
docker exec dev-team-router curl -fsS http://localhost:8080/metrics | head -20

# Session log dir.
docker exec dev-team-router ls /var/log/agents/sessions

# Tunnel status.
docker logs dev-team-cloudflared --tail 20
```

## 7. Cron — daily backups

```bash
# Cron entry runs the backup script inside the router container.
sudo -u agents crontab -e
```

Add:
```
0 3 * * * docker exec dev-team-router sh -c "STATE_DB=/var/lib/agents/state.sqlite BACKUP_DIR=/var/lib/agents/backups /opt/dev-team/deploy/backup.sh" >> /var/log/agents/backup.log 2>&1
```

## 8. Smoke test

```bash
# 1. Trigger a scheduled job through the CLI.
docker exec dev-team-router node dist/cli/main.js schedule run guardian-llm-security-weekly-eval

# 2. Watch the session log.
docker exec dev-team-router tail -f /var/log/agents/sessions/*.jsonl

# 3. Confirm Prometheus scrape endpoint.
docker exec dev-team-router curl -fsS http://localhost:8080/metrics | grep agent_session_total
```

## 9. Restore from backup

```bash
# Stop the router.
docker compose -f deploy/docker-compose.yml stop router

# Pick the backup + decompress.
BACKUP=/var/lib/agents/backups/state-20260601.sqlite.gz
gunzip -c "$BACKUP" > /var/lib/agents/state.sqlite

# Restart.
docker compose -f deploy/docker-compose.yml start router
```

## 10. Upgrades

```bash
cd /opt/dev-team
git pull --rebase
docker compose -f deploy/docker-compose.yml build router
docker compose -f deploy/docker-compose.yml up -d router  # zero-downtime replace
```

The `git-pull-loop` sidecar hot-reloads config (agents/*, identities/*,
scheduler/schedules.yml) automatically every 60 seconds — you only need to
rebuild + restart the router when router source code changes.

> **⚠️ Followup — the routing registry is boot-time only, and races the git sidecar on a cold deploy.**
> The line above is half true. Per-session config (agent CLAUDE.md, settings, skills, mcp.json) is re-read
> per session, so those *do* hot-reload from the volume. But the **routing registry** — the Slack-app-id /
> GitHub-app-id / Linear-webhook-id → agent maps that decide which agent a webhook is even *for* — is built
> exactly once, at boot, from `identities/*.yml` (`buildRegistry(loadIdentities(...))`, `router/src/server.ts:73-79`).
> There is no reload path for it.
>
> Two failure modes follow:
> 1. **Cold-deploy race (hit in the fleet-handover deploy).** On a fresh `docker compose down && up`, the router
>    boots *concurrently* with the `git-pull` / `git-clone-once` sidecars. If the `dev-team-repo` volume is stale or
>    mid-`reset --hard` when the router reads it, the registry is built from old (or empty) identities. Symptom:
>    every inbound Slack/GitHub/Linear webhook 404s with `no_agent_matches_hint_<provider>` even though the
>    committed identity is correct. Current workaround: `docker compose restart router` once the sidecars have
>    settled — the rebuild picks up the right identities.
> 2. **Silent identity drift.** Edit an `app_id` / `bot_user_id` / `webhook_id` in an identity file, and the running
>    router keeps routing on the old map until someone restarts it — unlike every other config change, which the
>    per-session reload picks up. Easy to forget; presents as "the config is right but routing is wrong."
>
> Options to make it robust (pick one):
> 1. **Order the boot** — give the router a `depends_on` on a one-shot "volume-ready" init (or a healthcheck-gated
>    sidecar) so it never reads `identities/` mid-clone. Fixes mode 1 only; mode 2 still needs a restart.
> 2. **Rebuild the registry on config reload** — watch `identities/` (or accept a `SIGHUP` / an internal
>    `/admin/reload` route) and re-run `buildRegistry` in place, swapping the maps atomically. Fixes both modes and
>    removes the "restart after editing an identity" footgun. Preferred — it aligns the registry with the
>    already-live per-session hot-reload story.
> 3. **Fail loud instead of silent** — if `loadIdentities` returns 0 (or fewer than expected) at boot, refuse
>    `/ready` and log an error rather than serving a registry that 404s everything. Cheap guardrail; complements 1/2.
>
> See `router/src/server.ts:72-79` (build site), `router/src/routing/registry.ts` (`buildRegistry`), and
> `router/src/ingress/routes.ts:161-171` (where the miss surfaces as a 404).

## 11. The Anthropic SDK — final wiring

The router ships with a `PlaceholderSdkClient` that always returns an error.
To actually run Claude sessions:

1. Install: `pnpm add @anthropic-ai/claude-agent-sdk` in `router/`.
2. Author `router/src/runtime/anthropicAdapter.ts` implementing the `SdkClient`
   interface from `router/src/runtime/sdk.ts`. The interface is deliberately
   narrow (`runSession(inputs, callbacks) → outcome`) — the adapter is a thin
   translation layer between our `SdkRunInputs` + `SdkCallbacks` and the SDK's
   own request/response shape.
3. Instantiate it in `router/src/server.ts` where `PlaceholderSdkClient` is
   currently the default (`overrides.sdk ?? new PlaceholderSdkClient()`).
4. Rebuild + redeploy.

The SDK adapter is deliberately not shipped in-tree so we don't bake in a
specific SDK version until we've validated compatibility. Every other module
(runtime, hooks, reply streamer, session log, metrics) is agnostic to which
SDK client is used.

## Common issues

| Symptom | Cause | Fix |
|---|---|---|
| `/ready` returns 503 with `secrets: stub` | `SECRETS_PROVIDER=env` in `.env` | Set `SECRETS_PROVIDER=infisical` + fill Infisical vars |
| Session immediately gates with `stack_missing` | `STACK.md` / `SYSTEM.md` missing from the target project | Bootstrap those docs — see [PLAN.md](../PLAN.md) Phase 0 |
| MCP children never spawn | `mcp.json` env vars missing from Infisical | Add per-agent secrets to Infisical project |
| Router container OOMs | Big session with lots of MCP children | Bump the container's memory limit in compose (`mem_limit: 2g`) |
| `git-pull` sidecar can't fetch | Missing SSH key | Mount `/home/agents/.ssh` as a read-only volume into the `git-pull` container |
