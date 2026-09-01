---
name: triage
description: First responder for incoming bugs and feature requests. Classifies (bug / feature / question / duplicate / spam). Reproduces bugs by reading code + logs. Structures Linear tickets with reproduction steps + severity + routing recommendation. Routes positive customer feedback to Marketer's testimonial pipeline.
---

# Skill — Triage

## Activate when

- Linear "Triage" queue — any unassigned ticket lands here
- Slack: `@strategist-agent triage this` on a thread containing a bug report or feature request
- Forwarded support email (via MCP into Linear) — same path as Linear triage

## Procedure

1. **Classify** — bug / feature request / question / duplicate / spam.

2. **For bugs**:
   - Attempt reproduction by reading the affected code paths + recent logs (if accessible via MCP).
   - Write reproduction steps in the ticket (numbered, exact).
   - Assess severity using `dev-team-state/projects/<project>/strategist/severity-rubric.md` (P0 down to P3).
   - Route: assign to the right Builder bot (`@server-agent` for backend, `@client-agent` for frontend) or leave unassigned with a routing comment if ambiguous.

3. **For feature requests**:
   - Link to similar prior tickets (deduplication).
   - If scope is non-trivial, set up a handoff to the `pm` skill: post a comment "PRD needed — kicking off `pm`."
   - For tiny requests (typo fix, copy change), route directly to the appropriate Builder with a small ticket.

4. **For questions**:
   - Answer directly if within reach (docs you can read, code you can read).
   - Escalate to a human or another agent if you can't (e.g. `@server-agent what's the rate limit on /exports?`).

5. **For duplicates**:
   - Link both tickets, close the new one (gated — propose the close, surface the slash command), leave a comment.

6. **Normalize labels** per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol). Triage is the **backstop** for under-labeled tickets — particularly tickets humans create through the Linear UI without remembering the agent-system labels.
   
   Check that the ticket has:
   - **At least one type label** (`bug` / `feature` / `chore` / `documentation`) — required
   - **At least one area label** if the ticket is code-related (`backend` / `frontend` / `mobile` / `infra` / `design`) — required for code tickets
   - **Exactly one severity label** if `bug` (`P0` – `P3`) — required
   - **An activation label** matching the work shape (`prd` / `analysis` / `research` / `architecture` / `infra` / `campaign` / etc.) — recommended; tells the right agent's skill how to activate
   
   For missing labels: add them with a brief comment explaining why. Example:
   > "🏷️ Triage label normalization: added `feature` + `backend` + `needs-contract`. This ticket touches the API surface, so Builder-Server's `contract-design` skill should propose a contract before implementation tickets are created."
   
   **Never silently change** existing labels. If a label looks wrong, add a comment proposing the change and tag the appropriate agent or human for confirmation.
   
   For label conflicts (e.g. both `feature` and `bug`, multiple severities), resolve per the protocol's conflict-resolution rules and explain in the comment.

7. **Maintain `dev-team-state/projects/<project>/strategist/triage-known-issues.md`** — recurring patterns ("third report of inverter timeout this week — escalate to the team lead").

8. **Route to the Product-Marketing shared surface** per the [Product-Marketing Sync Protocol](../../PROTOCOLS.md#3-product-marketing-sync-protocol):
   - Customer signals (pain, praise, request) → append to `_shared/strategist-marketer/customer-signal-log.md` with source, theme, strength, routing recommendation.
   - **Positive testimonial candidates** (a customer says something glowing about the product) → append to `_shared/strategist-marketer/testimonial-pipeline.md` Received stage. Flag the permission-collection need.

## Output format (Linear ticket update after triage)

```
**Triage classification**: bug / feature / question / duplicate / spam
**Severity** (bugs only): P0 / P1 / P2 / P3
**Reproduction** (bugs only):
1. <step>
2. <step>
3. <step>
**Hypothesis**: <what's likely causing this, with code path if known>
**Routing**: assigned to @<agent-name> / unassigned (reason: <why>)
**Linked tickets**: ENG-XXX (similar), ENG-YYY (potential parent)
**Triage by**: @strategist-agent
```

## Examples

> **Input** (forwarded email): "Exports are slow, taking 5 minutes for what used to take 30 seconds."
>
> **Output**: Linear ticket with —
> - Reproduction: 1. Log in as growth-tier user with >5k rows. 2. Open Dashboard. 3. Click Export → CSV. 4. Time elapsed.
> - Severity P2 (degraded performance, not blocked).
> - Classification: `perf-regression`.
> - Hypothesis: recent migration may have removed an index — see ENG-1098 from last week.
> - Assigned to `@server-agent` with comment "Triage by @strategist-agent — please verify hypothesis before fixing."
> - Customer signal logged to `_shared/.../customer-signal-log.md` (theme: speed regression, strength: 1 explicit, watch for more).

> **Input** (positive feedback in support thread): "Your CSV export saved my Saturday morning."
>
> **Output**: 
> - Acknowledge in-thread (handled by the human, not Strategist).
> - Append to `_shared/strategist-marketer/testimonial-pipeline.md` Received stage:
>   ```
>   ## Received
>   - [2026-11-12] Email from <customer>, re: ENG-1234 — "Your CSV export saved my Saturday morning."
>     Permission: not yet requested
>     Marketing interest: high (speed/Saturday theme matches narrative)
>     Triage by: @strategist-agent
>   ```

## Escalation

- Can't reproduce → assign to human with a "can you give me more info" comment.
- Severity unclear → default one level higher than your guess and flag for human review (better to over-triage than miss a P0).
- Customer follow-up required → never reply to the customer directly. Tag the human support owner.
- Bug looks security-relevant → escalate to `@guardian-agent` (security skill) before classifying severity yourself.

## Cross-agent handoffs

- Reproducible bug → `@server-agent` / `@client-agent` based on code area
- Non-trivial feature request → `pm` skill in this same agent
- Positive customer feedback → `_shared/strategist-marketer/testimonial-pipeline.md` (Marketer is primary owner)
- Security-relevant → `@guardian-agent`
- Architectural concern → `@platform-agent` (architect)

## What this skill does NOT do

- Reply to customers directly (humans do that).
- Move ticket status autonomously (gated — propose the slash command).
- Fix the bug (Builder agents do that).
- Make product decisions about feature requests (PM skill does that after triage hands off).
