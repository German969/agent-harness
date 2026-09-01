# dev-team

Managed Claude agents for software development. Six **product-facing** agents — Strategist, Platform, Builder-Server, Builder-Client, Guardian, Marketer — that work on a target project. Plus a 7th **meta-agent (Harness)** that maintains the agent harness itself (this repo). All seven run on a self-hosted router that ingests webhooks from GitHub / Linear / Slack and spawns Claude SDK sessions per trigger.

This repo holds **everything except secrets and runtime state**: agent system prompts, skills, settings, routing rules, scheduled jobs, the router source, the deploy stack, and the planning docs that tie them together. Harness is the agent that maintains all of the above — it does what humans + local Claude Code did during bootstrap.

---

## Read in this order

| If you're… | Start here | Then |
|---|---|---|
| New to the project | [PLAN.md](PLAN.md) | [AGENTS.md](AGENTS.md) |
| Building the router | [router/ARCHITECTURE.md](router/ARCHITECTURE.md) | [agents/PROTOCOLS.md](agents/PROTOCOLS.md) |
| Designing a new agent | [AGENTS.md](AGENTS.md) | existing `agents/<name>/SPEC.md` + `CLAUDE.md` as templates |
| Authoring founding docs for a target project | [templates/founding/README.md](templates/founding/README.md) | each template file in that directory |
| Curious about cost | [COST_ANALYSIS.md](COST_ANALYSIS.md) | |
| Modifying an agent's behavior | `agents/<name>/CLAUDE.md` (system prompt) + `settings.json` (model, hooks, costCap) + `skills/*.md` | |
| Toggling scheduled jobs | [scheduler/schedules.yml](scheduler/schedules.yml) | [router/ARCHITECTURE.md §2.8](router/ARCHITECTURE.md#28-scheduler) |
| Wiring a new bot identity | [identities/README.md](identities/README.md) | [identities/](identities/) |

---

## Repo layout

```
dev-team/
├── PLAN.md                    The bootstrap plan — phases 0 through 8
├── AGENTS.md                  Agent roster, responsibilities, multi-project planning
├── COST_ANALYSIS.md           Monthly cost model + levers
├── README.md                  This file
│
├── agents/                    The agents (six product-facing + one meta)
│   ├── PROTOCOLS.md             Cross-agent protocols (contracts, sensitive paths, labels, etc.)
│   ├── strategist/              Product / BA / PjM / Researcher / Curator / Triage / Founding
│   ├── platform/                Architect / DevOps / Release / FinOps / Incident / System-design
│   ├── builder-server/          Backend / Contract-design / AI-specialist / Data-engineer / PR-feedback
│   ├── builder-client/          Frontend / Mobile / a11y / Design-handoff / Screenshots / PR-feedback
│   ├── guardian/                QA / Security / Performance / Compliance / Design-system / LLM-security
│   ├── marketer/                Campaign / Content / Social / Email / Benchmarking / Growth / PR / Briefs
│   └── harness/                 META — gap-analyzer / agent-modifier / agent-architect / skill-author / misbehavior-debugger / router-engineer
│       Each directory contains:
│         CLAUDE.md              system prompt (the persona)
│         settings.json          model, hooks, allowed tools, cost caps
│         mcp.json               MCP server config (Linear/GitHub/Slack + per-agent extras)
│         skills/<name>.md       per-skill specialized knowledge
│
├── identities/                Per-agent bot identity (App IDs, agent UUIDs, channels, routing rules)
│   ├── README.md
│   ├── strategist.yml
│   └── ...                    one per agent
│
├── scheduler/
│   └── schedules.yml          All cron jobs (default off; toggle via /agents schedule enable)
│
├── router/
│   ├── ARCHITECTURE.md        System design for the custom router (single source of truth)
│   ├── IMPLEMENTATION_PLAN.md   Build plan + per-phase status (execution, vs. ARCHITECTURE's design)
│   ├── src/                     The router service (TypeScript)
│   └── tests/                   Vitest suite
│
├── templates/
│   └── founding/              Project-agnostic templates for PRODUCT/BRAND/STACK/COMPLIANCE
│
└── deploy/                    Docker stack for the router + infisical + cloudflared, plus the VPS runbook
```

---

## Architecture in one paragraph

The router is a TypeScript service running on a Hetzner VPS, exposed via Cloudflare Tunnel (outbound-only). It receives webhooks from GitHub / Linear / Slack, classifies them to one of seven agents based on `identities/*.yml` routing rules + the mention/assignment/label context, prepares a per-task git worktree, fetches per-session secrets from a self-hosted Infisical instance, applies SessionStart hooks from the agent's `settings.json` (loading founding docs + state + per-skill files), invokes the Claude Agent SDK with the agent's `CLAUDE.md` as the system prompt, streams the output back to the trigger surface, and persists session state to SQLite. Scheduled jobs (cron) share the same pipeline. Costs are tracked per session in a ledger; per-agent monthly + per-job caps refuse runaway sessions pre-flight. **Harness, the meta-agent, has inverted scope** — it writes only to `dev-team/`, via PR-only (never to `main`); the router enforces this at three layers (deny list, PreToolUse hook, SessionEnd hook). See [router/ARCHITECTURE.md](router/ARCHITECTURE.md) for the full design.

---

## Status

**The fleet is running.** The router is built and deployed to the VPS; three of the seven agents are live and working a real target project. Phases 0–3 of the [PLAN.md](PLAN.md) bootstrap are done.

**Router** — all implementation phases complete: ingress, classifier, worktree manager, runtime (Claude Agent SDK + hooks + MCP), reply streamer, cost cap + ledger, scheduler, observability, CLI, deploy stack. The real `AnthropicSdkClient` is wired and activates when `ANTHROPIC_API_KEY` is set or `SECRETS_PROVIDER=infisical`; the placeholder client remains only so a bare boot fails loudly instead of silently making live calls. `.github/workflows/ci.yml` gates every PR and push on `lint · typecheck · test · build`, and `deploy.yml` depends on it — nothing reaches the VPS red. Known gaps: the scheduler's Slack slash-command surface and Sentry wiring are both deferred, not missing by accident. See [router/IMPLEMENTATION_PLAN.md](router/IMPLEMENTATION_PLAN.md) for per-phase detail.

**Agents** — identity config in [identities/](identities/) is the source of truth for what's actually wired; a `~` means not yet created.

| Agent | Status | Phase |
|---|---|---|
| Harness | live | 2 |
| Strategist | live | 2 |
| Platform | live | 3 |
| Builder-Server · Builder-Client | not wired | 4 — **next** |
| Guardian | not wired | 5 |
| Marketer | not wired | 6 |

**Target project** — `PROJECT_NAME=iris`, in [`German969/chatbots`](https://github.com/German969/chatbots). Founding docs (`PRODUCT` / `BRAND` / `STACK` / `COMPLIANCE`) are committed, M0 foundations shipped, and M1 is scoped into a ready backlog. State persists to `dev-team-state`.

**Next move — Phase 4, the Builders.** Strategist and Platform have produced a scoped backlog and an architecture; there is currently no agent that can execute either. Per [PLAN.md](PLAN.md) §Phase 4, for each builder: create the GitHub App, register the Linear agent, fill the placeholders in `identities/builder-*.yml`, wire the routing entry, deploy, smoke-test.

> **Keeping this honest:** this section drifted badly once — it claimed the router was unwritten and no identities existed, long after both were false. If you change what's deployed, change this. `identities/*.yml` and `router/IMPLEMENTATION_PLAN.md` are the ground truth it summarizes.

---

## Discipline

A few rules worth surfacing here:

- **No secrets in this repo.** All credentials live in Infisical. The `identities/*.yml` files reference secrets by name only.
- **Drafts not publishes.** Marketer never publishes externally; the router's PreToolUse action-verb hook enforces this at the platform level.
- **PRs not pushes.** Harness never pushes to `main`; every harness change is human-reviewed via PR. Triple-layer enforcement.
- **No autonomous production.** Platform's `production-safety` rule supersedes all others, including incidents.
- **Founding docs are sacred.** Once committed, `<target-project>/founding/*` is read-only for all agents — modifying them requires a human PR.
- **Schedule jobs default OFF.** Every cron entry lands `enabled: false`; activation is deliberate per project phase.
- **Agents are spec-driven.** Behavior changes happen via PR to `agents/<name>/`, not by ad-hoc prompting.
