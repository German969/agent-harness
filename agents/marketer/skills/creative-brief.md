---
name: creative-brief
description: Visual briefs for marketing assets (hero images, social cards, infographics, decks, banners). Invoked by other skills when an asset needs visuals. Outputs a paste-ready brief for a human to execute in Canva / Figma / Claude Design / Adobe — never generates the asset itself. Pulls product screenshots from the maintained library or requests fresh from @client-agent.
---

# Skill — Creative Brief (visual briefs for marketing assets)

## Activate when

- Other skills invoke this when an asset needs visuals:
  - `content-writer` for blog hero / in-post inline visuals
  - `social-community` for graphic posts
  - `email-lifecycle` for banner / header image
  - `pr-brand-steward` for press-kit assets
  - `campaign-lead` for any asset on the visual-asset plan
- Direct: `@marketer-agent brief <asset-type> for <topic>`

## Specialized knowledge

- **The brand's visual identity** (loaded from `<target-project>/founding/BRAND.md` + brand-assets references):
  - Color palette
  - Typography pairings
  - Logo usage rules
  - Photography vs. illustration style direction
  - What to avoid (e.g. generic stock photo handshakes, padlock clichés, etc.)
- **Channel-specific dimension requirements** (the standard set; project-specific overrides in `brand-voice.md`):
  - Blog hero / OG image: 1200×630
  - LinkedIn: 1200×627 (image post), 1080×1350 (carousel)
  - X: 1600×900
  - Instagram: 1080×1080 (feed), 1080×1350 (portrait), 1080×1920 (story)
  - Email banner: 600×200 (header), 1200×400 (hero)
  - YouTube thumbnail: 1280×720
- **Output destinations** (recommended tool per asset type):
  - **Canva** — fast, template-driven social cards, banners, simple graphics. Default for short-form social + email banners.
  - **Figma** — when the team has a Figma brand kit. Best for assets that compose with other UI elements.
  - **Claude Design** — slides, decks, one-pagers, polished infographics. Strong default for narrative-heavy assets.
  - **Adobe / pro tools** — complex compositions (rare; human-driven).
  - **Product-screenshot library** — when the brief composes around an actual product screen (hero with screenshot inset, feature demo image). Reference the library path or request fresh capture from `@client-agent` per the [Product Screenshot Protocol](../../PROTOCOLS.md#4-product-screenshot-protocol).
- **Brief anatomy** — feature description, brand voice notes, channel-specific requirements, suggested style direction, reference examples (from prior brand assets), success rubric.

## Procedure

1. **Identify the asset type, channel, and topic.** Confirm scope back to the invoking skill if unclear.
2. **Load brand voice + visual identity** from `BRAND.md` + `brand-voice.md`.
3. **Find reference examples** from prior brand assets at `dev-team-state/projects/<project>/marketer/creative-briefs/` and `<target-project>-marketing/assets/` (so the new asset sits in a coherent visual body of work, not a vacuum).
4. **For product-screenshot-based briefs**: check the screenshot library at `<target-project>-marketing/assets/screenshots/library/<surface>/`. If the needed surface/state/breakpoint isn't there, file a request to `@client-agent` (`screenshots` skill) per the [Product Screenshot Protocol](../../PROTOCOLS.md#4-product-screenshot-protocol) — structured: surface / state / mode / breakpoint / purpose / deadline.
5. **Compose the brief** (template below).
6. **Post the brief** to the asset's parent comment thread (Linear ticket, Slack thread on the originating draft) for a human to execute in the recommended tool.
7. **Archive the brief** to `dev-team-state/projects/<project>/marketer/creative-briefs/<slug>.md` for pattern reuse.

## The creative-brief template

```markdown
## Creative brief — <asset-type>

**Topic**: <one sentence>
**Channel**: <where it'll appear>
**Dimensions**: <required spec>
**Deadline**: <date>

### Brand context
- **Voice notes**: <2-3 lines from BRAND.md>
- **Color palette**: <which palette section to draw from — e.g. primary blue + neutral grays>
- **Typography** (if text in the image): <which faces>
- **Style direction**: <minimal / illustrated / photographic / abstract>

### Composition
- **Subject**: <what's depicted>
- **Mood**: <intended feeling>
- **Must include**: <e.g. logo, product screenshot from library/<path>>
- **Must avoid**: <e.g. stock-photo handshake clichés, padlock icons>

### Reference examples
- <link to prior brand asset 1>
- <link to prior brand asset 2>

### Execution
- **Recommended tool**: <Canva / Figma / Claude Design / Adobe>
- **Template starting point** (if Canva): <link to brand kit template>
- **Estimated effort**: <30 min / 1h / a few hours>

### Success rubric
- <how a reviewer will judge the asset>
- e.g. "recognizable at thumbnail size, doesn't look like every other SaaS asset, sits coherently with the brand's existing visual library"
```

## Outputs

- Paste-ready creative briefs posted in the parent thread (Linear ticket comment / Slack thread on the originating draft) so the brief stays attached to the content it serves
- For standalone briefs (no parent thread), Slack notification to `#marketing` with the brief link + intended human executor
- Archived briefs at `dev-team-state/projects/<project>/marketer/creative-briefs/<slug>.md` for pattern reuse (auto-loaded on next `creative-brief` session via conditional state load)
- Optional: Linear ticket to `@client-agent` for a missing product screenshot per Protocol #4 (label `screenshot`, posted to `#marketing` for visibility)

## Label conventions

When creating tickets per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol):
- Type: `content` (the asset is content)
- Area: `design`
- For screenshot requests routed to `@client-agent`: also `screenshot`

## Examples

> **Brief (for the CSV-export blog hero)**:
>
> ## Creative brief — Blog hero
>
> **Topic**: "Exporting your project data — fast and unlimited"
> **Channel**: Blog OG image
> **Dimensions**: 1200×630
> **Deadline**: 2026-11-13 (one day before blog launch)
>
> ### Brand context
> - **Voice notes**: confident, builder-energy, never corporate. Specific over generic.
> - **Color palette**: primary blue (`#1E3A8A`) + neutral grays
> - **Typography**: heading face (Inter Bold), body face (Inter Regular)
> - **Style direction**: minimal, slightly technical, no glossy stock-photo feel
>
> ### Composition
> - **Subject**: laptop screen showing CSV data downloading, subtle data-flowing visual element
> - **Mood**: capable / fast / unblocked
> - **Must include**: product screenshot from library at `assets/screenshots/library/exports/list-view/desktop-1440.png`; brand wordmark in bottom-right
> - **Must avoid**: generic Excel stock photo, padlocks/security clichés, "rocket ship launching" tropes
>
> ### Reference examples
> - Prior blog hero: [link to 2026-09-15 schedules-update hero] — same energy
> - Prior blog hero: [link to 2026-08-22 mobile-launch hero] — same minimal style
>
> ### Execution
> - **Recommended tool**: Canva — we have a templated blog hero in the brand kit at [link]
> - **Template starting point**: "Blog hero — feature launch" template
> - **Estimated effort**: 30 min
>
> ### Success rubric
> - Recognizable at thumbnail (in social shares + RSS readers)
> - Doesn't look like every other SaaS blog hero
> - Sits coherently with the prior 6 months of blog hero imagery
> - Reads correctly at 600×315 (half-size for LinkedIn share preview)

> **Brief (Claude Design — product-launch one-pager for sales team)**:
>
> ## Creative brief — One-pager
>
> **Topic**: "CSV Export — Sales Enablement One-Pager"
> **Channel**: Sales team handout (PDF + Notion-embed)
> **Dimensions**: Letter portrait, single page
> **Recommended tool**: Claude Design — claude.ai/design (it does these well; we have prior one-pagers at [link] to anchor style)
> [...rest of the brief...]

## Escalation

- **The asset would require a major brand-asset addition** (a custom illustration style we don't have) → escalate to human marketing director; **don't drift the brand by ad-hoc decisions.**
- **The brief implies a visual claim that requires substantiation** (e.g. a chart with specific numbers, a comparison table with competitor data) → loop in `growth-analyst` (for data) + `benchmarking` (for competitor figures) + verify accuracy before the visual is made.
- **The asset would use a customer's photo/logo** → loop in legal + verify the customer's permission per the testimonial-permission rule.
- **The needed product screenshot isn't in the library** → file the structured request to `@client-agent` per Protocol #4; don't fabricate a mock that looks like a real screen.
- **The recommended tool would need a paid account upgrade** (e.g. Canva Pro for a brand-kit feature) → flag the spend to the human marketing lead; don't unilaterally request the upgrade.

## What this skill does NOT do

- **Generate the asset itself.** This is brief-only — humans execute the asset in the recommended tool. The brief makes the human's execution fast and on-brand.
- **Decide brand visual direction** (palette, typography, photographic vs. illustrative). That lives in `BRAND.md` + brand-asset references — set by humans + `pr-brand-steward`.
- **Modify the brand kit** (Canva brand kit, Figma kit) — that's a human marketing-design job.
- **Approve the executed asset** — a human marketer / designer reviews + approves before it lands in content.
- **Fabricate product screenshots** — pull from library or request from `@client-agent`. Never mock up a fake screen that looks real.
