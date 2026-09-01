# Cost Analysis — Agent Fleet at 1 Feature/Day

> **Status**: Initial estimate, pre-deployment. Refine with actuals after 30/60/90 days of operation.
> **Modeled on**: 2026-06-04
> **Pricing baseline**: Sonnet 5 ($2/MTok input, $10/MTok output; cache write 1.25×, cache read 0.1× of input), extended thinking = output tokens. Subject to vendor pricing changes.
> **Caps in effect**: See [agents/*/settings.json](agents/) → `costCap` blocks.

> ⚠️ **The dollar figures below have NOT been recomputed against that baseline.** They were derived from "Sonnet 4.7, ~$3/MTok input, ~$15/MTok output" — a model name that does not exist, quoting Sonnet 4.6's prices. Every derived figure therefore runs ~50% high on rates alone, before the assumption errors in "Measured actuals" below. Treat them as unrevised until this note is removed.

## Scenario modeled

- **Cadence**: 1 targeted feature per day × 5 days/week × 4 weeks = **20 features/month**
- **Feature mix**: 60% full-stack (backend + frontend), 40% single-side (one or the other)
- **Cadence includes**: Phase 0 bootstrap (one-time, Month 1) + ongoing feature work + continuous scheduled tasks

This document was produced as a planning artifact before deployment. **Actuals will diverge.** The structure below is designed to be revisable as real data arrives — see "Revising this analysis" at the bottom.

---

## Assumptions

These are the levers most likely to shift the estimate. Validate each as data comes in.

| Assumption | Value | Source / Confidence |
|---|---|---|
| Anthropic Sonnet 5 pricing | $2/MTok input, $10/MTok output | Vendor-public, subject to change |
| Extended thinking counts as output | Yes | Anthropic docs |
| Typical coding session token usage | ~150K input + 15K output | Speculative; **could be 2× off** |
| Prompt cache hit rate on always-loaded context | ~50% | Conservative; **could go to 80–90% with config** |
| Sessions per feature (full-stack) | ~10–14 across all agents | Spec-derived; matches the 8-phase dev cycle pattern |
| Sessions per feature (single-side) | ~5–7 | Spec-derived |
| % of features with API boundary | ~70% | Project-shape dependent |
| % of features triggering Marketer | ~20% (launch-worthy only) | Tunable per project taste |
| % of features needing a new ADR | ~20% | Falls off after early architecture is set |
| Working days/month | 20 | Standard |
| AI features in scope | Variable — see "Variance drivers" | Project-dependent |

## Measured actuals

First real data. Session 277 — Builder-Server `backend`, IRS-46, the first ticket the
fleet took from Linear label to merged-ready PR unattended (11 files, +1034/−105, 123
turns, completed rather than truncated).

| Metric | Modeled above | Measured (session 277) |
|---|---|---|
| Input tokens (uncached) | ~150K | 16,595 |
| Output tokens | ~15K | 932 — **see caveat** |
| Cache write tokens | not modeled separately | 373,683 |
| Cache read tokens | not modeled separately | 21,282,751 |
| Cache hit rate | ~50% | ~98% |
| Cost, one full feature, one agent | $1–3/session | **$5.23** |

Three things this changes about the model above:

1. **Cache reads are the bill.** 21.3M cache-read tokens are 81% of the session's cost —
   ~173K of context re-read on each of 123 turns. The model above treats cache as a
   discount on input; at this turn count it is the dominant line item, and turn count and
   context size matter far more than the per-token rate or the model tier.
2. **One ticket ≈ one agent's whole per-job budget**, not the $1–3 per session assumed.
   The per-feature tables below sum many sessions at $1–3 each; the one measured session
   cost $5.23 on its own.
3. **The output-token figure is not trustworthy.** 932 output tokens cannot produce 1,034
   lines of code — the router is undercounting somewhere in its per-turn accounting. It
   barely moves the total (even 50K output is $0.50 on Sonnet 5, next to $4.26 of cache
   reads), but it is a real accounting bug and this row should not be quoted until fixed.

---

## Per-feature cost breakdown

For a single feature flowing through the agent fleet:

| Phase | Agent / skill | Sessions | Cost range |
|---|---|---|---|
| PRD drafting | Strategist `pm` | 1–2 | $1–2 |
| Contract design (if API boundary) | Builder-Server `contract-design` + Platform / Builder-Client reviews | 2–3 | $1–3 |
| Backend implementation | Builder-Server `backend` (Phases 2–6 of dev cycle) | 3–5 | $5–10 |
| Frontend implementation | Builder-Client `frontend` (Phases 2–6, incl. visual verification) | 3–5 | $5–10 |
| Guardian PR review | Auto-fires on each PR (server + client = ~2 PRs/feature) | 2 | $1–4 |
| PR feedback iterations | Builders' `pr-feedback` skill (CI failures, comments) | 1–3 | $1–3 |
| Architectural decision (1 in 5 features) | Platform `architect` | amortized | $0.40 avg |
| Marketing campaign (1 in 5 features) | Marketer `campaign-lead` + content skills | amortized | $1–2 avg |

### Blended per-feature averages

| Feature shape | Cost |
|---|---|
| Small / single-side feature | ~$10 |
| Medium full-stack feature | ~$18 |
| Large feature (heavy iteration, multi-PR) | ~$30 |

**Blended average across the 60/40 full-stack/single-side mix: ~$18/feature**

20 features × $18 = **~$360/month for feature work**

---

## Continuous monthly costs (independent of feature volume)

Scheduled work that runs whether or not features are shipping that day:

### Strategist scheduled jobs

| Task | Skill | Frequency | Monthly |
|---|---|---|---|
| Daily standup summary | `pjm` (Haiku) | 20×/mo | $2 |
| Triage (incoming bugs/requests) | `triage` | 20×/mo | $10 |
| Weekly drift check | `curator` (Haiku) | 4×/mo | $1 |
| Weekly product-marketing sync | `curator` | 4×/mo | $1 |
| **Strategist continuous subtotal** | | | **~$14/mo** |

### Platform scheduled jobs

| Task | Skill | Frequency | Monthly |
|---|---|---|---|
| Daily FinOps quick check | `finops` (Haiku) | 20×/mo | $2 |
| Weekly FinOps detailed report | `finops` | 4×/mo | $2 |
| Weekly release cadence | `release-manager` (Haiku) | 4×/mo | $2 |
| **Platform continuous subtotal** | | | **~$6/mo** |

### Guardian scheduled jobs

| Task | Skill | Frequency | Monthly |
|---|---|---|---|
| Weekly dependency audit | `security` | 4×/mo | $4 |
| Monthly compliance audit | `compliance` | 1×/mo | $1 |
| Monthly perf baseline review | `performance` | 1×/mo | $1 |
| **Weekly LLM-security eval suite** (if AI features) | `llm-security` | 4×/mo | **$20–40** |
| **Guardian continuous subtotal (no AI)** | | | **~$6/mo** |
| **Guardian continuous subtotal (with AI)** | | | **~$26–46/mo** |

### Marketer scheduled jobs

| Task | Skill | Frequency | Monthly |
|---|---|---|---|
| Social cadence (2×/week drafts) | `social-community` (Haiku) | 8×/mo | $4 |
| Weekly competitor quick scan | `benchmarking` | 4×/mo | $4 |
| Monthly competitor deep refresh | `benchmarking` | 1×/mo | $3 |
| Weekly performance reports | `growth-analyst` | 4×/mo | $2 |
| **Marketer continuous subtotal** | | | **~$13/mo** |

### Harness scheduled jobs (meta — infrastructure category)

| Task | Skill | Frequency | Monthly |
|---|---|---|---|
| Monthly gap-analyzer survey | `gap-analyzer` | 1×/mo | $3–5 |
| **Harness continuous subtotal** | | | **~$3–5/mo** |

Harness's continuous spend is digest-only (no auto-PRs); the bulk of Harness's cost is reactive (humans asking for changes), which scales with how much the harness is being iterated rather than appearing as continuous spend.

### Continuous totals

| Variant | Total |
|---|---|
| **Without AI features in product** | **~$43–45/mo continuous** |
| **With AI features in product** | **~$63–85/mo continuous** |

---

## Infrastructure (fixed)

| Item | Monthly |
|---|---|
| Hetzner CX32 (Ashburn) | $7 |
| Cloudflare Tunnel | $0 |
| Optional Hetzner snapshots / backups | $1 |
| Anthropic API workspace | $0 (usage-priced) |
| Linear / Slack / GitHub | Existing (assumed) |
| **Infrastructure total** | **$8/mo** |

---

## Bootstrap (Month 1, one-time)

| Phase | Activity | Cost range |
|---|---|---|
| Phase 0 | Founding docs (Strategist `founding`, multi-session, interactive) | $10–20 |
| Phase 1 | Infrastructure setup (mostly human work) | $0 |
| Phase 3 | System design (Platform `system-design`, multi-session) | $10–25 |
| Phase 3 | Repo scaffolding (Builder-Server first run) | $5–15 |
| Phase 6 | Marketing infrastructure inventory + setup | $3–5 |
| **Bootstrap total (Month 1 only)** | | **$30–65 one-time** |

Use the midpoint **$50** as a reasonable point estimate.

---

## Monthly totals

### Month 1 (bootstrap + first month of features)

| Bucket | Amount |
|---|---|
| Bootstrap (one-time) | ~$50 |
| Feature work (20 features) | ~$360 |
| Continuous (no AI) | ~$40 |
| Continuous (with AI) | ~$70 |
| Infrastructure | $8 |
| **Month 1 total — no AI** | **~$458** |
| **Month 1 total — with AI** | **~$488** |

### Months 2+ (steady state)

| Bucket | Amount |
|---|---|
| Feature work (20 features) | ~$360 |
| Continuous (no AI) | ~$40 |
| Continuous (with AI) | ~$70 |
| Infrastructure | $8 |
| **Steady state monthly — no AI** | **~$408** |
| **Steady state monthly — with AI** | **~$438** |

### Annual projection (Months 2–13, after bootstrap recovered)

| Variant | Annual |
|---|---|
| Without AI features | ~$4,900 |
| With AI features | ~$5,300 |

Add Month 1 bootstrap (~$50) for Year 1 only.

---

## Realistic ranges

The point estimate above sits in a wider band. Use the optimistic / pessimistic columns for budgeting.

| Scenario | Per-feature avg | Monthly steady-state | Annual |
|---|---|---|---|
| **Optimistic** — mostly small features, low rework, 80%+ cache hit rate | $12 | ~$280 | ~$3,400 |
| **Realistic** — typical mix at the stated cadence, some PR iteration | $18 | **~$408** | **~$4,900** |
| **Pessimistic** — complex features, heavy rework, AI security evals weekly | $25 | ~$590 | ~$7,100 |

---

## Variance drivers (the things that move the bottom line)

Ranked by impact:

1. **Feature complexity distribution.** A single-line CSS tweak costs ~$3. A cross-service refactor with 20 review iterations costs ~$50. The "1 feature/day" abstraction hides huge per-item variance. **Track real per-feature cost** after 30 days to calibrate.

2. **AI features in the product.** Guardian's weekly LLM-security eval is the biggest single continuous expense if AI features exist ($20–40/mo). No AI features → drop that entirely. If AI is the product, this could climb higher.

3. **PR review iteration density.** If reviewers (human or Guardian) push back hard, `pr-feedback` sessions stack. Each round costs $0.50–2. A "10 rounds of feedback" PR is genuinely 5× more expensive than a "merge on first review" PR.

4. **Prompt cache utilization.** The founding docs + SYSTEM.md + ADR index load at every SessionStart. Without caching, that's ~50K input tokens per session at full price. With aggressive caching (90% hit rate), the input cost drops dramatically. **Configure the router's SessionStart hook outputs to use Anthropic prompt-cache breakpoints** (per the Claude Agent SDK's caching API) so the eager-load context block is cached across sessions — meaningful savings.

5. **Marketer launch volume.** Campaigns are expensive ($5–10 each). Launching every feature = much higher Marketer cost. Launching only major releases = baseline cost.

6. **Off-hours throttling.** All four implemented agents currently have `offHoursThrottling: null`. Turning on for Marketer / Strategist scheduled jobs / Guardian audits could save 20–30% on continuous costs.

---

## Cost levers (knobs to turn)

| Lever | How to enable | Savings potential |
|---|---|---|
| Route social posts to Haiku | Already configured | (already counted) |
| Aggressive prompt caching | Mark the SessionStart eager-load context block as cacheable via the Claude Agent SDK's cache-breakpoint API in the router's runtime layer | **30–40% on input tokens fleet-wide** |
| Off-hours throttling | Set `offHoursThrottling` in `costCap` block of relevant agents | **$10–20/mo** |
| Sonnet → Haiku for routine work | Some Strategist skills (`pjm`, `curator`, trivial `triage`) could use Haiku | $5–15/mo |
| Skip Marketer for minor features | Already implicit (only launch-worthy features trigger campaign-lead) | n/a |
| Reduce `max_turns` cap | Forces shorter sessions; fewer runaway loops | Bounded by 3-attempt rule already |
| Tighten Builder retry policy | Reduce CI-flake retry attempts | $2–5/mo |
| Disable Guardian weekly LLM-security eval if no AI features | Just turn off the cron | $20–40/mo |
| Disable Marketer benchmarking if pre-product-market-fit | Just turn off the cron | $5–10/mo |

---

## Hard ceiling from `costCap` config

The fleet-wide hard ceiling, set by the `costCap` blocks in each `settings.json`:

| Agent | Monthly cap | Category | Status |
|---|---|---|---|
| Strategist | $60 | Per-feature (product) | ✅ Configured |
| Platform | $80 | Per-feature (product) | ✅ Configured |
| Builder-Server | $150 | Per-feature (product) | ✅ Configured |
| Builder-Client | $150 | Per-feature (product) | ✅ Configured |
| Guardian | $100 | Per-feature (product) | ✅ Configured |
| Marketer | $200 | Per-feature (product) | ✅ Configured |
| **Subtotal — product-facing agents** | **$740** | | |
| Harness | $100 | **Infrastructure** (meta) | ✅ Configured |
| **Subtotal — meta-agent** | **$100** | | |
| **Total monthly cap** | **~$840** | | |

Even worst-case operation, **the router refuses new sessions when caps are hit** (cost-cap pre-flight per [router/ARCHITECTURE.md §2.7](router/ARCHITECTURE.md#27-cost-cap)). Spend can't blow past ~$840/mo without a human deliberately raising a cap in `settings.json`. This is the structural ceiling regardless of model accuracy.

### Why Harness is "infrastructure" not "per-feature"

The Top 6 agents' spend tracks with target-project work — features shipped per month drives Strategist/Builder-Server/Builder-Client/Guardian/Marketer activity. Harness's spend tracks with harness-evolution work — how often we modify agents, debug misbehaviors, evolve the router. Different cost driver, different cap discipline:

- **Per-feature caps** scale with product velocity. A high-output target project month justifies raising the per-feature caps.
- **Harness's cap** scales with **how much the harness changes**. Steady-state (no major agent additions, no misbehavior bursts): Harness spend should be low ($30-50/mo). Bursty (a new agent being authored + several misbehaviors investigated): Harness spend can hit the cap.

If you're hitting Harness's cap regularly, that's a signal the harness is being heavily iterated — either intentional (early project, lots of refinement) or a tell that something deeper is unstable (recurring misbehaviors). Worth investigating which.

---

## Comparison baselines

For context — what this spend is buying:

| Reference | Cost |
|---|---|
| Junior engineer (US, monthly salary) | $8,000–10,000 |
| Senior engineer (US, monthly salary) | $15,000–20,000 |
| **Agent fleet at 1 feature/day** | **~$408–438/mo** |
| GitHub Copilot Business (per seat × ~3 seats) | $57/mo |
| Cursor Pro (per seat × ~3 seats) | $60/mo |
| Devin (autonomous engineer subscription) | $500+/mo for one |

The agent fleet replaces 0% of human judgment but accelerates a meaningful fraction of the implementation work. The right comparison is: how much engineering time does this fleet save per month? If even 5 hours of engineer time is saved per month at $100/hour, it pays for itself.

---

## Uncertainty acknowledgment

Things I'm explicitly uncertain about:

- **Real per-session token counts** vary widely. My averages assume ~150K input + 15K output per coding session. Could be 2× off in either direction.
- **Prompt cache hit rate** — the 50% assumption is conservative. With well-configured caching, savings could be 30–40% more than modeled.
- **Iteration density** — if your team prefers shorter PRs and lighter reviews, costs drop. If lots of architectural debate, costs rise.
- **Guardian's LLM-security eval cost** — depends entirely on how many AI features you ship and how often the eval suite runs. Could be $0 (no AI) or $40+/mo (heavy AI product).
- **Bootstrap time** — Phase 0 founding discussions could be 2 hours of human + agent time, or 2 days. The Strategist `founding` skill is designed to be multi-session so this scales reasonably either way.
- **Pricing changes** — Anthropic pricing has dropped over time historically. The estimate uses today's rates; future rates could be lower (or higher).

---

## Revising this analysis

This document is a **starting estimate**. The system has explicit mechanisms for collecting real data:

### What feeds this analysis with actuals

| Source | What it tells you |
|---|---|
| Platform `finops` skill — weekly report | Actual spend by agent, anomalies, top-spending sessions |
| Platform `finops` skill — `cap-utilization.md` ledger | Per-agent MTD spend vs. cap |
| Router's per-session telemetry (SQLite `sessions` table + `cost_ledger`; exposed via `dev-team-logs` CLI) | Token counts per session, cost per session, session duration |
| `dev-team-state/projects/<project>/builder-*/closed-prs/` | Per-PR session history → cost-per-feature derivation |
| Guardian's weekly eval reports | LLM-security eval token cost (the biggest single line item if AI features exist) |

### When to revise this doc

- **After 30 days of operation**: replace per-feature averages with actuals from the FinOps weekly reports
- **After Anthropic pricing change**: re-run the model with new $/MTok numbers
- **After a major architecture shift** (e.g. monolith → microservices, or adding a new agent): re-estimate scheduled/continuous costs
- **Quarterly**: review variance drivers; tune `costCap` blocks based on actuals

### Revision log

Add new rows here as the analysis is revised:

| Date | Revised by | What changed | New steady-state estimate |
|---|---|---|---|
| 2026-06-04 | initial | First model, pre-deployment | $408–438/mo |
| | | | |
| | | | |

### Tracking actuals vs. predicted

After 30 days, fill in:

| Month | Predicted (no AI / with AI) | Actual | Delta | Notes |
|---|---|---|---|---|
| Month 1 | $458 / $488 | TBD | TBD | Includes one-time bootstrap |
| Month 2 | $408 / $438 | TBD | TBD | First steady-state month |
| Month 3 | $408 / $438 | TBD | TBD | |
| Q1 total | $1,274 / $1,364 | TBD | TBD | |

---

## Bottom line

| Question | Answer |
|---|---|
| **Month 1 (with bootstrap)** | ~$460–490 |
| **Monthly steady state (Months 2+)** | **~$408–438** |
| **Annual (Year 1)** | ~$5,000–5,400 |
| **Annual (Year 2+, no bootstrap)** | ~$4,900–5,300 |
| **Hard ceiling from `costCap` config** | $620/mo |

Plan for **~$450/mo for the first 90 days**, then reset estimates based on FinOps reports. The fleet's actual numbers will be available within Month 1.
