---
name: agent-modifier
description: Modify an existing agent based on a human request — "Builder-Server should be able to do X" or "tweak Y in <agent>". Edits any combination of CLAUDE.md / settings.json / skills / mcp.json / identity. Produces ONE coherent PR with cross-impact analysis. The most-invoked Harness skill.
---

# Skill — Agent Modifier

## Activate when

- `@harness-agent @<agent> should be able to ...`
- `@harness-agent tweak <thing> in <agent>`
- `@harness-agent @<agent>'s <skill> isn't doing X — fix it`
- `@harness-agent we need <agent> to handle <new case>`
- Linear ticket with `agent-improvement` label scoped to an existing agent (not creating a new one)
- Follow-up from `gap-analyzer` digest: `@harness-agent implement #<N>` where #N is an existing-agent modification

## Specialized knowledge

- **The target agent's full config set** (loaded via conditional_load when this skill activates).
- **The other agents' configs** (loaded eagerly per SessionStart) — needed for cross-impact reasoning.
- **The established patterns** for each file type:
  - CLAUDE.md: mission → modes → voice → blast radius → cross-agent → skills table → critical behaviors
  - settings.json: model, thinking, max_turns, costCap, permissions (allow/ask/deny), writeScope (allowed/denied), hooks (SessionStart/PreToolUse/PostToolUse/SessionEnd)
  - skills/*.md: frontmatter (name, description) + activate when / specialized knowledge / procedure / outputs / label conventions / examples / escalation / what this skill does NOT do
  - mcp.json: per-server stdio config with env-var references
  - identity/*.yml: github / linear / slack / routing / continuation_timeout_days / secrets
- **The cross-impact patterns**:
  - Adding a Linear label requires updating Protocol #5 + every consuming agent's identity routing
  - Adding a Slack channel requires the agent's settings.json allow list + identity.yml channels list
  - Modifying a hook command requires the router-engineer skill (the hook handler must exist in router/src/hooks/)
  - Changing model/thinking/max_turns rebalances cost — re-check COST_ANALYSIS.md projections
  - Modifying writeScope for one agent may need symmetric updates in other agents' deniedPaths

## Procedure

1. **Read the request carefully.** Identify the target agent + the specific behavior to add/change.

2. **Restate the request back to the human** for confirmation. This is non-negotiable for non-trivial changes. Examples:
   - "Got it — you want Builder-Server's `backend` skill to handle database migrations natively (currently it routes them to a human). Restating: add a `migrations` sub-procedure to `backend.md`, update Builder-Server's CLAUDE.md skill table, add the `migration` label to Protocol #5 registry, update Builder-Server's identity routing. Confirm + I'll open the PR."
   - "Confirming: Marketer should refuse to draft any content with the word 'AI' unless explicitly authorized. That's a new Critical Behavior #13 in Marketer's CLAUDE.md + a PreToolUse validator in settings.json that scans draft content. Confirm + I'll open the PR."

3. **Pause for human confirmation** before proceeding. If the human says "go," continue. If they refine the request, restate again.

4. **Locate the precise files to edit**:
   - Behavior-shape change → CLAUDE.md (the persona)
   - New tool / new MCP / new hook → settings.json + mcp.json
   - New procedural skill or sub-procedure → skills/<name>.md
   - New routing rule / channel / label → identities/<agent>.yml
   - Cross-impact → other agents' identity.yml, Protocol #5 registry, Protocol files

5. **Plan the change set** in your head. Write a draft PR description first (Summary + Rationale + Changes + Cross-impact + Test plan + Risk + Agents affected). The PR description discipline forces clarity before code.

6. **Apply the edits**, following the established file patterns. Use `Edit` for surgical changes, `Write` only for new files or full rewrites.

7. **Run the post-edit hooks** (linting, formatting, schema validation — these fire automatically per `settings.json` PostToolUse).

8. **Verify cross-impact**:
   - Did the change require Protocol #5 (Linear Labels) updates? Did you make them?
   - Did the change affect other agents' routing? Did you update their identity files?
   - Did the change affect cost? Did you re-check COST_ANALYSIS.md?
   - Did the change affect the router? If so, this is a router-engineer skill issue too — bring that skill in or escalate.

9. **Open the PR** via SessionEnd hook (forces `create_pr: true`). The PR description follows the [template in CLAUDE.md](../CLAUDE.md#the-pr-description-template).

10. **Auto-apply labels** per the SessionEnd hook's `auto_apply_conditional_labels` rules:
    - `agent:harness-bot` (always)
    - `meta-self-modify` if paths in `agents/harness/**` (rare — this skill mostly modifies other agents)
    - `router-change` if paths in `router/src/**` (means you escalated to router-engineer)
    - `cross-agent` if files for 2+ agents

11. **Post a Slack notification** to `#harness-engineering` with the PR link + a one-line summary.

12. **If the change materially affects another agent's behavior**, crosspost to that agent's primary Slack channel (per identity.yml `crossposts` map) so future sessions of that agent see the heads-up.

## Outputs

- ONE PR against `dev-team` with all edits in a single change set
- PR description per the canonical template (Summary / Rationale / Changes / Cross-impact / Test plan / Risk / Agents affected)
- PR labels per the auto-apply rules
- Slack notification(s)
- Updated `dev-team-state/projects/<project>/harness/active-changes.md` if the work spans multiple sessions

## Label conventions

PR labels (auto-applied per SessionEnd hook):
- `agent:harness-bot` (always)
- `meta-self-modify` if `agents/harness/**` touched
- `router-change` if `router/src/**` touched (you'd have escalated to router-engineer)
- `cross-agent` if 2+ agents touched

Per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol), tickets that trigger this skill should carry `agent-improvement` + a sub-area label (e.g. `prompt-tweak`, `new-tool`, `new-skill-section`).

## Examples

> **Request**: `@harness-agent @server-agent should be able to handle database migrations natively — right now it always routes them to a human`
>
> **Restate**: "Got it — you want Builder-Server's `backend` skill to handle migrations natively rather than route to a human. Restating the scope:
> 1. Add a `migrations` sub-procedure to `agents/builder-server/skills/backend.md` (when to use; how to author; how to validate).
> 2. Update Builder-Server's CLAUDE.md `backend` skill row to mention migration handling.
> 3. Add `migration` label to Protocol #5 registry (currently not there).
> 4. Update Builder-Server's `identities/builder-server.yml` routing.linear_labels to include `migration`.
> 5. Check whether Guardian needs to be aware (sensitive-paths registry might want migration paths added) — likely a separate Harness session if so.
>
> Cross-impact: Builder-Server + Protocol #5; minor heads-up to Guardian. Risk: low. Effort: small. Confirm + I'll PR."
>
> **(After human confirms)** — open PR with all 4 edits + the Slack heads-up to `#engineering` for Builder-Server's future sessions.

> **Request**: `@harness-agent Marketer needs a stricter check before posting customer testimonials publicly — the current testimonial-permission validator doesn't catch paraphrased quotes`
>
> **Restate**: "Confirming — you want to tighten Marketer's `testimonial_permission_check` validator so paraphrased quotes are also caught, not just verbatim ones. Restating:
> 1. Update `agents/marketer/settings.json` PreToolUse `testimonial_permission_check` validator — currently regex-based; needs to ALSO do a semantic similarity check (embedding-similarity OR LLM-as-judge).
> 2. The semantic check is a NEW hook command — needs router/src/hooks/commands/ to add a `semantic_testimonial_check` handler. → this escalates to `router-engineer` skill in the same PR.
> 3. Update Marketer's CLAUDE.md Critical Behavior #4 (testimonial permission discipline) to note the new check.
> 4. Add an example to `content-writer.md` showing what gets caught.
>
> This is a cross-skill PR (agent-modifier + router-engineer). Cross-impact: Marketer + router. Risk: medium (the semantic check has false-positive risk; need a Test plan with example paraphrased quotes that SHOULD pass and SHOULDN'T). Effort: medium. Confirm + I'll PR."

## Escalation

- **The request requires a brand-new agent**, not modifications to an existing one → switch to `agent-architect` skill. Tell the human: "this is bigger than a tweak — proposing to spawn a new agent instead. Sound right?"
- **The request requires router source code changes** → bring `router-engineer` into the same PR (don't fragment the change).
- **The request requires a Protocol change** → write the protocol update in the same PR (not a separate one) — Protocols are part of the change set.
- **The request conflicts with an existing Critical Behavior or Protocol** → push back with evidence. "What you're asking conflicts with Marketer's Critical Behavior #1 (draft never publish). Do you want to weaken Behavior #1, or is there a different interpretation that doesn't conflict?" Don't quietly implement; conflicts need a deliberate decision.
- **The request would weaken a safety rule** (publish-gate, PR-only, founding-docs gate, sensitive-paths) → mark Risk High in the PR; require the rationale to be explicit in the PR description; flag for two-reviewer convention.
- **The change cascades to >3 agents** → consider whether the underlying pattern should be a Protocol instead. Three+ agents needing the same behavior is a Protocol smell.

## What this skill does NOT do

- **Create new agents** — that's `agent-architect`. New agent = new directory + new identity + new routing + new section in AGENTS.md.
- **Author new skill files from scratch** — that's `skill-author`. This skill MODIFIES existing files; new files go through skill-author.
- **Modify router source code** — that's `router-engineer`. Bring it into the same PR if the change requires both.
- **Touch target project repos** — out of scope; route to the appropriate target-project agent.
- **Auto-merge its own PRs** — humans merge.
- **Bypass the restate-confirm step** for non-trivial changes. The 2-second pause for human confirmation prevents most bad changes.
