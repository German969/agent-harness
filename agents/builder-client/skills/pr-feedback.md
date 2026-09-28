---
name: pr-feedback
description: React to events on existing Builder-Client PRs — CI failures, review comments, change requests, human pushes. UI-specific overlay on Builder-Server's pattern — visual feedback gets fresh screenshots in responses; design-token pushback references CLAUDE.md rules; a11y pushback is non-negotiable; visual regression failures get triaged (intentional change vs. regression).
---

# Skill — PR Feedback (frontend)

## Activate when

- **CI failure** on a PR authored by `@client-agent`
- **New comment** (review or general) on a `@client-agent` PR
- **Review submitted** with status `CHANGES_REQUESTED` on a `@client-agent` PR
- **Push by a human** to a branch owned by `@client-agent`

## Specialized knowledge

Overlay on Builder-Server's `pr-feedback` patterns, with these UI-specific additions:

- **Visual feedback handling** — when a reviewer says "this doesn't look right," **re-run visual verification** (Phase 4) and post fresh screenshots to confirm or pivot.
- **Design-system pushback** — when a reviewer requests a hardcoded value, push back with the token alternative and the project's CLAUDE.md / `design-system.md` rule. If the reviewer persists, defer but **log the deviation** in `design-system.md` under "deviations."
- **a11y pushback discipline** — a11y is non-negotiable. If a reviewer wants to skip an a11y check or rationalize away an axe finding, decline politely and explain the user impact.
- **Visual regression triage** — Percy / Chromatic / Playwright snapshot failures can be intentional (the design changed) or unintentional (a regression). Distinguish by checking the diff against the plan:
  - If the change was intended (plan said so) → update the snapshot in the PR, comment explaining
  - If the change was unintended → real regression, fix it
- **The lesson-capture loop** — every review-merge cycle is a learning opportunity. Two destinations depending on what was learned:
  - **Visual / token / UI-kit lessons** → `design-system.md` (existing pattern; new tokens or deviations)
  - **Everything else** (state management, file structure, naming, composition patterns, hook usage, anti-patterns) → `coding-practices.md` at `dev-team-state/projects/<project>/builder-client/coding-practices.md`
  - Without the loop, the next PR repeats the mistake.

## Procedure

1. **Identify the event type**: CI failure / comment / change-request / human push.
2. **Re-plan briefly** (Phase 2 of the dev cycle, lightweight): what's the event asking for, what's my proposed response, is it in scope?
3. **Take action by event type**:

### CI failure on visual regression

- Compare the failing diff against the plan: was a visual change intended here?
- **If yes** (intended): update the snapshot, push, comment "visual change intentional — see plan"
- **If no** (regression): debug, fix, push

### CI failure on a JS test (component / e2e)

Same procedure as Builder-Server's `pr-feedback` — distinguish flake from real:
- Flake → comment "appears to be a CI flake — retrying"; retry the workflow
- Real → diagnose, fix, push

### Review comment on visual issue

- Re-run visual verification at the specific breakpoint(s) the reviewer mentioned
- Post fresh screenshots in the response
- If the issue is real → fix
- If you can't reproduce → post screenshots showing what you see and ask the reviewer for theirs

### Change request adding hardcoded value

- Reply with the token alternative + the rule (CLAUDE.md says no hardcoded values when tokens exist)
- If reviewer persists with a coherent counterargument, comply but **log the deviation** in `dev-team-state/projects/<project>/builder-client/design-system.md` under "deviations"

### Change request skipping a11y

- Decline politely with the user-impact reason
- Offer alternative solutions if the underlying constraint is real
- Escalate to a human if the reviewer insists — a11y critical/serious findings block merge

### Out-of-scope suggestion

- Acknowledge the suggestion
- **Open a follow-up Linear ticket** and link to it from the comment thread. Apply labels per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol): type (`Feature`/`Improvement`), area `frontend`, plus `needs-design` if the follow-up needs design work first.
- **Don't expand the PR's scope.**

### Human push to the agent's branch

- Read the diff. **Don't undo it.**
- If it conflicts with the agent's plan, post a comment asking how to reconcile.
- Otherwise, integrate it into the agent's mental model and continue the cycle.

4. **Lesson capture** (before ending the session — only when something was learned):
   - **Trigger**: a reviewer's correction was accepted (you agreed and pushed a fix) AND the correction reveals a pattern that should apply beyond this single PR. **Don't** capture every one-off fix — only patterns.
   - **Pick the destination**:
     - **Visual / token / UI-kit lesson** → `design-system.md` (existing pattern; new tokens, new components, deviations, conventions)
     - **Everything else** (state management, file structure, naming conventions, composition patterns, hook usage, anti-patterns surfacing from the React/RN code) → `coding-practices.md` at `dev-team-state/projects/<project>/builder-client/coding-practices.md`
   - **Read the destination** first to check if the lesson is already documented.
   - **If new**, append in this shape:
     ```markdown
     ### <YYYY-MM-DD> — <short title>

     **Pattern**: <the rule, one sentence>
     **Why**: <the reason it matters — often a past correction or a non-obvious trade-off>
     **Example**: <a minimal code example or a link to the originating PR>
     **Source**: PR #<number>, reviewer @<handle>
     ```
   - **If already documented but the existing entry is incomplete or wrong**, refine it (additive — keep the history). Note the refinement in the entry's source line.
   - Stay within scope: this skill captures **tactical patterns**. It does NOT capture **architectural decisions** — those are ADRs owned by `@platform-agent`. If you're tempted to write an ADR-shaped entry, escalate to `@platform-agent` instead.

5. **End the session** after action + (if applicable) lesson capture. Wait for the next event.

## Outputs

- New commits on the existing branch (when fix or change is required)
- PR thread comments with **fresh screenshots** when visual feedback is involved
- Updated `design-system.md` deviations log if relevant
- Appended / refined entries in `dev-team-state/projects/<project>/builder-client/coding-practices.md` when a review-merge cycle validates a tactical pattern (non-visual)
- Linear tickets for out-of-scope follow-ups

## Examples

> **Event**: review comment "the empty state is hard to read at 375px"
>
> **Response**: re-run visual verification at 375px in light + dark mode. Capture fresh screenshots. Diagnose: yes, contrast on the secondary text drops below 4.5:1 at the smaller size because of the background gradient changing visually. Fix by adjusting the gradient stop or swapping the text color token. Push commit. Comment: "Confirmed at 375px — secondary text on the gradient was reading 4.1:1 in light mode. Pushed `0abc123` swapping the gradient stop. Screenshots: [light at 375px], [dark at 375px]. Now 5.2:1."

> **Event**: change request "use #5588ff for the badge instead of the primary token"
>
> **Response (push back)**: "Pushing back. `primary-500` is the project's token for this color family (see `design-system.md`). The project's CLAUDE.md says no hardcoded color values. Two options:
> 1. Keep `primary-500` — same color, project-consistent. (Preferred.)
> 2. Add a new semantic token for this specific badge type and use it. (If the badge is genuinely a new visual category.)
> Inline hex isn't an option per the rule. Which do you want?"

> **Event**: visual regression failure on the header snapshot
>
> **Response**: check the plan — yes, the header layout shifted intentionally per ENG-1234. Update the snapshot, push, comment: "Visual change intentional — see plan in PR description. Updated header snapshot."

## Escalation

- Same CI job fails 3× in a row → ping `@platform-agent` (DevOps skill) for infra check.
- Architectural disagreement with a reviewer → `@platform-agent` for tiebreaker.
- Reviewer insists on bypassing a critical a11y finding → decline; escalate to human owner.

## What this skill does NOT do

- Auto-merge after CI is green — humans merge.
- Modify the PR's scope without acknowledgment — out-of-scope changes become follow-up tickets.
- Override a reviewer with more context — concede readily; the PR is about reaching shared understanding.
- Quietly drop a11y findings (a11y is non-negotiable).
- Skip visual verification when re-running after a fix — fresh screenshots in every visual-feedback response.
