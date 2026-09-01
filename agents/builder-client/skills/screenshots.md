---
name: screenshots
description: Produce product screenshots for Marketer's content per the Product Screenshot Protocol. Maintains the screenshot library at the marketing repo. Uses Claude Preview MCP to start dev server, navigate, capture at multiple breakpoints + modes + states. Never uses real customer data — demo seed only. Mobile-native screenshots delegated to humans/CI.
---

# Skill — Screenshots (for Marketer)

## Activate when

- Marketer requests a screenshot (Linear ticket, `@client-agent screenshot <surface> <state>`)
- A PR ships UI changes that **significantly alter a surface present in the screenshot library** — auto-refresh that surface
- **Scheduled monthly library audit** — check for stale captures (>90 days old or where the app's UI has clearly drifted)

This skill is the **producer side** of the [Product Screenshot Protocol](../../PROTOCOLS.md#4-product-screenshot-protocol). Marketer is the consumer; Builder-Client produces and maintains the library.

## Specialized knowledge

- **The screenshot library structure and naming convention**:
  - Path: `<target-project>-marketing/assets/screenshots/library/<surface>/`
  - Naming: `<date>--<state>--<mode>--<breakpoint>.png` (e.g. `2026-11-12--full--light--1440x900.png`)
  - Metadata file per surface: `_metadata.yml`
  - See the [Product Screenshot Protocol](../../PROTOCOLS.md#4-product-screenshot-protocol) for full spec
- **The Claude Preview MCP tools** for capture (`mcp__Claude_Preview__preview_start`, `_navigate`, `_resize`, `_screenshot`, `_fill`, `_eval`)
- **The project's demo-data seeder** — how to spin it up, which seed produces marketing-friendly data, how to reset between captures. If no seeder exists yet, this is the **first thing to establish** (loop in Builder-Server if data fixtures are needed at the data-layer)
- **The project's responsive breakpoints, dark mode setup, and feature-state matrix** (which states matter to capture per surface — `full`, `empty`, `loading`, `error`, plus feature-specific states like `export-in-progress`)
- **Quality bar**: no debug overlays, no `console.log` artifacts, no broken layouts, no real PII, no out-of-tokens text

## Procedure (on-demand request from Marketer)

1. **Read the request.** Confirm surface, state, mode, breakpoint, purpose, deadline. Bounce back if any are missing.
2. **Check the library** — does an existing capture already satisfy the request (modulo staleness)? If yes, point Marketer at the existing path and skip the rest.
3. **Set up demo data**:
   - Start the dev server in the worktree (`pnpm dev` or stack equivalent)
   - Seed with the marketing-friendly seed (or run the data-setup script the surface requires)
4. **Navigate + capture** via Claude Preview MCP:
   - `preview_start` the dev server URL
   - `preview_navigate` to the surface
   - `preview_resize` to the target breakpoint
   - Set the desired state (via UI interaction `preview_click`/`preview_fill`, or data setup)
   - `preview_screenshot` to capture
   - Repeat for each requested breakpoint + mode
5. **Self-review** each capture against the quality bar (no debug, no PII, etc.).
6. **Commit to the library** at the right path:
   - General reuse: `library/<surface>/<date>--<state>--<mode>--<breakpoint>.png`
   - Campaign-specific: `campaign-assets/<campaign-slug>/...`
   - Update `_metadata.yml` for the surface
   - Commit to the marketing repo
7. **Notify Marketer** with the path(s) and any notes (e.g. "captured the empty-state too in case useful for the message").

## Procedure (auto-refresh on UI change)

1. After merging a PR that changes UI in a captured surface (detected by path overlap with the library's surface registry), open a follow-up PR refreshing that surface's screenshots.
2. **Retain old versions** in the library (don't delete) — historical content still references them.
3. Update `_metadata.yml` with the new `last_capture` and `app_version`.

## Procedure (scheduled monthly library audit)

1. Walk the library; for each surface, check the most-recent capture's date and `app_version`.
2. Cross-reference against the current UI:
   - Capture >90 days old → flag for refresh
   - App version mismatch + UI changes touched the surface → refresh
3. Open a single audit PR refreshing the stale surfaces; comment in `#marketing` summarizing what refreshed.

## Procedure (mobile-native screenshots)

1. **For web mobile viewport** (responsive at 375x812): handle normally via Claude Preview MCP.
2. **For native iOS / Android screenshots**: Cyrus's Linux VM can't build iOS; Android requires the SDK. **Don't try.** Produce a creative brief instead — point at simulator/device capture, specify the exact states + data + breakpoints, hand to a human (or to CI if CI has iOS/Android build jobs that can capture).

## Output format (notification to Marketer)

```
📸 Captured.

Library paths:
- <path>/2026-11-12--full--light--1440x900.png
- <path>/2026-11-12--full--dark--1440x900.png
- <path>/2026-11-12--empty--light--1440x900.png

Also captured the empty-state variant since your request mentioned the blog discusses zero-data onboarding — see `2026-11-12--empty--light--1440x900.png` in case useful.

Metadata updated at `<path>/_metadata.yml`. App version: v2.4.0. Demo seed: marketing-friendly.
```

## Outputs

- Screenshots in `<target-project>-marketing/assets/screenshots/library/<surface>/` (general reuse) or `campaign-assets/<slug>/` (campaign-specific)
- Updated `_metadata.yml` files
- Library audit PRs (monthly)
- Creative briefs for mobile-native captures Builder-Client can't take itself

## Examples

> **Input** (Marketer request): "Need a dashboard screenshot for the CSV export blog post. State: full data with ≥10 projects mixed statuses. Mode: light primary, dark also. Breakpoint: 1440x900 (will resize to 1200x630 for OG). Purpose: hero image. Deadline: tomorrow EOD."
>
> **Procedure**: spin up dev server, run `pnpm seed:marketing-friendly` (which loads a curated 15-project dataset), navigate to `/dashboard`, capture at 1440x900 in light mode, switch theme, recapture in dark mode. Self-review: no debug, no PII (seeded data only), Tailwind tokens consistent. Commit to `library/dashboard/2026-11-12--full--light--1440x900.png` + dark variant. Update `_metadata.yml`. Comment to Marketer: "📸 Captured. Library paths: [links]. Also captured the empty-state variant since you mentioned the blog discusses zero-data onboarding."

## Escalation

- **No demo-data seeder exists** and the surface needs data → loop in Builder-Server for fixtures + ship a minimal seeder. **Don't fake the data. Don't pull from prod.**
- **Surface uses a third-party iframe or external data** we can't control → flag in the brief; capture only the parts we own; mark the external portion in `_metadata.yml`.
- **Mobile-native screenshot needed** but no simulator access → produce a creative brief; hand to a human or to CI.
- **Surface is broken** (the dev server won't render the requested state) → file a Linear ticket for the bug; notify Marketer of the delay; capture once fixed.

## What this skill does NOT do

- Use real customer data in marketing screenshots. **Ever.** Demo seed only.
- Fake screenshots (mockups, photoshop) — capture from the actual app or produce a creative brief for a human.
- Build iOS apps to capture native screenshots (impossible in Linux VM).
- Submit screenshots without metadata updates (the `_metadata.yml` file is part of the artifact).
- Publish screenshots externally — Marketer publishes; this skill just commits to the library.
