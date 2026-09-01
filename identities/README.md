# identities/

Per-agent identity configuration. One file per agent: `<agent>.yml`.

This directory holds **non-secret identity references** — the IDs, usernames, channels, and routing rules the router uses to recognize and route to each agent. Secrets live in [Infisical](../PLAN.md#secrets-management), never here.

## Contract

Each `<agent>.yml` declares:

| Section | Purpose | Filled in at |
|---|---|---|
| `agent` | The canonical agent ID (matches `agents/<id>/` directory) | Authored at design time (✅ done) |
| `github` | GitHub App slug, App ID, bot username, install URLs | Phase 2/3/4/5/6 (when the agent's GitHub App is created) |
| `linear` | Linear agent handle. The `agent_id` / `user_id` / `webhook_id` UUIDs are **vestigial** — one OAuth app serves the fleet (see below) | `agent_handle` authored at design time (✅ done) |
| `slack` | Slack App ID, bot user ID, default + alerts channels | Phase 7 (Slack integration) |
| `routing` | Linear-label routes + Slack-channel default routes (beyond explicit mentions) | Authored at design time (✅ done) |
| `continuation_timeout_days` | How long after the last session this thread is still "the same conversation" | Authored (default 30; Marketer overrides) |
| `secrets` | **Names** of secrets in Infisical (NOT values) | Authored at design time (✅ done); the secret values land in Infisical during deploy |

## Placeholder convention

Values that depend on real platform IDs use **`~`** (YAML null).

```yaml
github:
  app_slug: dev-team-strategist
  app_id: ~          # ← fill in once the GitHub App is created in Phase 2/3/4/5/6
  bot_username: strategist-agent
```

**What `~` actually does** — `routing/schema.ts` makes every ID field nullable, so a `~` never blocks startup and never disables an agent. (`loadIdentitiesWaiting` polls at boot, but that is boot-race hardening for the config volume mounting, not placeholder enforcement.) An identity with placeholders loads fine; it just doesn't populate the corresponding routing index. Only three fields are structurally required: `agent`, `github.bot_username` + `github.app_slug`, and `linear.agent_handle`.

The practical consequences, each of which fails **silently**:

| Left as `~` | What stops working |
|---|---|
| `github.app_id` **or** all of `github.installations` | `buildGithubAppOptions` (`consumer/consumer.ts`) needs **both** a numeric `app_id` and at least one numeric installation id. With either missing it returns `{}` and the session runs with **no GitHub credentials at all** — no clone, no push, no PR. |
| `linear.user_id` / `linear.agent_id` | Assignment-detection indices (`routing/registry.ts`) stay empty, so "assign a ticket to the agent" does not route. Mentions (`agent_handle`) and label routing still work. **Expected** — these are vestigial; see the Linear section below. |
| `slack.*` | No Slack surface for that agent. Harmless otherwise. |

> As of this writing every live agent has `linear.agent_id` and `linear.user_id` as `~`, so **assignment-based routing is not exercised anywhere** — mention and label routing are what's actually in use. Worth knowing before writing a smoke test that assigns a ticket.

## Bringing a new agent online

The steps that turn the `~`s above into a working agent. GitHub needs a per-agent App; Linear does not — see below.

### Naming convention

| Field | Pattern | Example |
|---|---|---|
| `github.app_slug` | `dev-team-<agent>` | `dev-team-strategist` |
| `github.bot_username` | `<short>-agent` | `strategist-agent` |
| `linear.agent_handle` | `<short>-bot` | `strategist-bot` |

`bot_username` is not cosmetic: `routing/mention.ts` strips a trailing `[bot]` and matches GitHub @-mentions against it. Get it wrong and mentions silently fail to route. It is also the display handle in reply footers.

### Steps

1. **https://github.com/settings/apps/new** — these live under the account that owns the target repos, not an org.
2. **Name:** `dev-team-<agent>`. The slug derives from it and must match `github.app_slug`. GitHub App names are globally unique; if the name is taken, the variant you pick is what goes in the identity file.
3. **Homepage URL:** any; the `dev-team` repo URL is fine.
4. **Webhook:**
   - Active: ✅
   - URL: `https://<router-host>/webhooks/github`
   - Secret: generate one → store in Infisical under the key the identity file already names in its `secrets:` block (see below)

   Every agent App posts to the same endpoint; the router demuxes by `app_id` (`routing/registry.ts` → `githubByAppId`). There is nothing per-app about the URL.
5. **Repository permissions:**

   | Permission | Level | Why |
   |---|---|---|
   | Contents | Read & write | clone, branch, push |
   | Pull requests | Read & write | open PRs, comment |
   | Issues | Read & write | issue comments are the mention surface |
   | Metadata | Read | mandatory |
   | Checks | Read | router consumes `check_run` / `check_suite` |
   | Actions | Read | router consumes `workflow_run` |

6. **Subscribe to events:** Issue comment, Pull request, Check run, Check suite, Workflow run — the five the classifier acts on. Extra subscriptions are ignored, not harmful.
7. **Where can this be installed:** *Only on this account.*
8. **Create** → copy the **App ID** → `github.app_id`.
9. **Generate a private key** → the `.pem` → Infisical, under the `github_app_private_key` key named in the identity file's `secrets:` block.
10. **Install App** → select the repo(s) → the resulting URL ends `/installations/<id>`. That number goes under `github.installations` (see the table above — omitting it is the most common way to end up with an agent that runs but cannot touch GitHub).

### Linear — there is nothing per-agent to create

**One OAuth application serves the whole fleet.** Do not create a Linear app or a Linear agent per agent; the identity file's `linear.*` ID fields imply otherwise but are vestigial from a superseded design.

Attribution is handled at call time, not by separate identities: `runtime/anthropicAdapter.ts` constructs the Linear client with `actorName: <agent id>`, and `linear/linearClient.ts` attaches `createAsUser` to every create-mutation, so one app renders each agent's actions as *"server-agent (via <App>)"*. `linear/oauthToken.ts` keeps **one shared** `actor=app` access token in the router's SQLite state, refreshing it against the rotating refresh token with a single-flight guard so concurrent sessions don't race it.

The OAuth credentials are therefore **fleet-wide and unsuffixed** — set once, not per agent:

```
LINEAR_OAUTH_CLIENT_ID
LINEAR_OAUTH_CLIENT_SECRET
LINEAR_REFRESH_TOKEN
```

**The only per-agent item is `LINEAR_TOKEN_<agent>` in Infisical, and it is a presence gate rather than a credential.** `runtime/sessionPrep.ts` only attempts the shared refresh `if (sessionEnv.LINEAR_TOKEN !== undefined)`, then overwrites it with the fleet token. Copy the value from an existing agent's key; what matters is that the key exists.

| Field | Do |
|---|---|
| `linear.agent_handle` | Set it — `<short>-bot`. Used for @-mention matching in Linear comments. |
| `linear.agent_id`, `linear.user_id` | **Leave as `~`.** Assignment-detection indices for a per-agent-identity design that was not built. Empty on every live agent. |
| `linear.webhook_id` | Set it on **exactly one** identity to open the Linear trigger surface — see the section below. `~` everywhere else. While it is `~` fleet-wide, `/webhooks/linear` 404s every delivery. |

### Bringing Linear online as a trigger surface

Linear was **outbound only** — agents read and write tickets through the Linear MCP, but no Linear event could start a session. Two things blocked it. One is fixed; the other needs values only your Linear workspace can give.

**Fixed in code.** `ingress/normalize/linear.ts` used Linear's `webhookId` as both the `delivery_id` and the `agent_hint`. Those are mutually exclusive: `webhookId` identifies the *webhook* and is stable across every delivery it makes, so as the idempotency key it made every delivery after the first collide in `webhook_deliveries` and be dropped as a duplicate — the surface would have worked exactly once. `delivery_id` now comes from Linear's per-delivery `Linear-Delivery` header, falling back to a composite of the fields that vary per delivery. `agent_hint` stays `webhookId`, which is its correct job: telling ingress *which secret verifies this signature*.

**Still needed from you.** No agent declares `linear.webhook_id`, so `routing/registry.ts` builds an empty `linearByWebhookId` and `/webhooks/linear` returns 404 `agent_not_configured` for every delivery, before signature verification. To open the surface:

1. In Linear → Settings → API → Webhooks, create a webhook pointing at `https://<router-host>/webhooks/linear`. Subscribe at least to **Issues** and **Comments**.
2. Copy its **webhook id** into `linear.webhook_id` on **exactly one** identity, and its **signing secret** into that agent's `LINEAR_WEBHOOK_SECRET_<agent>` in Infisical.
3. Restart the router — the routing registry is boot-time only (see *After filling the identity file* above).

One identity, not one per agent: the fleet shares a single Linear OAuth app (agents are distinguished by `createAsUser`), so there is one webhook and one secret. The identity that declares it is only the one whose secret verifies the signature — it does **not** become the agent that handles Linear events.

**Routing works once deliveries get in.** The classifier resolves the handling agent by mention → assignee → label, and two of those need nothing further:

| Signal | Field | Status |
|---|---|---|
| Mention | `linear.agent_handle` | **Set** on every agent (`server-bot`, `client-bot`, …) — `@server-bot` in a comment routes today |
| Label | `routing.linear_labels` | **Set** on every agent — a `backend` label routes to Builder-Server today |
| Assignee | `linear.user_id` | **Unset**, and see below |

**Open question — assignment routing.** `extractLinearAssignee` matches the ticket's assignee id against `linear.user_id`. Under the shared-OAuth model agents act via `createAsUser`, which attributes actions to a *display name* rather than a real Linear user account — so there may be no user id to assign a ticket to. PLAN.md's Phase 4 smoke test ("open a ticket assigned to `@server-agent`") depends on this path. Until it is resolved, trigger Linear work by **label** or **mention**, both of which are wired.

## Secret key names — read them, don't invent them

Every identity file already declares its Infisical key names in its `secrets:` block, authored at design time. **Read the names off the file rather than deriving them** — the suffix is the agent id with hyphens replaced by underscores, which is easy to get wrong:

```yaml
# identities/builder-server.yml
secrets:
  github_app_private_key: GITHUB_APP_PRIVATE_KEY_builder_server   # note: builder_server, not builder-server
  github_webhook_secret: GITHUB_APP_WEBHOOK_SECRET_builder_server
  linear_token: LINEAR_TOKEN_builder_server
```

`ANTHROPIC_API_KEY` is shared fleet-wide and is not per-agent.

### Router endpoints

One host, one path per surface. Shared by all agents.

| Surface | URL |
|---|---|
| GitHub | `https://<router-host>/webhooks/github` |
| Linear | `https://<router-host>/webhooks/linear` |
| Slack events | `https://<router-host>/webhooks/slack/events` |
| Slack commands | `https://<router-host>/webhooks/slack/commands` |
| Slack interactivity | `https://<router-host>/webhooks/slack/interact` |

Paths are defined in `router/src/ingress/routes.ts`. The host is the Cloudflare Tunnel hostname — the committed `deploy/cloudflared/config.yml` carries a placeholder; the live value is above and on the VPS.

### After filling the identity file

Commit via PR (never push to `main`). **Then restart the router** — the routing registry is built once at boot (`buildRegistry(loadIdentities(...))`, `router/src/server.ts`) and has no reload path, so a running router keeps routing on the old map until it is recreated. Worse, `deploy.yml`'s `paths:` filter covers only `router/**` and `deploy/**`, so an identity-only push does not trigger a deploy at all. Run the `deploy` workflow via **workflow_dispatch** to pick the change up. See the *routing registry is boot-time only* followup in [deploy/README.md §10](../deploy/README.md).

## Secret-reference convention

Secrets are referenced by their **Infisical key name**, not by their value:

```yaml
secrets:
  github_app_private_key: GITHUB_APP_PRIVATE_KEY_strategist
  linear_token: LINEAR_TOKEN_strategist
```

At session prep, the router fetches each named secret from Infisical and injects it as an env var to the spawned MCP servers + Claude SDK call. Per [router/ARCHITECTURE.md §2.10](../router/ARCHITECTURE.md#210-secrets--infisical-client).

**Every ref must resolve, whatever triggered the session** — session prep fetches the whole block up front, so a GitHub-triggered session still needs the Linear and Slack secrets. If any are missing the session dies in setup with `secrets resolve: ...`, naming all of them at once.

**Use `~` for a surface this agent doesn't have.** A null ref is skipped rather than fetched:

```yaml
secrets:
  github_app_private_key: GITHUB_APP_PRIVATE_KEY_builder_server
  slack_bot_token: ~        # no Slack app for this agent
```

Downstream already treats an absent key as "that surface is off" (the in-process Linear MCP logs `no LINEAR_TOKEN in session env` and skips; `replyTarget` falls through without a `SLACK_BOT_TOKEN`). Prefer `~` over inventing a dummy secret — it makes the gap visible in the identity file instead of hiding it in Infisical.

## Routing rules

`routing.linear_labels` — when a Linear ticket is tagged with one of these labels and no agent is explicitly mentioned, route to this agent (per [Linear Labels Protocol](../agents/PROTOCOLS.md#5-linear-labels-protocol)).

`routing.slack_default_channels` — when a Slack message arrives in one of these channels with no explicit mention, route to this agent (channel-default routing).

`routing.github_auto_triggers` — webhook event types that should auto-fire this agent for the project (e.g. Guardian's `pull_request.opened` auto-fire).

## How the router uses these files

Loaded **once at startup**. The router builds an in-memory routing table from the union of all identities; the git-pull sidecar refreshes the files on disk but nothing rebuilds the table, so identity edits need a router restart (see *After filling the identity file* above). Per-session config — agent `CLAUDE.md`, settings, skills, `mcp.json` — *is* re-read per session and does hot-reload. Per [router/ARCHITECTURE.md §2.2](../router/ARCHITECTURE.md#22-event-router) → "Identity matching" + "Skill resolution."

## What goes WHERE

This is the matrix to keep clear:

| Concern | Lives in |
|---|---|
| Persona system prompt | `agents/<id>/CLAUDE.md` |
| Allowed tools, hooks, cost caps | `agents/<id>/settings.json` |
| Skill files | `agents/<id>/skills/*.md` |
| MCP servers used | `agents/<id>/mcp.json` |
| **Bot identity + routing rules** | **`identities/<id>.yml`** ← (this file) |
| Secret values | Infisical (not git) |
| Scheduled jobs | `scheduler/schedules.yml` |
