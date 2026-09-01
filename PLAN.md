# Cloud Claude Agent Team — Custom router on a small VPS

## Context

A team of self-hosted Claude agents that:

1. Work on **any GitHub repo where the agents' bot accounts are added as collaborators** — no per-repo workflow files required.
2. Each agent has **its own system prompt and skills**, defined centrally in a dedicated config repo (`dev-team`).
3. **Multiple specialized agents run in parallel**, each invoked from Slack, Linear, or GitHub PR/issue comments.
4. Costs and behavior are controllable per-persona (model routing, monthly spend caps, off-hours throttling).
5. **Multi-agent native** — six distinct bots with their own identities (GitHub App / Linear agent / Slack app per agent), full custom system prompts, and routing that distinguishes by mention/label/assignee.
6. **Scheduled work native** — cron triggers for weekly benchmarking, monthly compliance audits, quarterly drift checks, etc.
7. **VPC-compatible** posture — everything runs on infrastructure we control. Secrets never written to files; managed through a self-hosted secrets manager.

### Why a custom router (not Cyrus)

Earlier we evaluated [Cyrus](https://github.com/cyrusagents/cyrus) — an open-source agent runner that speaks Linear/GitHub/GitLab/Slack natively. After auditing the Cyrus config schema (`docs/CONFIG_FILE.md`) we found it doesn't fit our six-agent design:

- Cyrus is **single-persona** per process, with three hardcoded modes (`debugger` / `builder` / `scoper`) — no mechanism for custom persona prompts beyond label-based mode selection.
- **No cron triggers** — Cyrus is purely webhook-driven.
- **No native cost caps** — per-persona spend ceilings aren't in the config schema.
- **SessionStart / PreToolUse / SessionEnd hooks** we wrote in every agent's `settings.json` are Claude Code CLI hooks, not Cyrus features — they'd need to be implemented elsewhere.

Three options were considered: run six Cyrus instances (one per bot), wrap Cyrus with custom routing logic, or build a thin custom router. We're going with the third — **build a custom router using the Claude Agent SDK directly** — because it exactly fits the multi-agent + cron + cost-cap design, and we don't mind the 5–10 days of construction it takes.

The router replaces Cyrus; it does the same job (worktree management, webhook ingestion, claude session spawning, output streaming) but adds what we need (multi-persona, cron, cost caps) natively.

---

## Target project

**Greenfield.** No existing repo, no brand, no content infra, no name yet. The target project that the agents will work on does not exist when we start.

Implications that shape the bootstrap order (see "Greenfield bootstrap" below):

- There's no `CLAUDE.md` to inherit. The "project house-style base prompt" each agent loads must be *authored from scratch* in Phase 0 by a human running Claude Code locally (essentially the first job for each persona, done on a laptop before the router exists).
- There's no `<project>/` repo to commit to. Builder agents have nothing to build until a target repo exists.
- There's no brand voice, no editorial calendar, no audience. Marketer's first job is helping author the brand voice — not running campaigns.
- There's no PR flow. Guardian has nothing to review until code starts shipping.
- This means the agents come online **sequenced**, not all at once. The first wave is Strategist + Marketer + Platform (architect-only) — the three personas that *help define what we're building*. Engineers and Guardian wait for a target repo to exist.

Two repos and one project are at play once everything is running:

- `dev-team` — this repo. Agent configs (CLAUDE.md, skills, settings, router source, scheduler config, deploy files).
- `dev-team-state` — sibling repo for bot-written state (memory, ledgers, drift watchlists). Created in Phase 1.
- `<target-project>` — the actual product the agents work on. Created in Phase 0–1 once the founding decisions land.

The placeholder `<target-project>` is used throughout this doc; pick the real name in Phase 0.

---

## Architecture

```
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  GitHub         │  │  Linear         │  │  Slack          │
│  (@-mentions,   │  │  (assignments,  │  │  (@-mentions,   │
│   PR events)    │  │   comments)     │  │   commands)     │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │ webhooks           │ webhooks           │ events
         ▼                    ▼                    ▼
   ┌──────────────────────────────────────────────────────┐
   │  Cloudflare Tunnel  (outbound-only, stable URL)      │
   └──────────────────────────┬───────────────────────────┘
                              ▼
   ┌──────────────────────────────────────────────────────┐
   │  VPS — Hetzner CX32 (4 vCPU, 8 GB, 80 GB, ~€6.80/mo) │
   │                                                       │
   │  ┌────────────────────────────────────────────────┐  │
   │  │  Docker host: ubuntu 24.04                     │  │
   │  │                                                 │  │
   │  │  ┌──────────────────────────────────────────┐  │  │
   │  │  │  router (Node 20, Fastify)               │  │  │
   │  │  │  - HTTP server (webhooks + /health)      │  │  │
   │  │  │  - signature verification per provider   │  │  │
   │  │  │  - event → agent resolver                │  │  │
   │  │  │  - worktree manager (per task)           │  │  │
   │  │  │  - Claude Agent SDK direct (per session) │  │  │
   │  │  │  - reply streamer → trigger surface      │  │  │
   │  │  │  - cron scheduler (croner)               │  │  │
   │  │  │  - cost-cap pre-flight + ledger          │  │  │
   │  │  │  - per-agent MCP lifecycle               │  │  │
   │  │  └──────────────────────────────────────────┘  │  │
   │  │                                                 │  │
   │  │  ┌──────────────────────────────────────────┐  │  │
   │  │  │  cloudflared (Cloudflare Tunnel client)  │  │  │
   │  │  └──────────────────────────────────────────┘  │  │
   │  │                                                 │  │
   │  │  ┌──────────────────────────────────────────┐  │  │
   │  │  │  infisical (self-hosted secrets manager) │  │  │
   │  │  │  - per-agent credentials                 │  │  │
   │  │  │  - audit log; rotation; web UI           │  │  │
   │  │  └──────────────────────────────────────────┘  │  │
   │  │                                                 │  │
   │  │  /var/lib/agents/                              │  │
   │  │  ├── worktrees/<agent>/<task-id>/  (per job)  │  │
   │  │  ├── dev-team/             (this repo clone)   │  │
   │  │  ├── dev-team-state/       (state repo clone)  │  │
   │  │  └── state.sqlite          (router SQLite)     │  │
   │  │                                                 │  │
   │  │  /var/log/agents/                              │  │
   │  │  └── sessions/<session-id>.jsonl  (deep logs)  │  │
   │  └────────────────────────────────────────────────┘  │
   └──────────────────────────────────────────────────────┘
                              │ outbound only
                              ▼
   ┌────────────────────────────────────────────────────────┐
   │  api.anthropic.com (Claude Agent SDK)                  │
   │  github.com (PRs, comments)                            │
   │  api.linear.app (issues, comments)                     │
   │  slack.com (messages)                                  │
   │  axiom.co (structured log sink)                        │
   │  sentry.io (error tracking)                            │
   │  grafana.net (metrics + dashboards)                    │
   │  npm / pnpm registries                                 │
   └────────────────────────────────────────────────────────┘
```

### Why each piece

- **The router (custom)** — TypeScript service that does webhook ingestion, per-agent routing, worktree management, Claude session spawning via the SDK, reply streaming, cron scheduling, and cost-cap enforcement. Replaces Cyrus's role. ~5–10 days of construction; architecture sketched in `router/ARCHITECTURE.md` (to be authored before any code).
- **Claude Agent SDK (direct)** — we use the SDK programmatically rather than shelling out to the `claude` CLI. This lets us pass per-agent system prompts (loaded from `agents/<name>/CLAUDE.md`) as parameters, implement SessionStart/PreToolUse/SessionEnd hooks as TypeScript handlers, and enforce cost caps pre-flight cleanly.
- **Cloudflare Tunnel** — outbound-only ingress for webhooks. No open ports on the VPS, no public IP exposure, free tier covers our volume, stable URL across restarts.
- **Infisical (self-hosted)** — secrets manager. Per-agent credentials (GitHub App private keys, Linear tokens, Slack signing secrets, Anthropic API keys) live in Infisical with an audit log and rotation tooling. The router reads secrets at startup (and on rotation events) via Infisical's CLI/SDK — **never written to disk anywhere in the repos**.
- **SQLite (router state)** — embedded DB at `/var/lib/agents/state.sqlite` (WAL mode). Holds active sessions, conversation continuity, cost ledger, webhook idempotency, schedule history, inter-agent ticket tracking. Single-file durability, ACID, debuggable via `sqlite3` CLI. Backed up daily with `litestream` or `sqlite3 .backup`.
- **Hetzner CX32 in Ashburn** — see VPS comparison below.
- **Docker** — runs router + cloudflared + infisical as three containers; trivially redeployable.
- **One bot identity per persona** — each agent has its own GitHub App install, its own Linear agent registration, and its own Slack app. Adding the bot as a collaborator on a new repo is enough — no workflow files in the target repo.

### Logging + observability stack

| Layer | Tool | Purpose |
|---|---|---|
| Structured logs (always-on) | `pino` → stdout + `/var/log/agents/sessions/<session-id>.jsonl` | Per-session deep trace; session_id is the join key |
| Log aggregation + search | **Axiom** (SaaS free tier — 500GB/month ingest, 30-day retention) | Query, filter, alert across all log lines |
| Error tracking | **Sentry** (SaaS free tier — 5K errors/month) | Uncaught exceptions; alert on first occurrence; cross-link via session_id |
| Metrics + dashboards | **Grafana Cloud** (free tier — 10K series, 14-day retention) | Per-agent cost, session volume, P50/P95/P99 duration, webhook health, spend-cap proximity |
| Alerting | Slack incoming webhook → `#agents-alerts` (with email fallback) | Cap-hit, process-crash, signature-failure-spike, agent-error-burst |
| Debug UX (operational) | A small CLI: `dev-team-logs session <id>` / `dev-team-logs agent <name> --since 1h` | Avoid learning vendor UIs for routine debugging |

Total runtime cost across logging stack: **$0** at our projected volume. All within free tiers.

### Config repo shape

```
dev-team              ← central config (single source of truth)
├── agents/
│   ├── strategist/
│   │   ├── CLAUDE.md               ← persona system prompt
│   │   ├── settings.json           ← model, hooks, allowed-tools, costCap
│   │   ├── mcp.json                ← per-agent MCP server config
│   │   └── skills/                 ← persona-specific skills
│   ├── platform/
│   ├── builder-server/
│   ├── builder-client/
│   ├── guardian/
│   └── marketer/
├── identities/                     ← per-agent bot identity (NOT secrets)
│   ├── strategist.yml              ← GitHub App ID, Linear agent UUID, Slack app ID, channel mappings
│   └── ...                         ← one per agent (six total)
├── router/                         ← THE custom router service
│   ├── ARCHITECTURE.md             ← system design (single source of truth)
│   ├── src/                        ← TypeScript source
│   │   ├── server.ts               ← Fastify webhook server
│   │   ├── auth/                   ← signature verification (GH/Linear/Slack)
│   │   ├── routing/                ← event → agent resolver
│   │   ├── workspace/              ← git worktree manager
│   │   ├── runtime/                ← Claude Agent SDK invocation
│   │   ├── reply/                  ← stream output back to trigger surface
│   │   ├── state/                  ← SQLite session + cost + idempotency layer
│   │   ├── secrets/                ← Infisical client
│   │   ├── scheduler/              ← croner-based cron worker
│   │   ├── mcp/                    ← MCP lifecycle per agent
│   │   ├── hooks/                  ← SessionStart/PreToolUse/SessionEnd handlers
│   │   ├── observability/          ← pino + Sentry + Prometheus exporter
│   │   └── cli/                    ← dev-team-logs CLI
│   ├── tests/                      ← router tests
│   ├── package.json
│   └── tsconfig.json
├── scheduler/
│   └── schedules.yml               ← all cron schedules (version-controlled)
├── deploy/
│   ├── docker-compose.yml          ← router + cloudflared + infisical
│   ├── Dockerfile                  ← router image
│   ├── infisical/                  ← Infisical compose overrides
│   └── README.md                   ← VPS setup, secrets bootstrap, restore-from-backup runbook
├── templates/
│   └── founding/                   ← project-agnostic templates for Phase 0
├── AGENTS.md
├── COST_ANALYSIS.md
├── PLAN.md
└── README.md
```

The router pulls this repo on the VPS via git, and re-reads agent configs (CLAUDE.md, settings.json, skills, mcp.json) on every session — **edits to a persona's config apply on the next session without redeploying**. The router source itself does require a deploy (`docker compose up -d --build router`) on changes.

### How a target repo opts in

1. Open the target repo's GitHub settings → Collaborators → invite each persona's bot account (or install the persona's GitHub App).
2. Set up Linear team / project routing for whichever agents should listen to assignments / comments there.
3. Add the bot's Slack app to the relevant channels.
4. **That's it.** No workflow files in the target repo. Mention `@backend-agent` in a PR comment or issue, and the router picks it up via the GitHub App's webhook.

---

## The router service (high-level)

Detailed architecture lives in `router/ARCHITECTURE.md` (authored before any code). At a glance:

### Responsibilities

1. **Webhook ingress** — HTTP server with per-provider signature verification (GitHub HMAC, Linear HMAC, Slack signing secret). Webhook delivery IDs are stored in a dedup table to make ingestion idempotent.
2. **Event → agent routing** — based on which bot identity was mentioned (Slack/Linear/GitHub all surface this) + label/assignee/branch context, pick which agent runs. Six agents; the routing table is small + testable.
3. **Worktree management** — `git worktree add <branch>` per task into `/var/lib/agents/worktrees/<agent>/<task-id>/`. LRU cleanup; no two parallel sessions ever share a worktree.
4. **Claude session spawning (SDK direct)** — for each session:
   - Load the agent's `CLAUDE.md` → pass as `system_prompt`
   - Load `settings.json` → derive `model`, `max_turns`, `allowed_tools`, `hooks`
   - Spawn the agent's MCP servers (stdio) per session
   - Run SessionStart hooks → load context files
   - Call the Claude Agent SDK with the prepared parameters
   - Run PreToolUse hooks before each tool call
   - Stream output back to the trigger surface
   - Run SessionEnd hooks (commit state, log session, post summaries)
5. **Reply streaming** — Claude output streams back to the trigger surface in real time (Slack thread, Linear comment, PR comment). Each provider has its own client; the streamer is small per-provider adapters.
6. **State persistence (SQLite WAL)** — active sessions, conversation continuity (so a reply in the same thread resumes context), cost ledger, webhook idempotency, schedule history, inter-agent ticket cross-reference.
7. **Cost cap enforcement** — pre-flight check reads the agent's monthly + per-job cap from `settings.json`, reads the current spend from the cost ledger, refuses the session if either cap would be exceeded. Posts to `#agents-alerts` at 80% threshold.
8. **Cron scheduling (croner)** — reads `scheduler/schedules.yml` at startup + on git pull; fires scheduled jobs that invoke an agent directly (no HTTP round-trip). Each cron entry: cron expression + agent + skill + trigger payload.
9. **Hot-reload** — agent config files (CLAUDE.md, settings.json, skills/, mcp.json) re-read on every session start. No router restart needed to push prompt changes.

### Strategic decision — SDK direct vs CLI

We use the Claude Agent SDK **programmatically** (not via the `claude` CLI subprocess). Why:
- The system prompt becomes a parameter, not a file the CLI reads from a worktree
- Hooks become real TypeScript handlers (not file-based hook config)
- Cost-cap pre-flight is a clean intercept before each SDK call
- Conversation continuity uses native session IDs
- Observability is direct (Sentry / Pino capture inside our process)

The `CLAUDE.md` and `settings.json` files we've already written remain authoritative — they're just **data the router loads** rather than files the CLI auto-reads.

---

## Secrets management

We use **Infisical (self-hosted)** as the secrets store. Runs as a container alongside the router on the same VPS.

What's stored:
- `ANTHROPIC_API_KEY` (one per agent if we want per-agent key tracking, or one shared)
- Per-agent GitHub App private keys (PEM)
- Per-agent Linear agent OAuth tokens
- Per-agent Slack bot tokens + signing secrets
- MCP server credentials (CMS API keys, email-platform tokens, social-scheduler tokens, analytics-platform keys for Marketer)
- Axiom / Sentry / Grafana Cloud API tokens
- Infisical's own master key (bootstrap concern — see Phase 1)

How it works at runtime:
- Router reads secrets from Infisical at startup via its CLI/SDK
- Secrets become process env vars to the router; never written to disk
- Rotation: update in Infisical → router refetches on the next session
- Audit log: every secret access logged

Bootstrap: Infisical needs its own initial admin credential to be created the first time. This is a one-time human action via the Infisical web UI (locked to localhost via Cloudflare Access during setup). All other secrets are then loaded into Infisical via its UI / CLI.

**Nothing committed to git is a secret.** The `identities/<agent>.yml` files hold non-secret config (App IDs, agent UUIDs, channel mappings) — the actual credentials are referenced by Infisical key name.

---

## VPS choice

Researched in May 2026. Goal: cheap, always-on, room for 3–5 parallel `claude` SDK sessions + the router + infisical + cloudflared, low-friction operation.

| Provider | Plan | vCPU / RAM / Disk | Egress | Cost/mo | Notes |
|---|---|---|---|---|---|
| **Hetzner Cloud** | **CX32** | **4 / 8 GB / 80 GB SSD** | **20 TB** | **€6.80 (~$7.30)** | Frankfurt/Helsinki/Ashburn. IPv4 included. Best $/perf by a wide margin. |
| Hetzner Cloud | CX22 | 2 / 4 GB / 40 GB SSD | 20 TB | €3.79 (~$4.10) | Too tight — Infisical + router + concurrent sessions will swap. Skip. |
| Hetzner Cloud | CPX32 | 4 AMD / 8 GB / 160 GB | 20 TB | €13.10 (~$14) | AMD perf bump, more disk. Worth it if many long-lived worktrees + Infisical. |
| Fly.io | shared-cpu-2x | 2 / 4 GB / 50 GB | metered | ~$10–35 | ~3–5× the Hetzner price. Easier infra-as-code. |
| Railway | hobby+ | 2 / 2–4 GB | metered | ~$10–30 | Scale-to-zero conflicts with persistent webhook connection; skip. |
| DigitalOcean | Premium AMD | 2 / 4 GB / 80 GB | 4 TB | ~$24 | More expensive, less egress. |
| Vultr | High Performance | 2 / 4 GB / 80 GB | 3 TB | ~$24 | Same neighborhood as DO. |

**Pick: Hetzner CX32 in Ashburn (US east, closest to GitHub / Linear / Anthropic API).**

- 4 vCPU / 8 GB headroom handles 3–5 parallel sessions + router + Infisical + cloudflared.
- €6.80/mo is rounding-error against the API token bill.
- 20 TB egress means no surprise bandwidth charges from `git clone`/`git push` on large monorepos.
- Plain Ubuntu with full SSH; Docker installs cleanly; well-supported by every infra tool.

**If we change our mind later**: Fly.io is the natural step-up — same Docker images, `fly launch`, done. We'd take that step only if we want infra-as-code deploys badly enough to pay 3–5× more.

**Avoid**: Railway (scale-to-zero conflicts with our persistent connections), DO/Vultr at this price/performance point, Lambda/Cloud Run (router is a long-lived process, not request/response).

---

## Cost model

| Line item | Monthly | Notes |
|---|---|---|
| Hetzner CX32 | $7 | Fixed |
| Cloudflare Tunnel | $0 | Free tier covers our volume |
| Hetzner snapshots (optional) | $1 | 20% of instance price; daily snapshots |
| Domain (`agents.<your-domain>` via Cloudflare) | $0–$10/yr | Optional |
| Infisical (self-hosted) | $0 | Runs as a container on the same VPS |
| Axiom (logs) | $0 | Free tier — 500GB/month ingest |
| Sentry (errors) | $0 | Free tier — 5K errors/month |
| Grafana Cloud (metrics) | $0 | Free tier — 10K series |
| **Fixed infra** | **~$8** | |
| Anthropic API — Sonnet-default agents | $100–250 | ~200 sessions/mo × $0.50–1.25 each |
| Anthropic API — Haiku for cheap skills | $10–40 | ~10× cheaper than Sonnet at same volume |
| Anthropic API — Opus opt-in for hard reasoning | $20–60 | Sparing use — system-design, foundational ADRs |
| **Variable (API)** | **$130–350** | |
| **Total** | **~$140–360/mo** | At target volume of ~200 sessions/mo |

See [COST_ANALYSIS.md](COST_ANALYSIS.md) for per-agent cap math and projected steady-state.

Hard caps enforced in the router's cost-cap module:
- Per-agent monthly spend ceiling — hard stop when hit (`onCapReached: "refuse_session"` in agent's settings.json)
- Per-agent per-job ceiling — hard stop on runaway loops
- 80% warning posted to `#agents-alerts`
- Per-agent counters reset monthly (UTC)

---

## Greenfield bootstrap (phased)

Because the target project doesn't exist yet, agents come online sequenced. Each phase unblocks the next.

### Phase 0 — Founding decisions (humans + Claude Code on a laptop)

Pre-router. Run Claude Code locally to produce the foundational artifacts every agent will inherit.

- **Pick the working title** for the target project. Pick the GitHub org/account it lives under.
- **Pick a domain** for the agent webhook URL (optional — Cloudflare Tunnel works without one).
- **Product hypothesis** — draft `<target-project>/founding/PRODUCT.md` using `dev-team/templates/founding/PRODUCT.template.md`. Use Claude Code with a temporary strategist-style prompt to produce a v0.
- **Brand voice** — draft `<target-project>/founding/BRAND.md` using `BRAND.template.md`. Same setup with a temporary marketer-style prompt.
- **Tech stack** — draft `<target-project>/founding/STACK.md` using `STACK.template.md`. Same setup with a temporary architect-style prompt.
- **Human picks**: name, stack, brand voice. These are the irreversible-ish founding decisions.
- **Output**: a `founding/` directory **in the target project** containing `PRODUCT.md`, `BRAND.md`, `STACK.md` — human-reviewed and committed to the target repo. This is the **house style base prompt** every agent loads at session start.

Time budget: 1–3 days, mostly waiting for human review of agent-drafted options.

### Phase 1 — Infrastructure for the agent team itself

Build the substrate the router needs.

1. **VPS** — order Hetzner CX32 in Ashburn (or Frankfurt — open question #4).
2. **Cloud-init** — install Docker + Docker Compose; create a non-root `agents` user; configure UFW (deny all inbound except SSH from a known IP); install `cloudflared`.
3. **Cloudflare Tunnel** — create tunnel; configure to route to the router's local port. Verify the webhook hostname resolves outside the VPS.
4. **State repo** — create `dev-team-state` (sibling to `dev-team`) with `global/` and `projects/` top-level dirs (see [AGENTS.md](AGENTS.md) → Multi-project planning).
5. **Infisical (secrets)** — deploy via `deploy/docker-compose.yml`. Bootstrap admin via web UI (port 8080 via Cloudflare Access, local-only). Create projects per agent. Add Anthropic API key, placeholder for each bot's credentials (we'll add real credentials in later phases).
6. **Observability stack signup**:
   - Axiom — create a workspace + log dataset; store API token in Infisical
   - Sentry — create a project; store DSN in Infisical
   - Grafana Cloud — create a stack; store Prometheus + Loki tokens in Infisical
7. **Router skeleton deployment**:
   - `git clone dev-team` on the VPS at `/var/lib/agents/dev-team`
   - Build the router image (Docker) with **zero agents configured**
   - Verify the router boots cleanly + posts a `started` event to `#agents-alerts`
   - Verify webhook routes return 404 for unknown agent mentions (no agent identities exist yet)
8. **Linear label registry** — create the ~35 labels in Linear per the [Linear Labels Protocol](agents/PROTOCOLS.md#5-linear-labels-protocol). Plus any project-specific labels in `.dev-team.yml` → `linear_labels.custom`.
9. **dev-team-state seed** — commit empty `global/` + `projects/<target-project>/` dirs to make the agents' first session-end commits clean.

### Phase 2 — First wave: Strategist + Harness (parallel)

Two agents come online together: **Strategist** (product-facing, helps refine founding docs) and **Harness** (meta-agent, takes over harness maintenance from local Claude Code). They have orthogonal scopes (Strategist on target project, Harness on `dev-team/`) so they don't conflict — and bringing Harness online early means it can help author/refine every subsequent agent.

**Step 2a — Strategist deployment**

1. Strategist `CLAUDE.md`, `settings.json`, skills (founding, PM, BA, PjM, Researcher, Curator, Triage, Design-prefill) already done. ✅
2. **Create the Strategist GitHub App** under `<your-org>`. Add its private key to Infisical.
3. **Register the Strategist Linear agent**. Add its token to Infisical.
4. **Skip Slack for now** (Phase 7).
5. **Add Strategist's identity config** to `dev-team/identities/strategist.yml` (App ID, Linear UUID, channels — non-secret).
6. **Wire Strategist into the router** — add its routing entry in the router config. Build + deploy the router with Strategist enabled.
7. **Smoke test (Strategist)**: in a sandbox repo, open an issue tagged `@strategist-agent draft a PRD for X`. PRD posted in the issue thread.

**Step 2b — Harness deployment** (in parallel with 2a, ideally same day)

1. Harness `CLAUDE.md`, `settings.json`, `mcp.json`, 6 skills (gap-analyzer, agent-modifier, agent-architect, skill-author, misbehavior-debugger, router-engineer) already done. ✅
2. **Create the Harness GitHub App** under `<your-org>`. Install it on the **`dev-team` repo only** — NOT on any target project repo. Add its private key to Infisical.
3. **Register the Harness Linear agent**. Add its token to Infisical.
4. **Skip Slack for now** (Phase 7).
5. **Add Harness's identity config** to `dev-team/identities/harness.yml`.
6. **Wire Harness into the router** — add its routing entry. Build + deploy the router with Harness enabled.
7. **Smoke tests (Harness)** — see verification tests 16–20.
8. **Stop authoring agents locally.** From here, all changes to `dev-team/` go through Harness PRs (in principle; humans can still PR directly when faster, but the workflow shift is the point).

**Step 2c — Bump project phase**

9. **Bump project phase** — update `<target-project>/.dev-team.yml` → `project.phase: phase-2`. This unblocks Strategist's + Harness's phase-gated schedules.

**Step 2d — (Optional) Activate scheduled jobs**

10. `/agents schedule list --agent strategist` and `/agents schedule list --agent harness` to see what's available; flip on whichever ones you want active now. Recommended at Phase 2: leave most off; consider enabling `harness-gap-analyzer-monthly` after at least one other agent is online to give the survey something to analyze. All crons default to `enabled: false`.

### Phase 3 — Second wave: Platform (system-design + architect)

Platform comes online to author the initial system architecture. Two skills enabled now; the rest defer to Phase 6.

1. Platform `CLAUDE.md` + `settings.json` + skills already done. ✅
2. Create Platform's GitHub App. Register Linear agent. Add credentials to Infisical.
3. Wire Platform into the router; deploy.

**Step 3a — Initial system design** — `@platform-agent design the system architecture`:

Platform's `system-design` skill runs a multi-turn Slack discussion:
1. Reads founding docs (PRODUCT.md, STACK.md, optionally COMPLIANCE.md).
2. Surveys 2–3 candidate architectures with explicit trade-offs, biased toward simplicity.
3. Discussion with the user iterates until aligned.
4. Outputs:
   - `<target-project>/docs/architecture/SYSTEM.md`
   - `<target-project>/docs/adrs/ADR-0001` through `ADR-000N`

**Step 3b — Create the target project repo**

Human creates the `<your-org>/<target-project>` GitHub repo (branch protection, CI placeholder). Commits SYSTEM.md + ADRs. Directory scaffolding gets done by Builder-Server in Phase 4.

**Step 3c — From here, architecture work is incremental**

Future architecture decisions go through Platform's `architect` skill (one ADR per decision; SYSTEM.md kept in sync per the [Curator coding-practices drift check](agents/strategist/skills/curator.md)).

### Phase 4 — Third wave: Builder-Server + Builder-Client (code starts flowing)

1. Builder-Server CLAUDE.md / settings.json / 5 skills already done. ✅
2. Builder-Client CLAUDE.md / settings.json / 7 skills already done. ✅
3. Create both GitHub Apps. Register both as Linear agents. Add credentials to Infisical.
4. Set up Builder-Client's screenshot library at `<target-project>-marketing/assets/screenshots/library/` per the [Product Screenshot Protocol](agents/PROTOCOLS.md#4-product-screenshot-protocol).
5. **Smoke test**: open a trivial Linear ticket assigned to `@server-agent`. Router routes; agent clones the repo, implements, opens a PR.

### Phase 5 — Fourth wave: Guardian (PRs are flowing now)

1. Guardian CLAUDE.md / settings.json / 6 skills already done. ✅
2. Create `agents/guardian/sensitive-paths.yml` (initially empty; populated via Sensitive-Paths Protocol as the target project grows).
3. Create Guardian's GitHub App. Add credentials to Infisical.
4. Guardian auto-fires on PR open with three-tier path scan (Skip / Light / Deep).
5. **Bump project phase** — update `<target-project>/.dev-team.yml` → `project.phase: phase-5`. This unblocks the phase-gated Guardian + Curator schedules.
6. **Activate Guardian + Curator scheduled jobs** — via `/agents schedule enable --agent guardian` and `/agents schedule enable --agent strategist` (for the Curator skill's quarterly drift checks). Be deliberate about which ones — if there are no AI features yet, leave `guardian-llm-security-weekly` disabled (it'll cost ~$20–40/mo and have nothing to scan).
7. **Smoke test (auto-PR scan)**: open a PR that intentionally drops test coverage. Guardian comments within 2 minutes (Light scan).
8. **Smoke test (scheduled)**: `/agents schedule run guardian-monthly-compliance` — fires once on demand. Verify the run posts a summary to `#security` and inserts a `schedule_runs` row.

### Phase 6 — Fifth wave: Marketer + scheduled Platform skills

1. Marketer CLAUDE.md / settings.json / 8 skills already done. ✅
2. **Decide marketing toolbelt**: CMS (Webflow / Ghost / WordPress / MDX-in-git), email platform, social scheduler, analytics. See open follow-ups #6 + #7 in [AGENTS.md](AGENTS.md).
3. Set up MCP connectors for chosen platforms. **Verify each MCP's action verbs do NOT include publish/send/post_now** — those are denied by Marketer's settings.json + the PreToolUse action-verb hook. New MCPs must be audited before connecting.
4. Create Marketer's GitHub App. Register Linear agent. Add credentials to Infisical.
5. Add Marketer + Platform scheduled jobs to `scheduler/schedules.yml` (every entry lands `enabled: false` by default).
6. **Bump project phase** — update `<target-project>/.dev-team.yml` → `project.phase: phase-6`. This unblocks Marketer's phase-gated schedules + Platform's Release Manager / FinOps schedules.
7. **Activate scheduled jobs deliberately** — *don't* enable Marketer's full schedule set at once. Recommended order:
   - First: Platform's `finops` (daily billing check; safe, always wanted) → `/agents schedule enable platform-finops-daily`
   - When competitor list is curated: Marketer's `benchmarking` (weekly + monthly) → `/agents schedule enable --agent marketer` (filter to benchmarking ids)
   - When editorial calendar is populated: Marketer's `social-community` cadence
   - When at least one campaign has shipped: Marketer's `growth-analyst` weekly perf report
   - Hold off on lifecycle email triggers until segments are defined

### Phase 7 — Slack integration + cost guardrails

1. **Six Slack apps** — one per persona for identity parity with GitHub/Linear. Manifest-driven creation.
2. Wire `#agents-alerts`, `#security`, `#marketing`, `#growth`, `#leadership`, `#compliance` per each agent's settings.json channel list.
3. **Cost cap end-to-end test**: set a $1 monthly cap on a test agent. Exceed it. Confirm hard-stop + Slack alert + cost-ledger entry.
4. **Recovery test**: reboot the VPS. Router container restarts via Docker restart policy. Cloudflared reconnects. Infisical comes back. State persists in SQLite. In-flight sessions either restart cleanly or post a "session interrupted" message per the [Token / Cost Resilience Protocol](agents/PROTOCOLS.md#6-token--cost-resilience-protocol).

### Phase 8 — Multi-project (later)

Only when adding a second target project. The infra is multi-project-ready by design; the work is registering bot installs on the new repo + dropping a `.dev-team.yml` overrides file in that repo's root.

---

## Critical files

In `dev-team`:
- `agents/<persona>/CLAUDE.md` — persona system prompt
- `agents/<persona>/settings.json` — model, hooks, allowed tools, cost caps
- `agents/<persona>/mcp.json` — per-agent MCP server config
- `agents/<persona>/skills/*.md` — persona skills
- `identities/<persona>.yml` — non-secret identity config (App ID, Linear UUID, Slack app ID, channels)
- `router/ARCHITECTURE.md` — router system design
- `router/src/` — router source
- `scheduler/schedules.yml` — cron schedules
- `deploy/docker-compose.yml` — router + cloudflared + infisical
- `deploy/Dockerfile` — router image
- `deploy/README.md` — VPS provisioning + Infisical bootstrap + restore-from-backup

On the VPS:
- `/var/lib/agents/state.sqlite` — router state DB
- `/var/lib/agents/worktrees/<agent>/<task-id>/` — per-task worktrees
- `/var/lib/agents/dev-team/` — clone of config repo
- `/var/lib/agents/dev-team-state/` — clone of state repo
- `/var/log/agents/sessions/<session-id>.jsonl` — per-session deep logs
- Infisical's volume — encrypted secret store

Nothing committed to target repos. No secrets written to disk anywhere outside Infisical's encrypted volume.

---

## Verification

These map to phases. Each is the test you'd run at the end of its phase.

1. **Phase 1 — router-up test** — Router boots with zero agents, posts `started` event to `#agents-alerts`, /health returns 200.
2. **Phase 1 — Infisical-up test** — Login to Infisical web UI via Cloudflare Access; create a test secret; router fetches it via SDK.
3. **Phase 2 — solo persona test** — In a sandbox repo, mention `@strategist-agent draft a PRD for X`. Router routes; Strategist comments with a PRD within minutes.
4. **Phase 2 — config-repo edit test** — Edit `agents/strategist/CLAUDE.md` in `dev-team`, `git push`, VPS auto-pulls. Next Strategist session uses the new prompt without router restart.
5. **Phase 4 — parallel persona test** — Open three Linear tickets, one each to `@strategist-agent`, `@server-agent`, `@client-agent`. All three sessions run concurrently. VPS CPU/RAM stays under 80%.
6. **Phase 5 — Guardian auto-trigger test** — Open a PR that drops test coverage. Guardian comments within 2 minutes (Light tier).
7. **Phase 5 — Guardian sensitive-path test** — Open a PR touching a path in `sensitive-paths.yml`. Guardian posts even when clean (Deep tier always posts).
8. **Phase 6 — Marketer draft test** — Assign a Linear ticket to `@marketer-agent` for a blog post. Draft lands in content repo (or CMS draft); **nothing publishes**.
9. **Phase 6 — publish-gate test** — Tell `@marketer-agent` to publish the post. Routes' PreToolUse action-verb hook blocks; agent refuses; tells human to publish.
10. **Phase 6 — scheduled-job activation test** — Add a once-a-day cron entry (default `enabled: false`); confirm it does NOT fire on its first scheduled tick. Run `/agents schedule enable <id>` from Slack; confirm the next scheduled tick fires + posts a `#growth` summary + inserts a `schedule_runs` row.
11. **Phase 6 — schedule reset test** — Run `/agents schedule disable <id>` then `/agents schedule reset <id>`; confirm the entry returns to its YAML default and `schedule_override_history` shows the toggle trail.
12. **Phase 6 — phase-gate test** — Set `<target-project>/.dev-team.yml` → `project.phase: phase-5`. A schedule entry with `requires_project_phase: phase-6` must NOT fire even if `enabled: true`; `dev-team-logs schedule list` shows ✗ in the phase-gate column.
13. **Phase 7 — cost cap test** — Set $1 monthly cap on a test agent; exceed; confirm hard-stop + `#agents-alerts` post.
14. **Phase 7 — recovery test** — Reboot VPS. Router restarts; cloudflared reconnects; Infisical comes back; in-flight sessions restart cleanly.
15. **Phase 7 — observability test** — Trigger an error in a sandbox session; verify Sentry captures it; verify Axiom shows the trace; verify Grafana dashboard updates; verify the alert reaches `#agents-alerts`.
16. **Phase 2 — Harness PR-only test** — In `#harness-engineering`, ask Harness to make a trivial change (e.g. "add a comment to agents/strategist/CLAUDE.md noting last review date"). Confirm Harness opens a PR against `dev-team`; **never pushes to `main`**. The PR carries label `agent:harness-bot`.
17. **Phase 2 — Harness scope-deny test** — Ask Harness to modify a file under `<target-project>/server/`. Confirm it refuses (writeScope denies); responds explaining its scope is `dev-team/` only.
18. **Phase 2 — Harness self-modify labeling test** — Ask Harness to modify its own CLAUDE.md (e.g. add a sentence to the mission section). Confirm the resulting PR is labeled `meta-self-modify` AND the PR description explicitly calls out the self-modification.
19. **Phase 2 — Harness misbehavior-debug test** — Run an intentional bad agent behavior (e.g. ask Strategist to do something it shouldn't), capture the session_id. Then ask Harness to investigate using the session_id. Confirm Harness reads the deep-trace, identifies the root cause, and PRs a corrective change. PR labeled `urgent`.
20. **Phase 2 — Harness monthly survey test** — Run `harness-gap-analyzer-monthly` once via `/agents schedule run harness-gap-analyzer-monthly`. Confirm a digest posts to `#harness-engineering`; confirm **no PR was opened** (gap-analyzer is digest-only).

---

## Open questions

Blockers for specific phases — most are answered before or during Phase 1.

1. **Target project name + GitHub org** — pick in Phase 0. Determines where `<target-project>` repo lives + which GitHub org owns the bot GitHub Apps. Mild preference for a separate "agents" org for cleaner identity separation.
2. **Anthropic billing** — pay-as-you-go API key vs. an Anthropic API console workspace with monthly invoice. Decide before Phase 1.
3. **One Anthropic key vs per-agent keys** — one key is simpler; per-agent keys give per-agent attribution in Anthropic's billing dashboard at the cost of more keys to manage. Mild preference for per-agent.
4. **VPS region** — Ashburn (default, low latency to Anthropic + GitHub) or Frankfurt (low latency to a European founder/team). Decide before Phase 1.
5. **Infisical SaaS vs self-hosted** — locked decision: self-hosted on the same VPS. Reconsider if Infisical-the-container becomes ops-heavy.
6. **Whether to also onboard existing repos later** — orthogonal to greenfield bootstrap; covered by Multi-project planning in [AGENTS.md](AGENTS.md) when needed.
7. **Router language + framework** — locked: TypeScript / Node 20 / Fastify. Single artifact; SDK is first-class TypeScript; team familiarity high.
8. **Conversation continuity timeout** — how long does the router consider a thread "the same session" before starting fresh? Default proposal: 30 days of inactivity on a thread → new session. Configurable per-agent in `settings.json`.

---

## Next step

Agent roster is locked in [AGENTS.md](AGENTS.md). The bootstrap is phased — see above. Concrete next moves:

1. Answer the eight open questions in this file and the seven at the bottom of [AGENTS.md](AGENTS.md).
2. **Author `router/ARCHITECTURE.md`** — the router system design doc (single source of truth for what we'll build). Captures: component boundaries, the state schema, the hook-handler model, the routing table format, the cost-cap algorithm, the conversation-continuity rules, the worktree lifecycle.
3. **Phase 0**: drop a `founding/` directory in this repo as the templates' destination, then use Claude Code locally to draft `PRODUCT.md` / `BRAND.md` / `STACK.md` for the target project.
4. **Phase 1**: order Hetzner, set up Cloudflare Tunnel, deploy Infisical, deploy the empty router scaffold, sign up for Axiom / Sentry / Grafana Cloud free tiers, create `dev-team-state` repo.
5. **Phase 2**: scaffold `agents/strategist/` into the live router, register the first GitHub App, smoke-test in a sandbox repo.

Each phase ends with its corresponding verification check. Don't move to the next phase until the current one passes.
