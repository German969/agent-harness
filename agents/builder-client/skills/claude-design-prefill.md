---
name: claude-design-prefill
description: Generate a paste-ready Claude Design prompt when a UI ticket arrives without a design. Bot refuses to implement non-trivial UI without a design; this skill produces the pre-fill prompt for a human to open in claude.ai/design, iterate on the canvas, export a handoff bundle, and return it. The bot resumes via the `claude-design-handoff` skill once the bundle is attached.
---

# Skill — Claude Design Pre-fill

## Activate when

- During Phase 2 (Plan), the agent detects a UI ticket with **no design** attached (no handoff bundle, no Figma link, no screenshot reference) and the change is **non-trivial**
- Linear ticket with label `needs-design` assigned to `@client-agent`
- Explicit: `@client-agent prefill design for <feature>` in Slack or Linear

**Don't activate** for trivial UI changes (copy edits, single-prop tweaks, removing a button, changing a header). Those proceed via the `frontend` skill with the visual decisions called out in the plan.

## Specialized knowledge

- **How Claude Design (claude.ai/design) consumes prompts** — it accepts text descriptions, image references, codebase pointers, and design-system primer text. The better the prompt, the better the session.
- **Pre-fill prompt anatomy** — what makes a Claude Design session productive:
  - Feature description (1–2 paragraphs of *what*, not *how*)
  - Design system primer (key tokens, component vocabulary, brand voice notes)
  - Reference patterns from the existing codebase (specific file paths and component names)
  - Visual acceptance criteria (responsive breakpoints, dark mode, a11y bar)
  - Success rubric (how a reviewer judges the result)
- **What to NOT include** — implementation details, specific component decompositions, color picks. Claude Design + a human designer make those decisions.

## Procedure

1. Read the feature requirements from the PRD or ticket description fully. Confirm the change is UI-substantive enough to need a design.
2. Read `dev-team-state/projects/<project>/builder-client/design-system.md` for the design system primer (tokens, components, brand voice).
3. Search the codebase for similar existing UI patterns; collect 2–4 references with specific file paths + line ranges.
4. Compose the pre-fill prompt:
   ```
   Design <feature> for <product context, 2-3 sentences from PRODUCT.md>.
   
   ## Context
   <product context summary>
   
   ## Design system
   Colors: <semantic token list from design-system.md>
   Typography: <type scale tokens>
   Spacing: <spacing scale tokens>
   Components: <key components from UI kit with one-line descriptions>
   Brand voice: <2-3 lines from BRAND.md>
   
   ## Reference patterns from the codebase
   - <path/to/SimilarComponent.tsx:N>: <what it does and why useful here>
   - <path/to/AnotherComponent.tsx:N>: <ditto>
   
   ## Requirements
   - Responsive breakpoints: <list>
   - Dark mode: <yes/no>
   - Accessibility: WCAG 2.1 AA
   - Constraints: <e.g. "must use existing Card component", "no new modal patterns">
   
   ## Acceptance criteria
   - <visual AC 1>
   - <visual AC 2>
   - ...
   
   ## How a reviewer will judge this
   - <rubric criterion 1>
   - <rubric criterion 2>
   - "Engineer can implement in ≤<estimate> days"
   ```
5. Post the prompt back in the Linear ticket / Slack thread, wrapped in a fenced code block, with instructions:
   > Open [claude.ai/design](https://claude.ai/design), paste this prompt, iterate on the canvas. When done, click **Export** to generate a handoff bundle, then paste the bundle into this ticket and reassign to `@client-agent`.
6. Archive the prompt to `dev-team-state/projects/<project>/builder-client/design-prefills/<slug>.md` for future reuse and pattern detection.
7. **End the session.** The human iterates in Claude Design; when they return with a handoff bundle, the `claude-design-handoff` skill picks it up.

## Outputs

- Linear/Slack comment containing the paste-ready prompt
- Archived prompt at `dev-team-state/projects/<project>/builder-client/design-prefills/<slug>.md`

## Examples

> **Input**: ticket asks for "dashboard widget layout for the new analytics page"
>
> **Output**: Slack/Linear comment with a fenced code block prompt — opens with "Design a dashboard widget layout for the new analytics page in <product>'s SaaS platform…", followed by design system primer (colors, spacing scale, Card/StatPanel/Sidebar components from UI kit), AC ("must use design tokens, no hardcoded color values; must support dark mode; must be keyboard-navigable; layout must work at 1280px and 768px breakpoints"), reference patterns ("existing pattern at `client/src/components/Dashboard.tsx:40-120`, but cleaner needed"), success rubric ("polished but not over-designed; engineer can implement in ≤3 days; reuses existing Card / StatPanel; doesn't introduce new modal patterns").

## Coordination with Strategist's design-prefill

Strategist's `design-prefill` skill (§5.7 in Strategist SPEC) does almost the same thing — but it runs **proactively during PRD authoring**, before the ticket reaches Builder-Client. The reactive case (this skill) runs when a ticket arrives at Builder-Client without a design (Strategist's prefill didn't happen, or the PRD didn't go through Strategist, or the human created the ticket directly).

Both skills produce the same artifact shape. Both reference the same `design-system.md`.

## Escalation

- **Design intent unclear** (PRD vague on UI) → ask for clarification before generating the pre-fill. Do not paper over ambiguity in the prompt.
- **No design-system summary yet** (Phase 0/1 of bootstrap) → use `BRAND.md` as a minimal system and flag the gap in the comment.

## What this skill does NOT do

- Produce mockups (Claude Design with a human does that).
- Implement the design (that's `claude-design-handoff` once the bundle returns, then `frontend` for the actual code).
- Iterate on the design (the human iterates in Claude Design; this skill's job ends with the paste-ready prompt).
- Author the design system itself (the project authors it; Builder-Client maintains the summary `design-system.md`).
