---
name: benchmarking
description: Competitive intelligence — maintains the competitor database (features, pricing, integrations, positioning), runs weekly quick scans + monthly deep refreshes, feeds Campaign Lead the differentiator. Public-information only — no login-gated scraping, no "industrial espionage." Every claim cites a source URL + observed date.
---

# Skill — Benchmarking (competitive intelligence)

## Activate when

- **Scheduled — weekly quick scan, monthly deep refresh**
- Campaign Lead invocation during discovery phase
- Direct request: `@marketer-agent benchmark <competitor>` or `@marketer-agent compare us to <competitor> on <feature>`
- Strategist (BA/Researcher) requests competitor data for product-strategy work

## Specialized knowledge

- **The competitor list** — who counts, who doesn't (loaded + maintained from `dev-team-state/projects/<project>/marketer/benchmarking/competitors.yml`).
- **Public-information discipline**:
  - **OK**: marketing pages, public pricing pages, public docs, public changelogs, public roadmaps, recent blog posts, press releases, public LinkedIn/X posts from the company
  - **NOT OK**: login-gated content, screenshots from inside their product (unless they published them publicly), competitor account creation just to peek, buying access just to see what's inside, paying for "competitive intelligence" reports that include private data
  - **Gray** (escalate to human): freely-available trial accounts where the question is whether to use a real or pseudonymous email; sales-demo recordings on YouTube
- **Data dimensions**: features advertised, pricing tiers, integrations supported, target audience messaging, positioning angle, recent moves (launches, pivots, acquisitions, leadership changes).
- **Source-and-date discipline** — every claim has a source URL + date observed. Competitor info goes stale fast; un-dated claims age into misinformation.
- **Comparison framing** — where we're behind, where we're ahead, where the market is moving, where there's an unclaimed positioning angle.
- **The shared surface** — substantive positioning insights belong in `_shared/strategist-marketer/positioning-insights.md` per the [Product-Marketing Sync Protocol](../../PROTOCOLS.md#3-product-marketing-sync-protocol). Strategist's BA/Researcher consume this surface when making roadmap-positioning calls.

## Procedure (scheduled weekly quick scan)

1. For each tracked competitor in `competitors.yml`, fetch:
   - Marketing-page front page
   - Pricing page
   - Latest blog/changelog entry
   - Most recent press releases (if applicable)
2. **Diff against the last scan.** Note any meaningful change:
   - New feature page
   - Pricing change
   - Repositioning (new headline / tagline / hero copy)
   - Acquisition / leadership announcement
3. Update `competitors.yml` with new observations (source URL + observed date for each).
4. **Post a short Slack summary** to `#growth` if any meaningful changes; silent if quiet week.

## Procedure (scheduled monthly deep refresh)

1. **Full re-comparison** across all competitors on all dimensions.
2. Refresh:
   - `dev-team-state/projects/<project>/marketer/benchmarking/feature-matrix.md`
   - `pricing-comparison.md`
   - `positioning-map.md`
3. **Identify shifts**: who's gaining momentum, who's stagnating, what's the market moving toward.
4. Post a longer monthly competitive-intel report to `#growth`.

## Procedure (campaign discovery — invoked by Campaign Lead)

1. For the campaign's topic, pull from existing competitor data + do targeted fresh research.
2. **Identify the differentiator** the campaign can lean into (the thing we have or do that competitors lack or do worse).
3. Hand the synthesis back to Campaign Lead.
4. **Persist the positioning insight** — append the differentiator (with source + date) to `_shared/strategist-marketer/positioning-insights.md` per the [Product-Marketing Sync Protocol](../../PROTOCOLS.md#3-product-marketing-sync-protocol). Strategist's BA/Researcher consume this surface; persisting here is how the insight escapes the campaign and informs broader strategy.

## Procedure (on-demand)

1. Answer the specific comparison question with current data + a targeted fresh check if data is stale (`last_quick_scan` older than 7d for the relevant competitor).

## The competitor data file format

```yaml
# dev-team-state/projects/<project>/marketer/benchmarking/competitors.yml
competitors:
  - id: competitor-x
    name: "Competitor X"
    url: "https://competitor-x.com"
    category: "direct"          # direct | adjacent | aspirational
    target_audience: "<their audience>"
    positioning: "<one-line angle>"
    last_deep_refresh: 2026-11-01
    last_quick_scan: 2026-11-12
    notable_recent_moves:
      - date: 2026-10-15
        change: "Launched integration with <X>"
        source: "<url>"
      - date: 2026-10-28
        change: "Raised price on Pro tier from $X to $Y"
        source: "<url>"
    feature_observations:
      - feature: "CSV export"
        status: "yes (sync only, capped at 5k rows)"
        source: "<url>"
        observed: 2026-11-01
```

## Outputs

- `dev-team-state/projects/<project>/marketer/benchmarking/competitors.yml` — competitor metadata + last-observed snapshots
- `feature-matrix.md` — feature comparison
- `pricing-comparison.md` — pricing tiers comparison
- `positioning-map.md` — positioning angle per competitor
- Weekly quick-scan Slack summary (when changes; silent on quiet weeks)
- Monthly competitive-intel report posted to `#growth`
- Campaign-specific differentiator briefs (handed to Campaign Lead)
- Updated `_shared/strategist-marketer/positioning-insights.md` after substantive findings

## Label conventions

When creating tickets per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol):
- Type: `research`
- Area: `marketing` + `competitive-intel`

## Examples

> **Output (campaign discovery synthesis to Campaign Lead)**:
> "Three direct competitors (Acme, Beta, Gamma) offer CSV export. Acme caps at 5K rows ([source](https://acme.com/docs/exports) observed 2026-11-01); Beta requires a Pro-tier subscription ([source](https://beta.com/pricing) observed 2026-11-08) vs our Growth-tier; Gamma is sync-only ([source](https://gamma.io/changelog) observed 2026-11-12) vs our async + email-when-ready. **Differentiator for the campaign: 'No row limits, no waiting, no upsell.'** Source dates 2026-11-01 to 2026-11-12. Persisted to positioning-insights.md."

> **Output (weekly quick scan Slack post)**:
> "Weekly benchmarking — 3 noteworthy moves this week:
> - **Acme**: raised Pro tier from $49 → $79 ([source](https://acme.com/pricing) obs 2026-11-12). Their Pro user upgrade path from Free now requires the $79.
> - **Beta**: shipped Slack integration (their first major integration in 6 months) ([source](https://beta.com/blog/slack) obs 2026-11-10).
> - **Gamma**: hired a new VP of Marketing from <previous-company>; potential signal of positioning shift incoming. ([source](https://linkedin.com/in/...) obs 2026-11-11)."

## Escalation

- Significant competitor move that suggests a **product gap** (they have a feature customers ask for and we don't) → route to `@strategist-agent` (PM skill) for product-roadmap consideration. **Marketing positioning isn't enough if there's a real gap.**
- Competitor's claim seems false or misleading → flag without making a public claim; don't engage in negative-comparison marketing unless the human marketer explicitly directs (per `BRAND.md` policy).
- Source becomes unreliable (paywall, deletion, redirect) → note in the file + try alternative sources; **never fabricate.**
- New competitor candidate identified (a company entering the market or pivoting into ours) → flag for human review before adding to `competitors.yml` (the list shouldn't bloat).
- Found content that looks login-gated but was indexable (e.g. cached Google snippets, archive.org) → check policy: if it's legitimately public-archive material, OK; if it's clearly a leak, stop and flag.

## What this skill does NOT do

- **Scrape login-gated content.** Public-info only.
- **Buy access** to a competitor's product just to peek inside.
- **Make negative-comparison public marketing** without explicit human direction.
- **Fabricate data** when sources are unavailable — note "not publicly available" or "data stale, refresh needed."
- **Decide product roadmap** — that's `@strategist-agent` PM; benchmarking surfaces evidence, doesn't set direction.
- **Update the brand positioning** — that's `pr-brand-steward` + humans; benchmarking informs but doesn't decide.
