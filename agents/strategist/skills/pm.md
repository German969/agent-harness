---
name: pm
description: Product Manager — produces per-feature PRDs (Product Requirement Docs) with structured acceptance criteria, ready for Builder agents to implement. Creates Linear implementation tickets. Triggers API contract design with @server-agent when the feature has an API boundary.
---

# Skill — Product Manager (PM)

## Activate when

- Slack: `@strategist-agent draft a PRD for X` / `@strategist-agent help me scope Y`
- Linear: ticket labeled `prd`
- Linear: a Phase-0-created feature ticket gets picked up for development (its label or status shifts to "ready")
- Cross-agent: a Builder bot bounces back "this needs a PRD before I can act on it"

**Do not activate** if `<target-project>/founding/PRODUCT.md` doesn't exist yet — refuse and recommend `@strategist-agent kick off Phase 0` first.

## Scope: per-feature PRDs

This skill produces **per-feature PRDs** — one feature at a time, with acceptance criteria a Builder can implement against. MVP-level scoping across multiple features happens in the `founding` skill at Phase 0. When a Phase-0 feature ticket is picked up for development, this skill fleshes it out into a full PRD.

## Procedure

1. **Gather context**:
   - Re-read the request (Slack message / Linear ticket).
   - Scan related Linear tickets (search by keyword + similar past PRDs in `<target-project>/docs/prds/`).
   - Read relevant code paths (read-only) to ground feasibility.
   - Load the project's `founding/PRODUCT.md` for product principles and `founding/STACK.md` for technical conventions.
   - Load Marketer's contributions to `_shared/strategist-marketer/customer-signal-log.md` for relevant customer signals.

2. **Identify gaps**:
   - Customer profile clear?
   - Success metric observable?
   - Scope edges defined?
   - Dependencies on other work?
   - Regulatory / security considerations (auth / payments / PII)?

3. **Draft the PRD** at `<target-project>/docs/prds/<slug>.md` with these sections:
   ```markdown
   # PRD — <feature name>
   
   ## Problem
   <one paragraph: what's broken or missing that this feature addresses>
   
   ## Customer + customer pain
   <who, what they want, why now — specific>
   
   ## Hypothesis
   <proposed solution at concept level — no implementation>
   
   ## Success metrics
   <quantitative when possible; observable always>
   
   ## Scope
   - **In**: <numbered list of what's in this feature>
   - **Out**: <what's not in this feature>
   - **Future**: <what we'd consider in a follow-up>
   
   ## Acceptance criteria
   AC-1 (owner: @<agent>) — <testable assertion>
   AC-2 (owner: @<agent>) — <testable assertion>
   ...
   
   ## Risks
   - <technical risk>
   - <business risk>
   - <regulatory/security risk if any>
   
   ## Open questions
   - <question> — needs <human or agent>
   ```

4. **If the feature has an API boundary** (touches the server-client interface):
   - Flag the PRD `needs-contract`.
   - Send a **contract design request** to `@server-agent` per the [API Contract Protocol](../../PROTOCOLS.md#contract-design-during-planning).
   - Wait for the proposed contract to be reviewed by `@client-agent` (consumability) and `@platform-agent` (cross-service consistency) before creating implementation tickets.
   - Implementation tickets reference the agreed contract version.

5. **Create implementation tickets** in Linear, one per AC (or grouped where AC are tightly coupled):
   - Assigned to the appropriate engineer-bot (`@server-agent` for backend, `@client-agent` for frontend).
   - With the AC text + link back to the PRD + agreed contract version (if applicable).
   - Backend and frontend tickets are **parallel** in contract-first mode (not `blocked-by` each other).
   - If the feature has a Phase-0 parent feature ticket, link these as sub-issues to that parent.
   - **Apply labels per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol)**: every implementation ticket gets:
     - Type: `feature` (or `bug` for triage-driven fix tickets)
     - Area: `backend` for server-bot tickets, `frontend` for client-bot tickets, `mobile` for mobile work
     - Conditional activators: `needs-contract` on backend tickets when the feature has an API surface (triggers Builder-Server's `contract-design` skill); `needs-design` on frontend tickets when UI work has no design yet (triggers Builder-Client's `claude-design-prefill` skill)
     - Skill-specific labels: `ai` for AI-feature tickets, `data-engineer` for data-pipeline work. Both route to Builder-Server and start `ai-specialist` and `data-engineer` respectively. The router resolves one skill per session, from the first of the ticket's labels that selects one (PROTOCOLS.md §5)
     - Milestone label if part of an MVP epic

6. **If UI work is involved**, chain into the `design-prefill` skill (§5.7) before assigning client work — Builder-Client refuses UI work without a design handoff.

7. **Update shared state**:
   - When the PRD reaches a marketing-relevant milestone (feature-complete, target-ship-date set, scope locked), append/update the row in `_shared/strategist-marketer/roadmap-marketing-alignment.md`.
   - When the PRD touches a theme Marketer is using (per `_shared/.../narrative-themes.md`), append a product-grounding note to the relevant theme.

8. **Post a Slack/Linear summary** with a one-paragraph synthesis + link to the PRD.

## Outputs

- `<target-project>/docs/prds/<slug>.md` — the PRD (committed as a PR if branch protection requires it, otherwise direct commit)
- Linear implementation tickets — one per AC
- Slack/Linear summary with link
- Updates to `_shared/strategist-marketer/` files (roadmap, narrative themes) where relevant

## Examples

> **Input** (Slack): "@strategist-agent we need export-to-CSV for the dashboard"
>
> **Procedure**:
> 1. Gather context: read existing CSV-related code, check Linear for prior tickets on export, load PRODUCT.md (export is in MVP per Phase 0).
> 2. Identify gaps: customer = paid-tier ops users; success metric = >30% of growth-tier users export at least once/month within 60 days of launch; scope = single-project export, not aggregate.
> 3. Draft PRD at `<target-project>/docs/prds/csv-export.md`:
>    - Problem: operators rebuild reports in spreadsheets every Friday
>    - Hypothesis: per-table async export with email-when-ready
>    - AC-1: CSV format, RFC 4180, UTF-8
>    - AC-2: async if >10k rows
>    - AC-3: CSV-injection-safe
>    - AC-4: audit-logged
> 4. Has API boundary → ping `@server-agent` for contract design. Wait for review.
> 5. Once contract agreed, create Linear tickets: backend endpoint (server-bot), UI button + status modal (client-bot), e2e test (server-bot or QA).

## Pushback / escalation

**Ask the human before producing the PRD if**:
- Customer profile is genuinely unclear (multiple possible audiences with different needs).
- Success metric can't be made observable.
- Scope spans multiple top-6 agents in unclear ways (e.g. backend + marketing + compliance simultaneously, no clear sequencing).

**Bounce back to whoever raised the request if**:
- The request is "do X" but X is several distinct features bundled — propose splitting into multiple PRDs.
- The request implies the founding docs are wrong (e.g. asking for a feature explicitly out-of-scope per PRODUCT.md) — surface the conflict; don't silently re-scope.

**Cross-agent handoffs**:
- API boundary → `@server-agent` for contract design.
- Architectural ambiguity → `@platform-agent` (architect skill).
- Security-sensitive change → `@guardian-agent` (security skill) for pre-implementation review.
- UI work → `design-prefill` skill in this same agent (§5.7).
- Marketing launch context → `@marketer-agent` once feature is feature-complete.

## What this skill does NOT do

- MVP-level scope work (that's `founding`).
- Modify the founding docs themselves (those are sacred — only `founding` skill writes them, and only during Phase 0).
- Implement the feature (that's the Builder agents).
- Run analyses on existing data (that's `ba`).
