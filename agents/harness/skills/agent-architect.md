---
name: agent-architect
description: Create an entirely new agent from scratch — full directory (CLAUDE.md + settings.json + mcp.json + skills/) + identity file + scheduler entries (if any) + meta-doc updates (AGENTS.md / PLAN.md / COST_ANALYSIS.md / README.md). Rarely invoked but high-stakes. Always Opus model; always confirms scope with human before authoring.
---

# Skill — Agent Architect

## Activate when

- `@harness-agent create a new agent for ...`
- `@harness-agent we need an agent that does X` (when X doesn't fit any existing agent)
- `@harness-agent spawn a new agent — <name>`
- Linear ticket with `new-agent` label

## Specialized knowledge

- **The complete fleet** at this moment (auto-loaded at SessionStart) — for pattern-matching against existing agents.
- **The Marketer SPEC.md as a reference template** — Marketer is the most complete spec we have (12 sections; 895 lines); use its shape when authoring a new agent's SPEC.
- **The full set of established patterns**:
  - CLAUDE.md anatomy (mission → modes → voice → blast radius → cross-agent → skills table → critical behaviors)
  - settings.json anatomy (model, thinking, max_turns, costCap, permissions, writeScope, hooks)
  - skill file anatomy (frontmatter + activation + specialized knowledge + procedure + outputs + labels + examples + escalation + does-NOT-do)
  - identity file anatomy (github / linear / slack / routing / continuation_timeout_days / secrets)
  - PROTOCOLS.md updates when the new agent introduces a cross-cutting interaction
- **The cost model** — adding an agent adds ~$50–200/mo to the fleet cost depending on activity level. Re-check COST_ANALYSIS.md projections.
- **The bootstrap-phase question** — when does the new agent come online? Add a new phase to PLAN.md or fit into an existing one.
- **Naming discipline** — single-word names where possible (Harness, Marketer, Guardian, Strategist), kebab-case if multi-word (builder-server). Distinct from existing names. Match the role's primary verb (Forge would have worked for the meta-agent; Harness was the human's pick).

## Procedure

This skill is heavier than the others. Default model is Opus (override via `model_override: opus` in this skill's frontmatter is implicit — the router can route by-skill if configured, otherwise the human asks for Opus). Multi-session work is normal.

### Phase 1 — Scope confirmation (mandatory)

1. **Restate the proposed agent's role** back to the human. What problem does it solve? What are its inputs, outputs, surfaces, blast radius? What does it NOT do?
2. **Justify why an existing agent can't cover this.** "Could Strategist's curator handle this?" → if yes, the answer is `agent-modifier` (add a skill to Strategist), not `agent-architect`. New agents are expensive; reuse existing ones unless the role genuinely doesn't fit.
3. **Confirm the name.** Propose 2–3 candidates; let the human pick. Single-word names preferred.
4. **Pause for explicit human confirmation.** Don't proceed to authoring without it. New agents are too high-stakes to skip the gate.

### Phase 2 — Spec authoring

5. **Author `agents/<name>/SPEC.md`** (the optional but useful reference spec — Marketer has one; not all agents do, but new ones should). 8–12 sections following Marketer's pattern: Identity, Mission, Absorbed roles, Operating modes, Skills, Memory & state, Tools & permissions, Cross-agent handoffs, Voice & style, Failure modes, Implementation notes, Open questions.
6. **Author `agents/<name>/CLAUDE.md`** — the persona. Follow the established anatomy. Lengths: typically 300–500 lines for a substantive agent.
7. **Author `agents/<name>/settings.json`** — model, costCap, permissions, writeScope, hooks. Inherit defaults sensibly:
   - `model`: `claude-sonnet-5` (the fleet default — every existing agent runs it).
     **The ID must appear in `router/src/runtime/modelRates.ts`.** An unpriced model
     is billed at the most expensive rate in that table, so the agent's cost cap
     fires at a fraction of its budget and the session is refused mid-work. The
     router warns about this at boot and at session start; do not ship past the
     warning. If the agent genuinely needs a model with no row yet, add the row in
     the same PR.
   - `thinking.budget_tokens`: 4000-6000 depending on reasoning load
   - `max_turns`: 30 for review-heavy agents, 40-50 for production-heavy
   - `costCap`: estimate based on the agent's expected activity volume
8. **Author `agents/<name>/mcp.json`** — minimum set is Linear + GitHub + Slack; add others per the agent's actual needs.
9. **Author each skill file under `agents/<name>/skills/`** — typically 3–8 skills per agent.

### Phase 3 — Identity + routing

10. **Author `identities/<name>.yml`** — bot identity placeholders, routing rules, secret references.
11. **Decide which Linear labels route to the new agent.** If new labels are needed, also update [Protocol #5](../../PROTOCOLS.md#5-linear-labels-protocol)'s registry.
12. **Decide which Slack channels are primary + alerts + crossposts.**

### Phase 4 — Scheduler

13. **If the agent has scheduled jobs**, add them to `scheduler/schedules.yml` with `enabled: false` (default-off discipline) and an appropriate `requires_project_phase` gate.

### Phase 5 — Meta-doc updates

14. **Update `AGENTS.md`**:
    - Increment the agent count in headers / tables
    - Add a roster entry for the new agent
    - Update the "What goes where" mental model if the new agent introduces a new scope/responsibility
15. **Update `PLAN.md`**:
    - Add a phase step for deploying the new agent (existing phase or a new one)
    - Add verification tests for the new agent
16. **Update `COST_ANALYSIS.md`**:
    - Add the new agent's cap to the cap table
    - Recompute fleet totals
    - Note any new cost dynamics the agent introduces
17. **Update `README.md`**:
    - Update agent count
    - Add a sentence to the architecture-in-one-paragraph if the new agent changes the high-level story
18. **Update `router/ARCHITECTURE.md`** if the new agent introduces unique runtime behavior (e.g. unique routing rules, special hooks, novel data flow). Most new agents do NOT require ARCHITECTURE.md changes — the router handles them generically.

### Phase 6 — Protocol additions (if applicable)

19. **If the new agent introduces a cross-cutting interaction**, add a new protocol to `agents/PROTOCOLS.md`. Most new agents don't need this; some do (e.g. Marketer introduced Protocols #3 + #4).

### Phase 7 — PR composition

20. **Compose ONE coherent PR** with all files above. Effort is multi-day; use the active-changes log + draft-PR resumption pattern (see CLAUDE.md §"Session interruption and resumption") for multi-session work.
21. **PR description must include**:
    - Why this agent (the problem it solves; why existing agents don't cover)
    - The full file list (typically 15-30 files added/modified)
    - Cross-impact (every other agent's identity routing potentially affected if new labels were added)
    - Test plan with specific verification tests (the ones added to PLAN.md)
    - Risk: typically Medium (new agent introduces new failure modes); High if the agent has novel writeScope
22. **Apply labels**: `agent:harness-bot`, `cross-agent` (always — new agents affect the fleet), often `router-change` if router/ARCHITECTURE.md updates, often `meta-self-modify` is NOT applied (new agents don't modify Harness itself).

## Outputs

- A new `agents/<name>/` directory with full config set
- A new `identities/<name>.yml`
- Updated `AGENTS.md`, `PLAN.md`, `COST_ANALYSIS.md`, `README.md`
- Possibly updated `router/ARCHITECTURE.md` (if novel runtime behavior)
- Possibly updated `agents/PROTOCOLS.md` (if cross-cutting)
- Possibly updated `scheduler/schedules.yml` (if scheduled jobs)
- ONE PR with all changes
- Slack post in `#harness-engineering` with PR link + summary

## Label conventions

- PR labels: `agent:harness-bot`, `cross-agent` (always for new agents)
- Linear ticket trigger label: `new-agent`

## Examples

> **Request**: `@harness-agent create a new agent for handling customer onboarding — emails, training videos, the welcome flow`
>
> **Phase 1 (scope confirm)**:
> "Before I author a new agent, let's check if existing agents cover this:
> - Marketer's `email-lifecycle` skill handles lifecycle emails (including onboarding emails). So onboarding emails are already Marketer's territory.
> - Training videos are typically a humans-authored asset; would the new agent's job be to BRIEF the videos (like Marketer's creative-brief skill)? If yes, that's a Marketer skill, not a new agent.
> - The 'welcome flow' inside the app is product behavior — Strategist's PM skill handles writing the PRD; Builders implement.
>
> What's the part that existing agents don't cover? Is there a piece I'm missing? My read is `agent-modifier` (add an `onboarding-orchestrator` skill to Marketer) is the right fit, not `agent-architect`. Let me know if you see it differently."
>
> **(If human pushes back with new info that justifies a new agent, proceed to Phase 2.)**
>
> **(If human agrees existing agents cover it, switch to `agent-modifier` for the Marketer skill.)**

## Escalation

- **The proposed agent overlaps with existing agents by >40%** → push back; propose `agent-modifier` instead. New agents are expensive; reuse beats duplicate.
- **The proposed agent would have novel writeScope or novel hook commands** → loop in the human about the architecture implications. Novel runtime behavior may require router changes.
- **The proposed agent's role is genuinely vague** ("we need an agent for general work") → request a sharper definition before authoring. Vague agents become bloated and conflict-prone.
- **The proposed agent would write to dev-team/** (like Harness) → this is a major architectural decision (currently only Harness has that scope). Strict scrutiny required; escalate to a human before authoring.
- **The proposed agent's primary skill duplicates a Protocol** (e.g. an "API contract enforcer" — already covered by Protocol #1) → the right fix is to strengthen the Protocol, not to add an agent.

## What this skill does NOT do

- **Modify existing agents** — that's `agent-modifier`.
- **Add a skill to an existing agent** — that's `skill-author`.
- **Author the actual deploy steps for the new agent** — bootstrap activities (creating the GitHub App, registering the Linear agent, creating the Slack app, provisioning Infisical entries) are HUMAN actions. The PR adds the *config* files; the human deploys + creates the platform identities.
- **Fast-track the scope confirmation step.** Even for "obvious" new agents, the restate-confirm gate applies — new agents are too expensive to author on a misread.
- **Author a SPEC.md when the agent is small** — for tiny agents (rare; not yet seen), SPEC.md can be skipped. But for typical agents (3+ skills), SPEC.md is highly recommended as the long-form reference.
