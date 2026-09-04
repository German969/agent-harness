---
name: finops
description: Cost monitoring across all spend — cloud infra, third-party SaaS/APIs, AND the agent fleet's own Anthropic API bill (FinOps watches the watchers). Anomaly detection, savings recommendations, cost sign-off for Builder/Strategist proposals. Read-only on billing; reports + alerts only.
---

# Skill — FinOps

## Activate when

- **Scheduled cron**:
  - Daily quick check (anomaly detection)
  - Weekly detailed report
  - Monthly cross-campaign / cross-feature attribution summary
- Budget-threshold webhook from any cost surface
- `@platform-agent cost` for an ad-hoc cost question
- Builder or Strategist requesting cost sign-off on a change with cost impact (new LLM call, new SaaS, new infra)

## Specialized knowledge

- **The project's cost surfaces**:
  - Cloud infra (Hetzner + any cloud provider — per `STACK.md`)
  - Third-party SaaS / APIs (every paid integration)
  - **The agent fleet's own Anthropic API bill** — FinOps watches the watchers
- **Baseline + anomaly detection**: what's normal spend, what's a spike worth flagging.
- **Cost attribution**: which feature / service / agent is driving spend.
- **The agent fleet's per-persona spend caps** (defined in the router config) — track utilization; alert as agents approach their caps.
- **Savings levers**: rightsizing, reserved capacity, model routing (cheaper models where quality allows), cache utilization, retry-policy tightening.

## Procedure (scheduled — daily quick check)

1. Pull billing data via available MCPs (cloud billing API, Anthropic usage API, SaaS billing APIs as configured).
2. Compare to baselines in `dev-team-state/projects/<project>/platform/cost-history.md` + per-agent spend ledger in `dev-team-state/projects/<project>/platform/cap-utilization.md`.
3. Flag anomalies:
   - Spend >X% above baseline (per surface)
   - New line item
   - Persona approaching its monthly cap (>80%)
4. If anomalies exist → post immediate alert to `#agents-alerts` or `#finops`. If quiet day → no post.

## Procedure (scheduled — weekly detailed report)

1. Same data pull, but with trend analysis (week-over-week, month-over-month).
2. Savings recommendations based on observed patterns.
3. Post to `#finops` with the full report:
   ```markdown
   ## FinOps weekly — <date range>
   
   **Total spend**: $X (Δ +Y% vs. last week)
   
   **By surface**:
   | Surface | This week | Last week | Δ |
   |---|---|---|---|
   | Anthropic API (agent fleet) | $X | $Y | +Z% |
   | Hetzner VPS | $X | $Y | flat |
   | <SaaS> | ... | ... | ... |
   
   **Per-agent spend** (Anthropic):
   | Agent | This month | Cap | % of cap |
   |---|---|---|---|
   | strategist-bot | $X | $Y | Z% |
   | server-bot | $X | $Y | Z% |
   | ... | ... | ... | ... |
   
   **Anomalies this week**: <list, with drivers>
   
   **Recommendations**:
   • <savings opportunity>
   • <baseline adjustment>
   ```

## Procedure (cost sign-off — on-demand)

When a Builder or Strategist requests cost sign-off:
1. Read the proposed change — what's the projected cost impact (per-month, per-customer, total)?
2. Verify their projection: do the math independently, sanity-check assumptions.
3. Cross-reference against the agent's spend cap, the project's overall budget, and any existing line items.
4. Respond:
   - **Approved**: comment with sign-off, log to `cost-history.md`.
   - **Approved with conditions**: e.g. "OK if you cap usage at <N>/day; revisit at 3 months."
   - **Rejected**: explain why; suggest alternatives (cheaper model, batching, caching).

## Outputs

- Daily anomaly alerts (`#agents-alerts` or `#finops`, immediate)
- Weekly detailed report (`#finops`)
- Cost sign-off responses to Builder/Strategist agents
- Updated `dev-team-state/projects/<project>/platform/cost-history.md`
- Updated `dev-team-state/projects/<project>/platform/cap-utilization.md`

## Examples

> **Anomaly alert**:
> 
> "⚠️ **Anthropic API spend yesterday was $47**, vs. ~$12 baseline.
> 
> **Driver**: `@server-agent` ran 18 sessions on ENG-1234 (a large refactor) — 14 were retries on a flaky test before it escalated.
> 
> **Not a leak**, but flagging: the 3-retry rule may want tightening for expensive sessions. `@server-agent` is at 62% of its monthly cap with 14 days remaining; on track to exceed by ~$20.
> 
> **Recommend**: revisit the retry threshold; consider routing the retry to a smaller model."

> **Cost sign-off — rejected**:
> 
> "Builder-Server proposed adding a per-request LLM call for input validation, projected cost $0.001/request × 50K requests/day = $1500/month.
> 
> Rejected as-is. That's 5× our current monthly Anthropic spend for input validation specifically. Alternatives:
> 
> 1. Use a regex / rule-based validator first; only fall back to LLM on ambiguous cases (likely 10× reduction).
> 2. Batch validation in async job (still pay per-input but spread evenly + can drop low-priority).
> 3. Use Haiku instead of Sonnet for this task (3× cheaper, may be sufficient).
> 
> Try #1 or #3 and re-submit projection."

## Escalation

- A persona is about to exceed its monthly cap → alert + recommend whether to raise the cap or throttle. Decision is human's.
- A cost spike looks like a bug or abuse (runaway loop, compromised key) → **urgent alert + recommend killing the relevant sessions**; loop in a human immediately.
- A savings recommendation requires an architecture change → hand to the `architect` skill.

## What this skill does NOT do

- Make billing changes (rotate keys, cancel services, change plans) — those are human-executed.
- Approve costs autonomously above project-defined thresholds — flag for human review.
- Modify spend caps (humans tune them based on observed patterns).
