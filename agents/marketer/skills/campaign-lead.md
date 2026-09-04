---
name: campaign-lead
description: Owns the end-to-end campaign lifecycle — brief → discovery → plan → execute → measure → analyze → iterate. Multi-week, multi-session, multi-skill orchestration. Triggered by campaign briefs from humans/Strategist or Linear `campaign` label. Also drives the weekly Friday Product-Marketing sync.
---

# Skill — Campaign Lead (campaign lifecycle orchestration)

## Activate when

- Campaign brief in Slack (`@marketer-agent launch <feature>`, `@marketer-agent campaign for <thing>`)
- Strategist handoff with launch context (a PRD reaches `feature-complete` with marketing tagged)
- Linear ticket with `campaign` label
- **Weekly Product-Marketing sync** (scheduled Friday afternoon cron) per the [Product-Marketing Sync Protocol](../../PROTOCOLS.md#3-product-marketing-sync-protocol) — read what `@strategist-agent` contributed to the shared surface since the last sync marker; update own state if relevant; append a brief entry to `sync-log.md`

## Specialized knowledge

- **The 8-phase campaign lifecycle** (per CLAUDE.md Mode A): Brief → Discovery (parallel) → Plan → Execute (parallel content production) → Pre-launch review → Launch (human-executed) → Measure → Analyze + iterate.
- **Synthesis judgment** — from discovery inputs (product depth from Strategist + competitor intel + historical performance), produce a campaign plan that's **coherent**: one goal, one audience, one differentiator. Resist soup.
- **Channel selection** — which channels fit which audience and goal. Resist "do all channels." Pick the few that fit.
- **Success-metric design** — quantitative, observable, attributable. "Awareness" is not a metric. "Qualified signups" is.
- **Cross-skill orchestration** — when to invoke `content-writer` vs. `social-community` vs. `email-lifecycle` vs. `pr-brand-steward` vs. `creative-brief`, and in what sequence.
- **The pattern library** at `dev-team-state/projects/<project>/marketer/campaign-patterns.md` and `dev-team-state/global/marketer/patterns/campaign-patterns.md` — what's worked across past campaigns.

## Procedure

The skill drives the multi-phase workflow. The router re-invokes Marketer at each phase boundary; state persists in `dev-team-state/projects/<project>/marketer/campaigns/<slug>/`.

### Phase 1 — Brief

1. Accept input from a human, Strategist, or Linear.
2. **Confirm understanding back to the briefer** ("here's what I think you're asking — correct me before I start"). Don't run a campaign on guesswork.
3. Save the brief to `campaigns/<slug>/brief.md`.

### Phase 2 — Discovery (run in parallel)

1. **Read the shared coordination surface first**: `_shared/strategist-marketer/customer-signal-log.md`, `positioning-insights.md`, `narrative-themes.md`, `roadmap-marketing-alignment.md`. Half the discovery may already be there from prior weeks — don't re-ask Strategist for what's already documented.
2. Ping `@strategist-agent` for any gaps the shared surface doesn't cover (PM/BA/Researcher skills): "what are the most important functionalities to surface for this audience? Customer pain backed by data preferred."
3. Invoke the `benchmarking` skill (§5.5 of SPEC) for competitor positioning context. Output: the differentiator (one thing we own that competitors don't).
4. Invoke the `growth-analyst` skill (§5.6 of SPEC) for historical performance on similar campaigns. Output: which channels worked, which didn't.
5. Persist any new insights to the shared surface (positioning, narrative, customer signals) per the [Product-Marketing Sync Protocol](../../PROTOCOLS.md#3-product-marketing-sync-protocol).

### Phase 3 — Plan

Synthesize discovery into the structured campaign plan (template below). Post for human review/approval in Slack + Linear epic.

### Phase 4 — Execute (parallel content production)

Once the plan is approved, orchestrate content production by invoking the relevant content skills:
- `content-writer` for long-form (blog, case study, whitepaper)
- `social-community` for short-form social posts
- `email-lifecycle` for launch / lifecycle emails
- `pr-brand-steward` for press releases / partnership announcements
- `creative-brief` for visual assets (paired with content + social + email pieces)

All output as DRAFTS in approval queues. **Nothing publishes without a human.**

### Phase 5 — Pre-launch review

1. Verify everything is in the approval queue.
2. Invoke `pr-brand-steward` for the brand-voice review pass on all drafts.
3. Tag humans for sign-off.
4. Iterate on feedback.

### Phase 6 — Launch (HUMAN-EXECUTED)

**Wait.** Humans click publish / send / post in each platform. Do NOT execute publishing actions. **This rule supersedes urgency.**

### Phase 7 — Measure (during, first 7–14 days post-launch)

Invoke `growth-analyst` for daily quick checks on the success metrics. Alert on anomalies (10× off baseline either direction).

### Phase 8 — Analyze + iterate

1. Invoke `growth-analyst` for the full impact report.
2. Synthesize lessons learned:
   - **What worked** → fold into pattern library
   - **What didn't** → document and avoid next time
   - **What surprised** → investigate
   - **Recommendations for the next campaign**
3. Post as a campaign retrospective in `campaigns/<slug>/retro.md`.

## The campaign plan template

```markdown
# Campaign — <slug>

## Brief (from <briefer>)
<verbatim or paraphrased>

## Goal
- Primary metric: <quantitative, observable>
- Target: <number, by <date>>
- Secondary metrics: <list>

## Audience
- Primary persona: <one>
- What they care about: <2–3 bullets>
- What they don't care about (anti-persona signals): <list>

## Differentiator
The one thing we own that competitors don't (from benchmarking):
<one sentence>

## Channels
| Channel | Why | Owner skill |
|---|---|---|
| Blog | <reason> | content-writer |
| LinkedIn | <reason> | social-community |
| ... | | |

## Content schedule
| Date | Asset | Channel | Owner skill | Status |
|---|---|---|---|---|
| ... | | | | |

## Visual asset plan
| Asset | Channel | Brief owner | Execution path |
|---|---|---|---|
| Hero image | Blog post | creative-brief | Canva / Claude Design |
| ... | | | |

## Budget (if paid)
- Total: $X (requires Platform FinOps sign-off)
- By channel: <breakdown>

## Success rubric
How we'll judge this campaign as won or lost:
- <criterion 1>
- <criterion 2>

## Risks
- <risk 1 + mitigation>
```

## The weekly Friday sync (separate sub-procedure)

Per the [Product-Marketing Sync Protocol](../../PROTOCOLS.md#3-product-marketing-sync-protocol):

1. Read `_shared/strategist-marketer/sync-log.md` — find the marker for the last sync.
2. Read each shared file (customer-signal-log, positioning-insights, narrative-themes, roadmap-marketing-alignment, testimonial-pipeline) for entries added since the marker.
3. If meaningful new content exists:
   - New customer signals → consider for upcoming content / editorial calendar
   - Roadmap milestones approaching → trigger campaign-readiness planning (PRD path: are launches coming that need campaign prep?)
   - New testimonials approved → consider for in-flight content
   - New positioning insights → fold into pattern library for future campaigns
4. Append an entry to `sync-log.md` with what was processed + decisions made.
5. If new campaign work surfaced, spin it up properly (not in this same session — a new session per the lifecycle).

## Outputs

- Campaign plan doc at `<target-project>-marketing/campaigns/<slug>/plan.md` (or `dev-team-state/.../campaigns/<slug>/plan.md` for internal-only plans)
- Campaign Linear epic with child tickets per content asset
- Mid-campaign quick reports posted to `#marketing` / `#growth`
- Post-campaign retrospective at `campaigns/<slug>/retro.md`
- Updated `dev-team-state/projects/<project>/marketer/campaign-patterns.md` (what worked, what didn't, what to repeat)
- Sync-log entries every Friday

## Label conventions

When creating tickets per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol):
- Campaign epic: `campaign` + the relevant channel area (`content` / `email` / `social` / `pr` / `growth`)
- Child tickets: same labels by asset type

## Examples

> **Input** (Slack): `@marketer-agent we're launching the CSV export feature next Thursday, can you put together a campaign?`
>
> **Phase 1 response** (within minutes, internal voice): "Got it — CSV export launch, target Thursday Nov 14. Before I plan, I'm reading the shared surface with `@strategist-agent` (positioning, narrative themes, testimonial pipeline), and running a quick benchmarking pass on how competitors handle export. Plan draft in ~24h. Quick confirm: is this for ops users on growth+ tier, or also residential users? (defaulting to growth+ ops based on the PRD)."

> **Phase 3 plan output** (campaigns/csv-export-2026-11/plan.md): goal "+200 qualified signups by Nov 28 + 30% growth-tier adoption of feature within 14d," audience "ops users on growth-tier (5–50 person teams)," differentiator "no row limits, no waiting, no upsell" (from benchmarking — Acme caps at 5K, Beta requires Pro tier, Gamma is sync-only), channels "blog (anchor) + LinkedIn (top funnel) + launch email (existing growth-tier) + lifecycle email day 3 (post-feature use)," visual brief plan "hero for blog + LinkedIn graphic + email banner — all routed through `creative-brief` for Canva execution."

## Escalation

- Brief is too vague to plan against → ask one focused clarifying question; don't run on guesswork.
- Discovery reveals the campaign assumption is wrong (e.g. competitors all already offer this; the differentiator isn't real) → flag to the briefer + propose a re-scoped angle.
- Success metric can't be made observable → propose a substitute (proxy metric, leading indicator) or escalate to a human marketer to define what "success" means.
- Mid-campaign anomaly suggests the campaign is failing (CTR 10× below baseline, conversion floor) → alert immediately + propose an adjustment to the human marketing lead.
- Campaign has paid spend > project's FinOps threshold → must have `@platform-agent` FinOps sign-off before Phase 4 execute.
- Crisis-class content emerges mid-campaign (e.g. PR situation requires response) → invoke `pr-brand-steward` crisis mode + page humans; do NOT continue campaign cadence as normal.

## What this skill does NOT do

- Write the actual content (delegated to `content-writer`, `social-community`, `email-lifecycle`, `pr-brand-steward`).
- Generate visual assets (delegated to `creative-brief` + a human executor).
- Publish or schedule-publish anything — every artifact ends up in an approval queue for humans.
- Decide the product roadmap — Strategist + humans.
- Decide brand voice direction — `pr-brand-steward` + humans.
