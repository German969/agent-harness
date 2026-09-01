---
name: design-prefill
description: Generate a paste-ready Claude Design prompt when UI work is needed but no design exists. Produces a structured prompt with feature description, design system primer, reference patterns from the codebase, visual acceptance criteria, and a success rubric. Human pastes into claude.ai/design, iterates, exports a handoff bundle for Builder-Client to implement.
---

# Skill — Claude Design Pre-fill

## Activate when

- The `pm` skill detects UI work in a PRD it's drafting (auto-invokes this skill)
- Linear ticket labeled `needs-design`
- Slack: `@strategist-agent prefill design for <feature>`

## What this skill exists to do

Claude Design (claude.ai/design) is a human-driven web product — there's no API to invoke it from a bot. But it works much better with a well-structured prompt. This skill produces that prompt: feature description + design system primer + reference patterns + AC + rubric, paste-ready, so the human's iteration in claude.ai/design starts from a strong foundation.

This is **not** the place to produce mockups. The human does that in Claude Design.

## Procedure

1. Read the feature requirements (from PRD or ticket description).
2. Read the project's design-system summary — typically lives at `dev-team-state/projects/<project>/builder-client/design-system.md` (maintained by Builder-Client). If it doesn't exist yet (Phase 0/1), use the brand voice doc from `<target-project>/founding/BRAND.md` as a minimal system and flag the gap.
3. Find existing UI patterns in the codebase that resemble the requested feature. Note specific file paths.
4. Compose the prompt:
   ```
   Design <feature> for <product context>.
   
   ## Context
   <product context, 2-3 sentences from PRD>
   
   ## Design system
   Colors: <semantic token list>
   Typography: <type scale tokens>
   Spacing: <spacing scale tokens>
   Components: <key components from UI kit with one-line descriptions>
   Brand voice: <2-3 lines from BRAND.md>
   
   ## Reference patterns from the codebase
   - <path/to/SimilarComponent.tsx>: <what it does and why useful here>
   - <path/to/AnotherComponent.tsx>: <ditto>
   
   ## Requirements
   - Responsive breakpoints: <list>
   - Dark mode: <yes/no>
   - Accessibility: WCAG 2.1 AA
   - Constraints: <e.g. "must use existing Card component">
   
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
6. Archive the prompt to `dev-team-state/projects/<project>/strategist/design-prefills/<slug>.md` for future reuse and pattern detection.

## Example

> **Input**: PRD for "analytics dashboard layout"
>
> **Output**: Slack/Linear comment with a fenced code block prompt — opens with "Design an analytics dashboard at 1280px and 768px breakpoints…", followed by design system primer (colors, spacing scale, Card/Sidebar components), AC ("must use design tokens, no hardcoded color values; must support dark mode; must be keyboard-navigable"), reference patterns ("existing pattern at `client/src/components/Dashboard.tsx`, lines 40–120"), success rubric ("polished but not over-designed; engineer can implement in ≤3 days").

## Escalation

- Design intent unclear (PRD vague on UI) → ask for clarification before generating the prefill. Do not paper over ambiguity in the prompt.
- No design system documented yet (Phase 0/1) → use the brand voice doc from `<target-project>/founding/BRAND.md` as a minimal system and flag the gap in the comment.

## Outputs

- Linear/Slack comment containing the paste-ready prompt
- Archived prompt at `dev-team-state/projects/<project>/strategist/design-prefills/<slug>.md`

## Coordination with Builder-Client

Builder-Client also has a `claude-design-prefill` skill (it handles the case where a UI ticket arrives to it without a design). The skills are nearly identical; the difference is the trigger point — Strategist's runs proactively during PRD authoring, Builder-Client's runs reactively when a UI ticket arrives without a design. Both produce the same artifact shape. Both reference the same design-system summary owned by Builder-Client.

## What this skill does NOT do

- Produce mockups (Claude Design with a human at the keyboard does that).
- Author the design system itself (Builder-Client does that).
- Iterate on the design (the human iterates in Claude Design; Strategist's job ends with the paste-ready prompt).
