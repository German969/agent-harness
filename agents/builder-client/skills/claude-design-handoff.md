---
name: claude-design-handoff
description: Consume a Claude Design handoff bundle (exported from claude.ai/design by a human) and implement it. Faithful implementation discipline — treat the bundle's HTML/CSS as reference, not copy-paste source. Map bundle components to existing UI-kit. Flag and document any deviations from the bundle in the PR description.
---

# Skill — Claude Design Handoff Consumption

## Activate when

- Linear ticket has a **Claude Design handoff bundle attached** (detected by file extension or content marker — Cyrus's webhook parser identifies it)
- Phase 2 of the dev cycle detects the bundle and routes to this skill before/instead of generating a pre-fill

## Specialized knowledge

- **Handoff bundle anatomy** — what Claude Design exports: HTML/CSS structure, design tokens used, component breakdown, interaction notes, asset references.
- **Faithful implementation discipline** — the human iterated on the design in Claude Design; your job is to translate it to production code without re-designing. **Don't second-guess the design.**
- **When to deviate** — only when faithful implementation would violate one of:
  - The project's existing design tokens (the design uses a value that isn't a token → flag, propose a token addition)
  - Accessibility (the design has a contrast or focus issue → flag, propose a fix)
  - Responsive constraints (the design only covers 1440px and we need 375px → make a responsible interpretation and document it)
  - Performance (the design suggests an animation that would cause jank → propose a degraded version)
- **What to do with handoff HTML/CSS** — Claude Design exports structured markup. Treat it as a **reference**, not a copy-paste source. Re-implement using the project's component library and conventions, not raw HTML.

## Procedure

1. **Parse the handoff bundle.** Extract:
   - Visual structure (sections, hierarchy)
   - Token usage (which design tokens the bundle references)
   - Component breakdown (the bundle's "components" — map these to your UI kit)
   - Interactions (hover, click, state transitions)
   - Asset list (any images, icons referenced)
2. **Map the bundle's components to the project's existing UI kit.** For each:
   - Bundle says "Card with elevated shadow" → use existing `<Card variant="elevated">` from UI kit
   - Bundle uses a token that doesn't exist in the project → flag, propose adding to the design system
3. **Plan implementation** per CLAUDE.md §"The development cycle" Phase 2, with extra sections:
   - **Bundle → project translation** — a small table mapping bundle elements to existing components / tokens
   - **Deviations** — explicit list of where the implementation will differ from the bundle and why
4. **Proceed through Phases 3–6 normally** (Implement → Self-test + visual verify → Self-review → Open PR).
5. **In Phase 6 (Open PR)**, the description includes:
   - Link to the original handoff bundle
   - Screenshots of the implementation at every breakpoint
   - **The deviations list — visible, not buried**

## Output (Phase 2 plan structure additions)

```markdown
## Bundle → project translation
| Bundle element | Project equivalent | Notes |
|---|---|---|
| `<HeroSection>` | `<Section variant="hero">` from `client/src/kit/Layout.tsx` | Same |
| Info chip pattern | NEW component proposed: `<Chip>` in UI kit | Bundle uses this in 3 places; worth adding |
| Spacing 8/12/16/24/32 | Project tokens `space-2`/`space-3`/`space-4`/`space-6`/`space-8` | All map cleanly |

## Deviations from the bundle
- Bundle title font weight 600 → using project's `font-medium` (500) per type scale in `design-system.md`. Visually nearly identical; preserves type-scale discipline.
- Bundle illustration at the top is a custom asset → swapping for the project's existing `<EmptyHero>` component which we use elsewhere; cleaner visual library, customer recognition.
```

## Outputs

- PR with implementation faithful to the handoff bundle
- PR description with explicit deviations called out
- Possible follow-up PR proposing new design tokens / components if the bundle reveals gaps in the UI kit
- Updates to `dev-team-state/projects/<project>/builder-client/design-system.md` if new tokens / components ship from this work

## Examples

> **Input**: a handoff bundle attached to ENG-1234 ("redesign the project detail page")
>
> **Plan**:
> - Bundle → project mapping: `<Section>` from bundle uses existing `<Section>` from `client/src/kit/Layout.tsx`; bundle's "info chip" needs new component (proposing `<Chip>` in UI kit); bundle's spacing values (8, 12, 16, 24, 32) all map to existing tokens.
> - Deviations: bundle's title font weight 600 maps to `font-medium` (500) per project's type scale — keeping the project's scale.
>
> **PR**: 4 commits (page restructure, new `<Chip>` component, styling updates, tests). Description with screenshots + deviations list.

## Escalation

- **Handoff bundle requires fundamentally different state management or routing** that the project doesn't support → ping `@platform-agent` for architecture discussion before implementing.
- **Bundle is internally inconsistent** (e.g. shows the same component with two different styles in different places) → flag in PR comment, ask the human designer to clarify which is canonical.
- **Bundle uses a third-party asset we don't have license for** → flag for human resolution; don't proceed with a stand-in without acknowledgment.

## What this skill does NOT do

- **Re-design the bundle** — the human iterated on it in Claude Design. Your job is faithful implementation, not improvement.
- **Add features the bundle didn't include** — out-of-scope visual elements go to follow-up tickets.
- **Skip visual verification** — even with a handoff bundle, Phase 4 visual verification still runs (the implementation should match what the bundle shows).
- **Quietly accept deviations** — every deviation goes in the PR description.
