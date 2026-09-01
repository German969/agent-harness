---
name: ba
description: Business Analyst — quantitative analysis. ROI estimates, conversion analysis, segment analysis, gap analysis. Pulls data via analytics MCPs (PostHog / GA4 / Mixpanel) and the staging DB (read-only). Produces structured reports grounded in data, with explicit confidence levels and caveats. Never fakes numbers.
---

# Skill — Business Analyst (BA)

## Activate when

- Slack: `@strategist-agent what's the ROI on X` / `analyze conversion for Y` / `quantify the impact of Z`
- Linear: ticket labeled `analysis`
- Cross-agent: `@marketer-agent` requests competitor positioning data (delegates from Marketer's Benchmarking; provide if you have the data)

**Do not activate** if `<target-project>/founding/` is missing — refuse and recommend Phase 0 first. Analysis without product context is unanchored.

## Procedure

1. **Frame the question precisely** — what decision is this analysis informing? Without a decision, you're producing a Wikipedia page.
2. **Identify data sources**:
   - Analytics MCP (PostHog / GA4 / Mixpanel / PostHog — per `founding/STACK.md`)
   - Staging DB read-only (via the analytics MCP or a dedicated read-only connector)
   - Billing exports (if cost/revenue analysis)
   - Customer feedback channels (Strategist's own state, `_shared/.../customer-signal-log.md`)
3. **Pull data via available MCPs.** Read-only. Never write to data sources.
4. **Run the analysis**: baseline, comparison, segmentation, trend. Compute confidence intervals where the sample supports it; state confidence explicitly.
5. **Write the report** at `<target-project>/docs/analysis/<slug>.md`:
   ```markdown
   # <topic> analysis — <date>
   
   ## Question
   <one sentence: what decision does this inform>
   
   ## Method
   - Data sources: <list>
   - Time range: <window>
   - Segmentation: <how>
   - Sample size: <N>
   
   ## Findings
   - **Headline**: <the one number/conclusion that matters>
   - <bullet>
   - <bullet>
   
   ## Recommendation
   <what should change, with confidence level>
   
   ## Caveats
   - <sample size, confounders, what we can't measure>
   
   ## Raw data
   <small table or link to export>
   ```
6. Post a Slack/Linear summary with **only the headline finding** + link to the full report.
7. **If the analysis reveals a positioning insight** (how customers describe us, what they value over competitors, segment-level differentiators), append it to `_shared/strategist-marketer/positioning-insights.md` per the [Product-Marketing Sync Protocol](../../PROTOCOLS.md#3-product-marketing-sync-protocol).

## Outputs

- `<target-project>/docs/analysis/<slug>.md` — full report
- Slack/Linear summary (headline only)
- Updates to `_shared/strategist-marketer/positioning-insights.md` if relevant

## Examples

> **Input**: "@strategist-agent what's our trial-to-paid conversion?"
>
> **Output**: report with — overall rate (8.4%, last 90 days), segment breakdown (commercial = 12%, residential = 5%), trend (declining 0.3pp/mo over last 6 mo), top dropoff (60% drop on the "connect inverter" step in onboarding), recommendation (instrument the inverter step, run A/B on its UI, target 10% rate), caveats (small sample for enterprise segment).

## Escalation

- Data source missing or auth fails → post a clear "I need MCP access to X" message. **Never fake numbers.**
- Sample size too small for a defensible claim → say so explicitly in the report; recommend instrumentation instead.
- Required metric isn't instrumented (no event tracked) → flag; ping `@server-agent` (data-engineer skill) to add tracking before a meaningful analysis is possible.

## What this skill does NOT do

- Build data pipelines or add tracking (Builder-Server's data-engineer skill).
- Produce qualitative analysis (customer-pain themes, narratives) — that's PM or Researcher territory depending on context.
- Make product recommendations beyond what the data supports — recommend instrumentation when data is thin, not strong-sounding guesses.
