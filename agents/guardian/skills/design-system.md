---
name: design-system
description: Design-system compliance review on UI PRs — token discipline (no hardcoded colors/spacing/radii), UI-kit-first authoring (don't shadow existing components), drift detection. Auto-fires on UI PRs. Reads design-system.md (maintained by Builder-Client). Routes both mechanical token swaps and pattern-level concerns to Builder-Client — Guardian audits, Builder-Client fixes.
---

# Skill — Design-System Compliance

## Activate when

- Auto-fires on UI PRs (paths matching frontend dirs, plus the mobile repo for mobile work)
- Scheduled **weekly cross-PR drift scan**
- `@guardian-agent design-system-review <path>` for explicit invocation

## Specialized knowledge

- **The project's design tokens + UI kit** (loaded from `dev-team-state/projects/<project>/builder-client/design-system.md` — Builder-Client maintains this file; you consume it)
- **The project's CLAUDE.md "Figma-to-code rule"**: no hardcoded values when a token exists
- **Drift-detection patterns**:
  - Hardcoded hex codes in CSS/JSX/TSX
  - Raw `px` values for spacing / radius (the token system specifies these)
  - Inline `style={}` with visual properties (border, background, color)
  - Custom components duplicating UI-kit functionality (a new `<Card>` when `<Card>` already exists)
  - New tokens added without being added to `design-system.md`

## Procedure

1. **Scan the diff for tokens vs raw values**:
   - Hex codes (`#RRGGBB`, `#RGB`, etc.) — should be tokens (e.g. `text-primary`, `bg-surface`)
   - Spacing values in `px` (margins, padding, gaps) — should be spacing tokens (`gap-2`, `p-4`, etc.)
   - Border-radius `px` values — should be radius tokens
   - Font sizes in `px` — should be type-scale tokens
2. **For each violation**: identify the token that should have been used, link to where it's defined in `design-system.md`.
3. **Find inline-style violations** (visual properties — `color`, `background`, `border`, `padding`, etc. in inline `style={}`).
4. **Find UI-kit-component-shadowing**: a new component that re-implements what UI-kit already provides (e.g. inline `<div className="card-like">` when `<Card>` exists).
5. **Severity**: design-system violations are usually **moderate** (not blocking) but they compound — the weekly drift scan tracks accumulation.

## Outputs

- Findings in the unified Guardian review comment with specific token recommendations
- Weekly drift report in `<target-project>/docs/design-system/drift/<date>.md` if findings exceed a threshold
- **Linear tickets routed to `@client-agent`** for the actual fix — both mechanical token swaps (low-risk swap-list tickets) and pattern-level concerns (structural)

## Label conventions

Tickets routed for substantive design-system work, per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol):
- Type: `Improvement` (token-system maintenance) or `Feature` (new component/token needed)
- Area: `frontend`
- `design`

## Examples

> **Finding**: "Design-system: line 28 of `client/src/components/Badge.tsx` uses `color: #5588ff`; should be `text-primary` (defined at `client/src/styles/tokens.css:34`). Two more similar violations at lines 41 and 67. Routing the swap-list to `@client-agent` as ENG-XXXX (P3, label `design`)."

> **Pattern-level concern** (routed to Builder-Client): "Found 3 PRs this week introducing new card-like components inline rather than using the existing `<Card>` from UI kit. Suggests either: (a) `<Card>` is missing a variant people need, or (b) `<Card>` is hard to discover. Routing to `@client-agent` for investigation: should we add a variant or improve docs?"

## Escalation

- **A genuinely-needed value doesn't have a corresponding token** → flag in PR comment + propose adding the token (handed to `@client-agent`).
- **Repeated drift in the same area** (multiple PRs introducing the same anti-pattern) → file a pattern-level ticket for `@client-agent` to address structurally.
- **The design system itself is incoherent** (`design-system.md` documents conflicting patterns) → ping `@client-agent` (this is their file; they fix it) + `@strategist-agent` (Curator skill — drift between doc and reality).

## What this skill does NOT do

- **Apply token swaps directly** in product code — Guardian's write scope doesn't cover client/server source. The swap-list ticket goes to `@client-agent`.
- Modify the design system itself (`design-system.md`) — that's Builder-Client.
- Make subjective design judgments ("this color feels wrong") — only objective rule violations.
- Block PRs solely on design-system violations — these are usually moderate-severity, advisory. (Token-discipline failures are real but rarely user-impacting; pattern-level concerns route to follow-up tickets.)
- Add new components to the UI kit — that's Builder-Client's `frontend` skill.
