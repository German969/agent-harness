# Agent Roster

This document defines the agent personas. Each agent has its own system prompt, skills, tool permissions, model selection, and trigger surfaces.

We list the full 26 first to clarify the design space, then pick the top 6 that absorb the rest — these are the **product-facing agents** that work on the target project. The absorbed responsibilities become **skills** loaded inside the top-6 agents rather than separate personas.

A 7th **meta-agent (Harness)** sits outside that framing. It maintains the harness itself — the `dev-team` repo, the router, the scheduler, the protocols. While the top-6 work on the customer-facing product, Harness works on **the agents' product**: building new agents, modifying existing ones, debugging misbehaviors, evolving the router. See "[The Top 6 + Harness](#the-top-6)" below.

Visual design production is **not** done by an agent — it's done by humans using **Claude Design** (claude.ai/design), Anthropic's web product. See "Complementary tool: Claude Design" below for how it slots into the workflow.

---

## Context-handling primitives

These apply to every agent. They're listed once here so each persona below can be defined tersely.

- **House-style base prompt** — every agent's `CLAUDE.md` starts with a shared project house-style preamble (tech stack, conventions, PR rules, naming domain mappings). The preamble lives **in the target project** at the path configured in `.dev-team.yml` (default: `<target-project>/founding/`). For a greenfield project, the founding docs are authored in Phase 0 by humans + Claude Code on a laptop, using the templates in `dev-team/templates/founding/` (project-agnostic blueprints) as the structural starting point and filling them out for this specific project — see [PLAN.md](PLAN.md) → Greenfield bootstrap. Persona-specific guidance is appended below the loaded founding content.
- **Skill scope** — each agent only loads its own `agents/<persona>/skills/` directory. Other personas' skills are off the table to keep context lean.
- **Session memory** — the router opens a fresh Claude Agent SDK session per webhook. Long-lived knowledge lives as committed files in a separate state repo (see "Multi-project planning" below) and is loaded via a SessionStart hook (see [router/ARCHITECTURE.md §2.11](router/ARCHITECTURE.md#211-hooks)).
- **Cross-agent handoffs** — agents trigger each other by writing into the source-of-truth surface (Linear ticket, PR comment, Slack thread). E.g. the strategist creates a Linear ticket and assigns it to the server-bot; the server-bot ships a PR; the guardian reviews it.
- **Human-in-the-loop visual work** — when an agent needs polished visuals (product mockups, marketing graphics), it generates a brief or pre-fill (prompt + context bundle) and posts it for a human to execute in Claude Design / Canva / Figma. The human iterates there and pastes the output back into a Linear ticket / PR / draft queue.
- **Model tiers** — `haiku` for cheap/fast/repetitive work, `sonnet` for code, review, content, and reasoning, `opus` only for hard cross-system design or highest-stakes external content (rare; needs explicit opt-in). Opus is *not* the default anywhere in the agent fleet.
- **Trigger surfaces** — not every agent listens to every surface. Each persona's entry below lists which surfaces it subscribes to.
- **Output destination** — every agent declares where its work lands (PR, comment, doc commit, Linear ticket, draft queue). This is the anti-confusion contract.
- **Blast radius** — explicit per persona: which directories the agent can write to, which tools it can run, whether it can push to a default branch (never), whether it can publish externally (never without human gate), whether it can deploy (never without human gate).

---

## The full 26 agents (design space)

### Product & Discovery

#### 1. Product Manager (PM)
- **Mission**: Turn fuzzy requests into shippable PRDs and Linear tickets with acceptance criteria.
- **Inputs**: Slack threads, Linear comments, customer feedback docs, analytics summaries.
- **Outputs**: PRD docs (`docs/prds/*.md`), Linear tickets with structured AC, scope-cut proposals.
- **Surfaces**: Slack, Linear. *Not* GitHub.
- **Reads**: PRD repo, prior tickets, product docs. Never deep into code.
- **Writes**: docs repo, Linear API.
- **Model**: Sonnet.

#### 2. Designer
- **Mission**: Propose UI/UX changes; flag design-system violations; review screenshots in PRs. **Polished visual production is delegated to Claude Design (claude.ai/design), driven by a human.**
- **What this agent persona handles** (the parts an agent can do well):
  - Pre-fill generation for Claude Design — gather codebase context + design system summary + ticket requirements into a ready-to-paste prompt.
  - PR-level design-system compliance review (token violations, hardcoded values, missing UI-kit usage).
  - Drift detection across PRs (the design system is slowly being eroded — flag it).
- **What this agent persona does *not* do**: produce mockups, run interactive design sessions, generate prototypes. Those happen in Claude Design with a human.
- **Where its responsibilities land in the Top 6**: split across Builder-Client (authoring with the system + Claude Design pre-fill), Guardian (PR-level review), and Strategist (pre-fill generation in PRDs that involve design work).

#### 3. Business Analyst (BA)
- **Mission**: Quantify "should we build this" — data pulls, ROI estimates, gap analysis.
- **Outputs**: Analysis reports, decision matrices.
- **Surfaces**: Slack, Linear comments.
- **Reads**: read-only DB access (staging snapshot), analytics exports, business docs.
- **Writes**: `docs/analysis/`.
- **Model**: Sonnet.

#### 4. Project Manager (PjM)
- **Mission**: Status, schedule, dependency tracking, risk flagging.
- **Inputs**: Linear ticket states, GitHub PR/issue activity, sprint plan, team capacity.
- **Outputs**: Daily/weekly status reports in Slack, risk flags in Linear, blocked-ticket nudges.
- **Surfaces**: Scheduled (cron via the router's scheduler), Slack mentions, Linear.
- **Writes**: Slack channels, Linear comments. Never code.
- **Model**: Haiku.

#### 5. Researcher
- **Mission**: Investigate technologies, libraries, competitors, papers — produce a decision-ready brief.
- **Outputs**: Research briefs (`docs/research/*.md`) with sources and recommendation.
- **Surfaces**: Slack `/research`, Linear assignment.
- **Reads**: web (broad allowlist), repo metadata. Read-only on code.
- **Writes**: `docs/research/`, brief PRs in the agents config repo.
- **Model**: Haiku for surveys; Sonnet for synthesis tasks.

### Engineering

#### 6. Backend Engineer
- **Mission**: Ship backend work — NestJS services, MikroORM entities, migrations, REST/GraphQL endpoints, tests.
- **Surfaces**: GitHub (primary), Linear.
- **Reads**: `server/`, `tests/api-tests/`, `infra/db/`.
- **Writes**: backend code, migrations, API tests. Opens PRs; never pushes to `staging` or `main`.
- **Model**: Sonnet.

#### 7. Frontend Engineer
- **Mission**: Ship frontend work — Gatsby/React, Tailwind tokens, UI kit components, GraphQL queries. **Consumes Claude Design handoff bundles** when a ticket has one attached.
- **Surfaces**: GitHub, Linear.
- **Reads**: `client/`, design tokens, UI kit, handoff bundles attached to tickets/PRs.
- **Writes**: frontend code, frontend tests. Opens PRs.
- **Model**: Sonnet.

#### 8. Mobile Engineer
- **Mission**: Ship mobile work on `<target-project>/mobile` or a sibling mobile repo (React Native, assumed — confirmed during Phase 0).
- **Surfaces**: GitHub (mobile repo), Linear.
- **Reads**: mobile repo, shared API contracts.
- **Writes**: mobile code, mobile tests.
- **Model**: Sonnet.

#### 9. AI Specialist
- **Mission**: LLM features — prompts, RAG, evals, model selection — primarily in `server/services/ai/`.
- **Reads**: `server/services/ai/`, prompt templates, eval suites.
- **Writes**: AI service code, evals, prompt files.
- **Model**: Sonnet (Opus for prompt design only).

### Platform

#### 10. Software Architect
- **Mission**: ADRs, cross-service consistency, refactoring proposals, dependency graph hygiene.
- **Outputs**: ADRs (`docs/adrs/*.md`), PR comments flagging architecture violations, refactor proposals.
- **Reads**: every repo.
- **Writes**: `docs/adrs/`, PR comments, occasional refactor PRs.
- **Model**: Sonnet (Opus opt-in for big design).

#### 11. DevOps Engineer
- **Mission**: CI/CD, Docker, infra-as-code, deployment runbooks, observability config, incident response.
- **Outputs**: PRs on `.github/workflows/`, `Dockerfile`, `docker-compose.yaml`, Terraform, runbook updates.
- **Reads**: `.github/`, all Dockerfiles, deploy configs, monitoring configs.
- **Writes**: infra files. Never deploys to production directly.
- **Model**: Sonnet.

### Quality & Security

#### 12. QA Engineer
- **Mission**: Test plans, write missing tests (unit/integration/e2e), bug reproduction, regression checks.
- **Outputs**: PRs adding tests, test plan docs, bug repro PRs.
- **Writes**: test files only (`tests/`, `*.spec.ts`, `*.test.ts`).
- **Model**: Sonnet (Haiku for trivial test scaffolding).

#### 13. Security Specialist / Pentester
- **Mission**: PR security review, dependency CVE scanning, secret-leak detection, threat-model proposals.
- **Outputs**: Security finding comments on PRs, CVE remediation PRs, threat models in `docs/security/`.
- **Reads**: auth code, secrets handling, dependency lock files, network configs.
- **Writes**: `docs/security/`, dependency updates. Read-only on most code.
- **Model**: Sonnet.

### Data & Knowledge

#### 14. Data Engineer / Analytics Engineer
- **Mission**: Build and maintain data pipelines, time-series schemas, dbt-style transformations, analytics models. Different from BA — BA *analyzes*, DE *builds the substrate*.
- **Outputs**: PRs on data infra (`server/infra/db-series/`, ETL scripts), schema migration PRs.
- **Reads**: `server/infra/db/`, `server/infra/db-series/`, analytics SQL files, background-worker.
- **Writes**: data-pipeline code, time-series migrations.
- **Model**: Sonnet.

#### 15. Knowledge Curator / Doc Steward
- **Mission**: Keep documentation accurate — READMEs, `CLAUDE.md` files (for target repos *and* for the agents' own configs), ADR indices, architecture diagrams. Detects drift between docs and code.
- **Inputs**: Scheduled weekly run, post-merge hooks on code changes that touch documented areas.
- **Outputs**: Docs PRs, "this `CLAUDE.md` says X but the code does Y" issues.
- **Reads**: All docs files + the code they describe.
- **Writes**: Docs only — never code.
- **Model**: Haiku.

#### 16. Support / Triage
- **Mission**: First responder for incoming bugs and feature requests. Reproduces bugs, structures them into Linear tickets, routes to the right engineer-bot.
- **Outputs**: Structured Linear tickets with reproduction steps, routing decisions.
- **Surfaces**: Linear, Slack.
- **Writes**: Linear tickets, comments.
- **Model**: Haiku for triage, Sonnet for reproduction.

### Operations

#### 17. Release Manager
- **Mission**: Cut releases, generate changelogs from PR history, version bump, coordinate deploy gates.
- **Outputs**: Changelog PRs, version bump PRs, GitHub releases.
- **Surfaces**: GitHub, Slack `#releases`.
- **Writes**: CHANGELOG, version bumps.
- **Model**: Haiku.

#### 18. Performance Engineer
- **Mission**: Profile, find bottlenecks, propose perf fixes. Mostly reactive — fires on perf-tagged PRs or explicit invocation.
- **Outputs**: Perf-finding comments on PRs, perf-fix PRs (when high confidence), load-test reports.
- **Surfaces**: GitHub, Slack `#perf`.
- **Model**: Sonnet.

### Compliance & UX Quality

#### 19. Accessibility (a11y)
- **Mission**: WCAG compliance, color contrast, semantic HTML, screen reader compatibility.
- **Outputs**: a11y findings as PR comments, accessibility fix PRs.
- **Writes**: a11y-only fixes (aria attributes, contrast adjustments, semantic markup).
- **Model**: Sonnet.

#### 20. Compliance / Privacy
- **Mission**: GDPR / SOC2 / regulatory paperwork. Audit trail review, data-handling review on code touching PII.
- **Outputs**: Compliance findings, audit reports, policy doc updates.
- **Surfaces**: Linear, GitHub PR comments (rarely).
- **Writes**: `docs/compliance/`, audit reports.
- **Model**: Sonnet.

### Financial Observability

#### 21. FinOps / Cost Optimizer
- **Mission**: Watch cloud bills (Anthropic API, Hetzner, third-party APIs), find savings, alert on anomalies.
- **Outputs**: Cost reports, savings recommendations, budget alerts.
- **Surfaces**: Slack `#finops`, Linear.
- **Reads**: Billing exports (read-only).
- **Writes**: Reports only.
- **Model**: Haiku.

### Marketing & Growth

#### 22. Content Writer / Blog Writer
- **Mission**: Long-form content — blog posts, technical content marketing, case studies, whitepapers, customer stories.
- **Inputs**: Campaign briefs, product release notes, customer testimonial transcripts, SEO keyword targets.
- **Outputs**: Markdown drafts in a content repo (e.g. `<target-project>-marketing/blog/` or a `blog/` directory inside `<target-project>`) or via CMS API as drafts. Never publishes.
- **Surfaces**: Linear (campaign tickets), Slack `#marketing`.
- **Reads**: Brand guidelines, prior content, product docs, customer success stories.
- **Writes**: drafts only — never publishes.
- **Model**: Sonnet.

#### 23. Social & Community Manager
- **Mission**: Draft social media posts (LinkedIn, X, etc.), suggest responses to mentions/DMs.
- **Inputs**: Scheduled cadence (e.g. 2× weekly), product updates, campaign launches, inbound mentions.
- **Outputs**: Drafted posts in an approval queue (Buffer / Hootsuite, or a `social-drafts/` directory in the marketing repo).
- **Surfaces**: Slack `#marketing` (drafts), scheduled cron.
- **Reads**: Brand voice guidelines, recent product news, community comments.
- **Writes**: drafts only — humans approve and post.
- **Model**: Haiku (Sonnet for nuanced engagement responses).

#### 24. Email & Lifecycle Marketer
- **Mission**: Newsletter drafts, lifecycle email sequences (onboarding, re-engagement, churn prevention), product announcement emails.
- **Inputs**: Campaign briefs, segment definitions, feature launches.
- **Outputs**: Email drafts in the email platform (Customer.io / Mailchimp / Brevo / Loops / Resend — chosen in Phase 6) as unscheduled drafts, or markdown in a content repo (e.g. `<target-project>-marketing/email/`).
- **Surfaces**: Linear, Slack.
- **Writes**: drafts in email platform via API; never sends.
- **Model**: Sonnet.

#### 25. SEO & Growth Analyst
- **Mission**: Keyword research, on-page SEO recommendations, funnel/conversion analysis, A/B test ideation, attribution modeling.
- **Inputs**: GA4 / Mixpanel / PostHog exports (read-only), Search Console data, competitive analysis requests.
- **Outputs**: SEO recommendation docs, funnel reports, A/B test proposals.
- **Surfaces**: Linear, Slack.
- **Reads**: Analytics (read-only via MCP), public site, competitor sites.
- **Writes**: `docs/marketing/seo/`, A/B test proposal docs.
- **Model**: Sonnet.

#### 26. PR / Brand Steward
- **Mission**: Press releases, partner announcements, brand voice consistency, brand guidelines stewardship.
- **Inputs**: PR-tagged tickets, partnership news, major launches.
- **Outputs**: Press release drafts, brand voice audit reports, brand guideline updates.
- **Surfaces**: Linear, Slack (`#leadership` for high-stakes drafts).
- **Writes**: `docs/brand/`, press release drafts. Strongly gated — requires explicit human sign-off (and often legal review) before any external publication.
- **Model**: Sonnet (Opus opt-in for highest-stakes content like funding announcements, partner launches).

---

## Complementary tool: Claude Design

Claude Design (Anthropic Labs, claude.ai/design) is the visual production surface. It's not an agent — it's a human-driven web product powered by Opus 4.7 that produces mockups, prototypes, slides, and one-pagers, and exports a handoff bundle that Claude Code (or our Builder-Client agent) can implement directly.

We treat Claude Design as the **human side** of the design workflow. The agents handle the automatable bits around it.

### Two distinct visual workflows

| Workflow | Tool | Driven by | Output |
|---|---|---|---|
| Product UX (mockups, prototypes that become code) | Claude Design | Human (designer / PM / engineer) | Handoff bundle → Builder-Client implements |
| Marketing visuals (hero images, social cards, infographics, ad creatives) | Canva / Figma / Claude Design (for slides/one-pagers) | Human (marketer / designer) | Published asset; Marketer references it in posts/emails |

The Marketer agent drafts text and visual *briefs* (composition spec, key message, brand voice); humans execute the visual in their tool of choice.

### End-to-end design workflow (product UX)

```
1. Strategist (PM skill)               2. Strategist (Claude Design          3. Human in claude.ai/design
   ─────────────────────                  pre-fill skill)                       ───────────────────────────
   Drafts PRD/Linear ticket  ────▶     Generates pre-fill prompt   ────▶      Iterates on canvas;
   describing the feature.             with codebase context +                exports handoff bundle.
                                       design system summary +
                                       PRD acceptance criteria.
                                                                                          │
                                                                                          ▼
6. Guardian                            5. Builder-Client                      4. Human pastes handoff
   ─────────                              ────────────────                       bundle into Linear ticket
   Auto-reviews the PR:              ◀── Reads the handoff bundle,        ◀──   or assigns to `@client-agent`.
   - QA coverage                        writes the implementation
   - Security                           PR (uses design tokens,
   - Design-system compliance           consumes UI kit components).
   - Perf, a11y, compliance
```

### What skills the workflow requires (and which agent owns each)

| Skill | Owner | Trigger |
|---|---|---|
| Generate Claude Design pre-fill in a PRD that involves UI work | **Strategist** | When drafting a PRD/Linear ticket marked `needs-design` |
| Generate Claude Design pre-fill when a UI ticket arrives without a design | **Builder-Client** | When `@client-agent` is assigned a UI ticket and no handoff bundle is attached — bot refuses to implement and posts the pre-fill back to the human |
| Consume a Claude Design handoff bundle and implement it | **Builder-Client** | Bundle attached to a ticket / PR assigned to `@client-agent` |
| Design-system compliance review on UI PRs (tokens, hardcoded values, missing UI-kit usage) | **Guardian** | Auto on every UI PR (path-tier-aware) |
| Design-system drift detection across many PRs | **Guardian** (scheduled skill) | Weekly cron — opens an issue if drift exceeds a threshold |
| Generate visual brief for marketing assets (hero image spec, social card composition, infographic outline) | **Marketer** | When drafting a campaign that needs visuals |

### Subscription/cost notes

- Claude Design access is bundled in Claude Pro / Max / Team / Enterprise tiers. The team needs at least one human seat on a tier that includes Claude Design.
- Cost of Claude Design usage is part of the human seat's subscription quota, not the agent infra.
- The agents themselves don't consume Claude Design — they only generate prompts/briefs for humans. So no extra API token cost for the agent fleet from this tool.

---

## Absorption analysis

Personas merge cleanly when their inputs, outputs, surfaces, and blast radius are similar. Below is the final mapping. Designer's responsibilities split across three top-6 agents plus the Claude Design human tool. Marketing roles cluster into Marketer.

| Cluster | Members | Why they merge |
|---|---|---|
| **Strategist** | PM, BA, PjM, Researcher, Knowledge Curator, Support/Triage, *plus Designer's Claude Design pre-fill responsibility* | All read-only on code, output to docs/Linear/Slack, no GitHub PRs. The Claude Design pre-fill is text generation with codebase context — fits Strategist's shape. |
| **Builder-Server** | Backend, AI Specialist, Data Engineer | Same `server/` codebase boundary, same tooling (NestJS, MikroORM, tests, migrations), same PR target. Data Engineer joins because its work lives in `server/infra/db-series/` and adjacent. |
| **Builder-Client** | Frontend, Mobile, Accessibility, *plus Designer's authoring responsibility and Claude Design pre-fill / handoff-consumption* | Same TS/React world, shared design tokens, shared GraphQL contracts. Mobile is RN — confirmed merge. a11y joins as a pre-merge check skill. Builder-Client owns "consume a Claude Design handoff bundle" and "generate a pre-fill when no design exists." |
| **Platform** | Architect, DevOps, Release Manager, FinOps | All read-everything, gate-keep cross-cutting changes. Release and FinOps are scheduled-tasks layered on top of the same observability surface. |
| **Guardian** | QA, Security, Performance, Compliance, *plus Designer's PR-level review responsibility* | All auto-fire on PR opened, all produce read-only review comments, all occasionally open remediation PRs. Design-system compliance fits this shape exactly — it's another flavor of "review a PR against rules." |
| **Marketer** | Content Writer, Social & Community, Email & Lifecycle, SEO & Growth, PR & Brand Steward | All external-facing content with a brand voice, all human-gated publication, same toolbelt: web/analytics reading, draft generation, brand-voice consistency. Different output channels (CMS, email tool, social scheduler) but the same "draft-then-human-publishes" pattern. |

### Mobile — confirmed merged

Mobile is assumed React Native (confirmed in Phase 0). Builder-Client handles it via a skill that knows about RN-specific build/test/release commands. Promote out only if mobile-only PR throughput justifies the dedicated bot in the future. If Phase 0 picks native (Swift + Kotlin) instead, Mobile gets its own slot from day one.

### Designer — absorbed, not promoted

The Designer persona's three automatable responsibilities each found a clean home:
- **Authoring with the design system** → Builder-Client skill (design-token discipline, UI-kit-first authoring).
- **PR-level review for design-system compliance** → Guardian skill (joins QA/Security/Perf/Compliance/a11y).
- **Claude Design pre-fill generation** → primarily Strategist skill (in PRDs); also Builder-Client skill (when a UI ticket arrives without a design, refuse to implement and post the pre-fill).

Visual production goes to Claude Design with a human at the keyboard.

### Marketer — promoted to its own slot

Marketer is its own top-6 slot rather than absorbed into Strategist because:

1. **Different audience** — Marketer writes for *external customers*; Strategist writes for *internal team*. Voice and tone diverge sharply.
2. **Different surfaces** — Marketer publishes to CMS, email platforms, social schedulers, ad tools. Strategist writes to Linear and docs repos.
3. **Different blast radius** — Marketer can damage the brand with one bad public post. Heavy human-gating on publishing is structurally distinct from Strategist's gated Linear mutations.
4. **Different toolbelt** — analytics MCPs (GA4 / Mixpanel / PostHog), CMS APIs, email-platform APIs, social schedulers. None of these are in Strategist's toolbelt.
5. **Different memory** — brand voice guidelines, prior campaigns + results, editorial calendar, SEO keyword strategy, customer testimonial library. All meaningfully separate from Strategist's roadmap/research state.

Folding Marketer into Strategist would either bloat Strategist's CLAUDE.md to incoherence or force one of the two voices to suffer. Keeping them separate is cleaner and the cost (one more bot identity) is small.

---

## The Top 6 + Harness

The Top 6 are **product-facing agents** that work on the target project. Harness is the **meta-agent** that maintains the harness itself (this dev-team repo, the router, the scheduler). Structurally different write-scope: the Top 6 write to target-project repos; Harness writes to `dev-team/` only.

| # | Agent | Absorbs | Trigger handle | Surfaces | Default model | Write scope |
|---|---|---|---|---|---|---|
| 1 | **Strategist** | PM, BA, PjM, Researcher, Knowledge Curator, Support/Triage, *Designer (pre-fill skill)* | `@strategist-agent` | Slack, Linear | Sonnet (note: uses `modelOverrides` for cost optimization on cheaper skills) | docs, Linear (tiered — see locked decisions) |
| 2 | **Builder-Server** | Backend, AI Specialist, Data Engineer | `@server-agent` | GitHub, Linear | Sonnet | `server/`, backend tests, migrations, data pipelines |
| 3 | **Builder-Client** | Frontend, Mobile, Accessibility, *Designer (authoring + pre-fill + handoff consumption)* | `@client-agent` | GitHub, Linear, Slack | Sonnet | frontend code in `<target-project>`, mobile repo (if any), frontend tests |
| 4 | **Platform** | Architect, DevOps, Release Manager, FinOps | `@platform-agent` | GitHub, Slack alerts, scheduled | Sonnet (Opus opt-in) | `.github/`, Dockerfiles, infra files, ADRs, CHANGELOG, cost reports |
| 5 | **Guardian** | QA, Security, Performance, Compliance, *Designer (PR-level review)* | `@guardian-agent` (auto on PR open) | GitHub, Slack `#security`/`#perf` | Sonnet | tests only, security/compliance/design-system docs, dependency PRs, perf fixes (gated) |
| 6 | **Marketer** | Content Writer, Social, Email/Lifecycle, SEO/Growth, PR/Brand | `@marketer-agent` | Slack `#marketing`, Linear, scheduled | Sonnet (Haiku for social, Opus opt-in for high-stakes PR) | marketing content drafts, email platform drafts, social drafts queue, brand docs |
| 7 | **Harness** *(meta-agent)* | n/a — does not absorb the original 26. New role: maintains the harness itself. | `@harness-agent` | Slack `#harness-engineering`, Linear, monthly cron | Sonnet (Opus opt-in for new-agent authoring + foundational router changes) | **`dev-team/**` only**, PR-only. Never pushes to main. Never touches target project repos, secrets, or VPS. |

### How the 6 cover the 26 in practice

**1. Strategist** — Seven skills loaded conditionally:
- PRD draft → PM skill.
- ROI / data pull → BA skill.
- Daily standup summary → PjM skill (scheduled).
- Tech/lib brief → Researcher skill.
- Weekly drift check → Knowledge Curator skill (scheduled, opens "your CLAUDE.md disagrees with reality" issues).
- Incoming bug → Triage skill (reproduces, routes to engineer-bot).
- Feature spec involves UI → Claude Design pre-fill skill (generates a paste-ready prompt with codebase + design-system context; posts it to the ticket with a "human, open this in claude.ai/design" note).

**2. Builder-Server** — Three skills:
- Default backend work → Backend skill.
- AI-tagged ticket → AI Specialist skill (prompt evals, RAG, vendor evaluation).
- Data-tagged ticket → Data Engineer skill (pipelines, time-series, dbt-style transforms).

**3. Builder-Client** — Five skills:
- Frontend ticket → Frontend skill (design-token-aware authoring; uses existing UI kit components).
- Mobile ticket → Mobile skill (RN-aware tooling).
- UI PR opened → a11y skill auto-runs as a pre-merge check.
- UI ticket without a design → Claude Design pre-fill skill (refuses to implement; generates and posts a pre-fill prompt for a human to use in claude.ai/design).
- UI ticket with a Claude Design handoff bundle → handoff-consumption skill (parses the bundle, implements the feature in code).

**4. Platform** — Four skills:
- Architecture question → Architect skill (ADRs, cross-service refactor).
- CI/infra change → DevOps skill.
- Weekly release cadence → Release Manager skill (scheduled).
- Daily/weekly billing review → FinOps skill (scheduled, anomaly alerts).

**5. Guardian** — Five skills running on every PR (subject to path-tiered scan depth, see locked decisions):
- QA skill — coverage check, missing tests.
- Security skill — CVE scan, secret leak, auth-touching diff review.
- Performance skill — perf-regression detection on perf-tagged PRs.
- Compliance skill — PII/data-handling review on tickets/PRs that touch those paths.
- Design-system skill — token violations, hardcoded color/spacing/radius, missing UI-kit usage. Auto on UI PRs. Weekly scheduled scan for cross-repo drift.

**6. Marketer** — Five skills loaded conditionally:
- Blog / long-form content brief → Content Writer skill (drafts markdown, never publishes).
- Scheduled cadence or campaign launch → Social skill (drafts posts into approval queue).
- Newsletter / lifecycle email → Email Marketer skill (drafts in email platform, never sends).
- Campaign performance analysis or keyword research → SEO/Growth skill (analytics MCP read-only).
- PR-tagged ticket or major launch → PR/Brand skill (drafts press release, requires explicit sign-off + optional legal review before publishing).

**7. Harness** *(meta-agent — outside the 26-persona framing)* — Six skills:
- Human asks "@<agent> should do X" → `agent-modifier` skill (PR modifying the target agent's files).
- Human asks "create a new agent for Z" → `agent-architect` skill (PR creating full new agent directory + identity + meta-doc updates).
- Human asks "add a skill to <agent> for X" → `skill-author` skill (PR creating new skill file + CLAUDE.md table update).
- Human reports `@<agent> misbehaved on session <id>` → `misbehavior-debugger` skill (reads session deep-trace; root-causes; corrective PR).
- Human asks "the router needs to X" or `agent-modifier`/`skill-author`/`misbehavior-debugger` needs code → `router-engineer` skill (PR modifying `router/src/` + `router/ARCHITECTURE.md`).
- Monthly scheduled cron + `@harness-agent survey gaps` → `gap-analyzer` skill (Slack digest for human triage; never auto-PRs).

Defining constraint: **every Harness change is PR-only** — never pushes to `main`, never bypasses human review. Triple-layer enforcement: deny list, PreToolUse hook, SessionEnd hook forces `create_pr: true`. Harness is the agentified version of "humans + local Claude Code authoring the harness during bootstrap" — it inherits that role from Phase 2 onward.

---

### Harness's asymmetric scope

The Top 6 each work on the **target project** (the customer-facing product). Their `writeScope` denies `dev-team/**`. Their `deniedPaths` lists explicitly forbid touching agent configs, the router, scheduler, identities, or meta-docs.

Harness is the inverse. Its `writeScope` allows `dev-team/**` and denies everything in target projects. The router's startup validation should enforce that **only Harness** has `dev-team/**` in `writeScope` (drift would mean another agent could mutate the harness, which is structurally forbidden).

This asymmetry is the architectural separation between "the agents' product" (what target projects ship) and "the agent product" (what the dev-team repo defines). Different scopes, different blast radii, different review patterns.

---

### Chicken-and-egg: bootstrapping Harness

Harness depends on the router being deployed. The router is authored by humans + local Claude Code in pre-Phase-1 work. Phase 1 deploys the router empty (no agents wired). Phase 2 brings Strategist + Harness online together — at which point Harness can start taking over the work of authoring + maintaining every subsequent agent.

In other words: **Harness inherits the harness-maintenance role from the humans + local Claude Code that bootstrapped it**. After Phase 2, all harness changes flow through Harness PRs.

---

## Locked decisions

### Strategist Linear scope — tiered

| Action | Always allowed | Gated (human slash command) | Forbidden |
|---|---|---|---|
| Create ticket | ✅ | | |
| Comment on ticket | ✅ | | |
| Add label | ✅ | | |
| Move status (To Do → In Progress → Review → Done) | | ✅ `@strategist-agent move ENG-1234 to Review` | |
| Reassign | | ✅ | |
| Set due date / sprint | | ✅ | |
| Close | | ✅ | |
| Bulk operations on >5 tickets | | ✅ + explicit confirmation | |
| Delete | | | ❌ |
| Archive | | | ❌ |

Mutation actions require an explicit human command. The gated tier is now *executable*: in a human-command session (an explicit @-mention), Strategist's Linear MCP exposes `move_issue` / `set_milestone` / `assign_issue` / `set_due_date` / `close_issue`, so it applies the change directly. In an autonomous/scheduled session those tools are withheld entirely (enforced at the tool surface — see `router/src/linear/linearMcp.ts` + `sdkCall.ts` `linearGatedAllowed`), so Strategist there still *proposes* the mutation (e.g. "I'd move this to In Review — `@strategist-agent move ENG-1234 to Review` to confirm") rather than executing. Delete + archive have no tool at all.

### Guardian auto-trigger — three-tier path scan

| Tier | Path patterns | Scan depth | Comment posted |
|---|---|---|---|
| **Skip** | `docs/**`, `*.md`, `CODEOWNERS`, license-only changes | None | None |
| **Light** | All other code paths | Quick QA coverage, dep-CVE quick scan, secret leak, design-system compliance (if UI files touched) | Only if findings |
| **Deep** | `server/services/user/**`, `auth*`, anything touching secrets, payments, migrations (`**/migrations/**`), `.github/workflows/**`, `Dockerfile*`, `*.env*`, files matching `**/payment/**` | Full QA + threat-model diff + auth/authz review + perf check + compliance check | **Always** posts a comment (even "all clear") so reviewers know it ran |

Tier classification lives in `agents/guardian/sensitive-paths.yml` — reviewable, editable.

### Mobile-merge — confirmed (React Native)

Mobile is a Builder-Client skill. Promote out only if mobile-only PR throughput sustains >30% of Builder-Client volume for two consecutive months.

### Designer — absorbed, no dedicated agent

Visual production goes to Claude Design (human-driven, claude.ai/design). The three automatable Designer responsibilities are skills inside Strategist (pre-fill), Builder-Client (pre-fill + authoring + handoff consumption), and Guardian (PR review + drift detection). No `@designer-agent` identity is created.

### Marketer publishing scope — tiered

| Action | Always allowed | Gated (human approval in tool) | Forbidden |
|---|---|---|---|
| Draft blog post / newsletter / social post / press release | ✅ | | |
| Save draft to CMS / email platform / social scheduler / brand-docs repo | ✅ | | |
| Run SEO keyword research / competitive analysis / funnel reports | ✅ | | |
| Read analytics via MCP (GA4 / Mixpanel / PostHog) | ✅ | | |
| Publish blog post | | ✅ — human clicks publish in CMS | |
| Send email blast / schedule lifecycle email send | | ✅ — human clicks send in email tool | |
| Post to social media | | ✅ — human approves in scheduler (Buffer / Hootsuite) | |
| Public statements about partnerships / customers | | ✅ — requires legal review | |
| Paid ad spend | | | ❌ (require human + finance sign-off; bot drafts only) |
| Reply to inbound social DMs / mentions in real time | | ✅ — bot drafts, human posts | |

Drafting is always allowed; publishing is always human-gated. The bot writes; humans push the button.

### State storage — separate repo

State lives in `dev-team-state`, distinct from `dev-team` (config). The router clones both on the VPS at boot. Config repo requires human PR review; state repo accepts bot-direct commits (per each agent's SessionEnd hooks).

> **⚠️ Followup — state durability (format is settled; this is only about the off-box copy).** The *format* is decided and not up for revisit: state is markdown files in a git repo (`global/<agent>/`, `projects/<proj>/<agent>/`, `_shared/`). That model is load-bearing — path-based `load`/`conditional_load` hooks, cross-agent readability, human-readable diffs, agents `Read`/`Write`-ing their own memory directly. (SQLite was considered and rejected: it breaks all four of those.) The only open question is **durability**: today the repo is local-only on the VPS volume, so a volume wipe loses everything since boot. Options:
> - **A — push to origin (in progress).** SessionEnd `git_commit` pushes to the `dev-team-state` remote, conflict-safe (fetch→rebase→retry, best-effort on top of the durable local commit). Gives off-box backup + GitHub-visible history for free. Cost: a write deploy key + `GIT_SSH_COMMAND` mounted into the router. Implemented in `git_commit.ts` (`pushToOrigin`), gated per-hook by `"push": true`; being rolled out agent-by-agent starting with strategist.
> - **B — off-box volume backup, no push.** Periodic `restic`/`rsync`/volume-snapshot of `/var/lib/agents/dev-team-state` to object storage. Keeps state fully private (never touches GitHub); no per-repo credential. Cost: a backup cron + restore runbook, and no browseable history.
> - **C — accept local-only.** Cheapest; correct only if losing all state on a volume wipe is tolerable. Not recommended once the fleet accumulates real founding/PRD state.
>
> A is the default path (backup + auditability, minimal new infra). Revisit B if state must never leave the box. See `router/src/hooks/commands/git_commit.ts` (`pushToOrigin`) and the deploy-key/`GIT_SSH_COMMAND` setup in `deploy/docker-compose.yml`.

---

## Multi-project planning

*Not active at launch — agents start on the single greenfield `<target-project>` only. This section captures the design decisions for when the team eventually adds a second project.*

When agents work on >1 project simultaneously:

### Bot identity is shared across projects

One GitHub App per persona — installed on every project that opts in. Each install gets its own installation token; the router selects the right token per webhook by looking up the identity file. Same for Linear (one agent per persona, can be active in multiple Linear teams) and Slack (one app per persona, joined to multiple workspaces or channels).

Marketer is the one persona that often *doesn't* scope per-project — the brand is unified across projects. We keep its bot identity shared, with project-scoped overrides for editorial calendar and active campaigns.

This is the core advantage of the self-hosted-router path over a GitHub-Action path: adding a project really is "install the App + invite the bot," nothing else. No workflow files in the target repo.

### Config repo becomes multi-tenant

`dev-team` is the global default. Each target project can carry an optional `.dev-team.yml` at its root for project-specific overrides:

```yaml
# <your-org>/<some-project>/.dev-team.yml

# Project house-style — the foundational context every agent loads
# at session start. Templates live in dev-team/templates/founding/
# (agent-product blueprints); this path is where the filled-out
# project-specific docs live in THIS target project.
founding:
  path: "founding/"        # relative to the target project root
  # Conventional contents: PRODUCT.md, BRAND.md, STACK.md, optionally COMPLIANCE.md

# API boundary between Builder-Server and Builder-Client.
# See agents/PROTOCOLS.md → API Contract Protocol.
api_contract:
  kind: openapi                          # openapi | graphql | trpc | shared-types
  path: contracts/openapi.yaml
  generated: true
  generate_command: "pnpm gen:openapi"          # server-bot regenerates the contract
  client_codegen_command: "pnpm gen:api-client" # client-bot derives types from it

# Marketing assets — where Builder-Client commits product screenshots for Marketer.
# See agents/PROTOCOLS.md → Product Screenshot Protocol.
marketing_assets:
  screenshots_path: "../marketing/assets/screenshots"   # relative to the target project; can be a sibling repo
  demo_data_seed: "marketing-friendly"                  # seed name for the demo-data seeder
  breakpoints: ["1440x900", "768x1024", "375x812"]      # default capture breakpoints
  capture_dark_mode: true

agents:
  builder-server:
    enabled: true
    extra_system_prompt: |
      This project is a Python/FastAPI service, not NestJS.
      Use pytest for tests. Use alembic for migrations.
    model_override: opus      # use opus for this project's complexity
    spend_cap_monthly_usd: 50
  guardian:
    enabled: true
    sensitive_paths:
      - "src/billing/**"
      - "src/auth/**"
    skills:
      design_system: false   # this project has no UI
  marketer:
    enabled: false            # internal-only project, no marketing
```

The router merges the project override on top of the global persona config when handling each webhook (per [router/ARCHITECTURE.md §2.13 Hot-reload](router/ARCHITECTURE.md#213-hot-reload)). Project-specific guidance is *additive* to the global house-style preamble.

### State repo partitions by project

```
dev-team-state/
├── global/                          # cross-project knowledge
│   ├── strategist/                  # roadmap-wide decisions, accumulated research
│   ├── builder-client/              # design-system decisions shared across projects
│   ├── marketer/                    # brand voice, editorial calendar, testimonial library
│   └── shared-adrs/                 # cross-project architecture decisions
├── projects/
│   ├── <target-project>/            # the first greenfield project
│   │   ├── builder-server/
│   │   ├── guardian/
│   │   └── platform/
│   ├── <target-project>-mobile/     # the mobile repo (if separate)
│   │   └── builder-client/
│   └── <future-project>/            # added later
```

The router's SessionStart hook loads `global/<persona>/` + `projects/<project>/<persona>/`. Personas have a shared knowledge baseline plus project-specific memory.

### Spend caps go hierarchical

- **Global cap per persona** — e.g. Strategist gets $100/mo across all projects combined. Informational at 80%, alert at 100%.
- **Per-project per-persona cap** — defaults to a configurable share of the global cap. Hard stop when hit.
- **Per-job cap** — token ceiling per single session. Hard stop on runaway loops.

Implementation: the `cost_ledger` table in the router's SQLite (per [router/ARCHITECTURE.md §2.6](router/ARCHITECTURE.md#26-state--sqlite-schema) + [§2.7](router/ARCHITECTURE.md#27-cost-cap)), updated after every session, with a pre-flight check that consults the ledger before invoking the Claude SDK. Cross-project aggregation joins on `agent` across all `project` partitions in the ledger.

### API rate limits

Anthropic API rate limits are per-key. At >3 projects with sustained traffic:

- **Default**: shared key in an Anthropic organization workspace, pooled rate limit.
- **If rate limits become a real problem**: separate API key per project (also helps cost attribution for finance — projects show up as line items rather than one Anthropic bill).
- Don't preemptively split keys; complexity isn't worth it until you hit limits.

### VPS sizing

CX32 handles 3–5 concurrent sessions comfortably. At >5 concurrent across projects:

- **Vertical first**: upgrade to CX42 (8 vCPU / 16 GB, ~€13.60/mo) or CCX32 (8 dedicated vCPU). Buys you another ~2× capacity for ~2× the price.
- **Horizontal second** (only if vertical caps out): shard the router by project group — one instance handles projects A-B, another handles C-D, share a single Cloudflare Tunnel via Cloudflare Load Balancer. Requires migrating SQLite state to Postgres (see [router/ARCHITECTURE.md §3.5 Future extensions](router/ARCHITECTURE.md#35-future-extensions)).
- Most teams will never need horizontal sharding.

### Trigger surface scoping

- **Linear teams** map to projects. The router reads the team context from the Linear webhook to scope which project's config to load.
- **Slack channels** can be per-project (e.g. `#agents-core`, `#agents-mobile`). The router uses channel context to scope. `#marketing` is typically cross-project.
- **GitHub** is naturally scoped — the webhook carries the repo, the router uses the repo's `.dev-team.yml` to scope.

### Failure isolation

A misconfigured `.dev-team.yml` in project X must not break agents for project Y. The router parses each project's config independently; a parse failure disables agents for that project only and posts a single alert to `#agents-alerts`.

---

## Open follow-ups

The target project is greenfield (see [PLAN.md](PLAN.md) → Target project). These follow-ups reflect that — most are decisions to make *during* Phase 0 / Phase 1, not infrastructure assumptions to verify.

### Founding decisions (Phase 0)

1. **Target project working title + GitHub org** — pick the name and where it lives (existing personal, new org, or under an existing org). Determines `<target-project>` everywhere and the bot GitHub Apps' install location.
2. **Tech stack** — drafted by a temporary architect-style Claude Code session in Phase 0; human picks. Becomes part of the house-style base prompt that all Builder agents inherit. (None of the stack-specific path references in this doc — `server/`, `client/`, `acme/mobile`, etc. — apply until this is decided; they're shown as examples.)
3. **Brand voice + project narrative** — drafted by a temporary marketer-style Claude Code session in Phase 0. Three voice options, human picks one. Becomes the Marketer's foundation.
4. **Mobile**: is mobile in scope at all? If yes, RN or native? (Drives whether Builder-Client's mobile skill is enabled at launch.)

### Infrastructure decisions (Phase 1)

5. **Anthropic billing** — pay-as-you-go API key vs. an Anthropic API console workspace with monthly invoice. Latter is friendlier for finance once we have >1 project.
6. **GitHub App ownership** — under the same org that owns `<target-project>`, or under a separate "agents" org for clean separation? Mild preference for separate, since the agents could one day work on multiple projects.
7. **Slack identity** — one app with in-message persona selection, or one app per persona? **Locked**: one per persona for identity parity (six apps).
8. **VPS region** — Ashburn (default, low latency to Anthropic API + GitHub) or Frankfurt.
9. **Claude Design seat** — at minimum one human seat on Pro / Max / Team / Enterprise to access claude.ai/design for product UX work. Decide who.

### Marketer-specific decisions (Phase 6, but worth thinking about early)

10. **Marketing toolbelt — picked, not inventoried**. There's no existing CMS / email / social / analytics stack to inherit. Pick:
    - **CMS / blog host**: MDX in `<target-project>` git (cheapest, dev-friendly) / Ghost / Webflow / WordPress / Notion-as-CMS / other.
    - **Email platform**: Customer.io / Mailchimp / Brevo / Loops / Resend / other. Free tiers exist for all; pick based on lifecycle complexity needed.
    - **Social scheduler**: Buffer / Hootsuite / Typefully / native APIs / "drafts queue in a Linear project" if traffic is low.
    - **Analytics**: PostHog (recommend — open source + free tier covers small projects) / GA4 / Mixpanel / Plausible.
    - Marketer's first real job in Phase 6 is helping evaluate + pick these via a Researcher-style brief, then scaffolding the chosen ones.
11. **Brand-asset host** — where do logos, hero images, social cards live? `<target-project>/assets/` (git LFS), a CDN bucket, Cloudinary, or Figma/Canva exports referenced by URL. Determines where Marketer's visual briefs point humans to put outputs.
