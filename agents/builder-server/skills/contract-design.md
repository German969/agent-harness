---
name: contract-design
description: Propose API contracts during planning, before implementation. Triggered by Strategist when a PRD is flagged `needs-contract`, or by a CCP that requires backend redesign. Output is a *proposed contract* (OpenAPI / GraphQL SDL / shared types), not code. Reviewed by Builder-Client (consumability) and Platform (cross-service consistency). On agreement, becomes contract v1; implementation tickets follow.
---

# Skill — Contract Design (planning phase)

## Activate when

- Strategist (PM skill) sends a **contract design request** during planning — PRD flagged `needs-contract`.
- A Contract Change Proposal (CCP) is raised during development that requires Builder-Server to redesign part of the contract (per the [API Contract Protocol](../../PROTOCOLS.md#contract-evolution-during-development)).
- Explicit human invocation: `@server-agent propose contract for <feature>`.

This skill runs **before** implementation. The output is a *proposed contract* — the API shape — not code. It's how Builder-Server is "involved from the start" rather than handed a finished spec to implement later (per the [API Contract Protocol](../../PROTOCOLS.md#contract-design-during-planning)).

## Specialized knowledge

- **API design judgment**: resource modeling, endpoint granularity, REST vs GraphQL trade-offs for the specific feature, pagination/filtering/sorting conventions, error-envelope design, idempotency, versioning.
- **Feasibility grounding** — the proposed shape must be efficiently implementable against the real data model. You know the schema, so you won't propose a contract that requires an N+1 query storm or an impossible join.
- **Contract-precision discipline** (per the [API Contract Protocol](../../PROTOCOLS.md#what-precise-means--contract-content-requirements)): every operation fully specified — request, response, every error shape, examples, auth, conventions. No `any`, no untyped objects, no "see the code."
- **Versioning + changelog conventions** — every contract change carries a version bump and a changelog entry (per the protocol).

## Procedure

1. **Read the PRD** and the API boundary it describes. Note what the feature must achieve from the user's perspective.
2. **Read existing contract + conventions** so the new design is consistent with what's already there. Skim related endpoints; note pagination/filtering/error patterns already in use.
3. **Read SYSTEM.md** for the architectural shape — does this fit a documented pattern, or does it create a new one?
4. **Draft the proposed contract** in the project's contract format (OpenAPI / GraphQL SDL / shared types). Fully specified:
   - Method + path (REST) or operation name + type (GraphQL)
   - Auth requirements (which roles/scopes)
   - Request: params, query, body schema — fully typed
   - Response: success schema(s) per status code
   - Error responses: every error shape the client must handle
   - Examples: at least one request + response example per operation
   - Pagination/filtering/sorting conventions if applicable
   - Stability markers (`@deprecated` annotations, version)
5. **Ground it in feasibility**: sanity-check each operation against the data model. If a clean API shape would be expensive to implement, note the trade-off in the proposal — don't quietly choose the expensive option.
6. **Post the proposed contract for review**:
   - `@client-agent` reviews for **consumability** — is this easy to integrate? Are the error cases sufficient? Is pagination sane for the UI?
   - `@platform-agent` (architect skill) reviews for **cross-service consistency** — does this fit existing conventions? Architectural concerns?
   Post in the PRD's Linear ticket / Slack thread with a clear "review needed" call-out and tag both agents.
7. **Iterate** on review feedback. Push back if Builder-Client's consumability concerns conflict with feasibility (and let Platform tiebreak per the [API Contract Protocol](../../PROTOCOLS.md#contract-evolution-during-development) if needed).
8. **On agreement**, commit the contract as the **agreed v1** to the path configured in `.dev-team.yml` → `api_contract.path`, with a changelog entry. Signal Strategist that implementation tickets can be created.
9. **End the session.** Implementation work happens later via the `backend` skill.

## Outputs

- Proposed contract committed to `<target-project>/<contract-path>` (as design artifact, ahead of implementation)
- Changelog entry in `<target-project>/<contract-changelog-path>` establishing v1 (or v(N+1) on a CCP)
- Summary comment on the PRD/epic linking the contract + flagging it as "v1 agreed" or "pending review"

## Examples

> **Input** (contract design request): PRD for "project data export" needs an API.
>
> **Proposed contract**:
> - `GET /projects/{id}/exports` (list prior exports, paginated)
> - `POST /projects/{id}/exports` (create an export job → returns `202` + job id)
> - `GET /exports/{jobId}` (poll status → `200` with status enum + download URL when ready)
> - Error shapes for 401/403/404/409 (export already running)
> - Examples for each
> - **Feasibility note**: chose async job pattern because synchronous export of >10k rows would exceed the request timeout (30s per ADR-0007). Polling is the consumer's cost; we don't have a streaming gateway today.

## Escalation

- The PRD is too vague to design a contract → bounce to `@strategist-agent` (PM skill) for clarification.
- The clean API shape conflicts with an architectural constraint → raise with `@platform-agent` (architect) before finalizing.
- Builder-Client vetoes the proposed shape on consumability grounds → iterate; if a genuine impasse, `@platform-agent` is the tiebreaker per the [API Contract Protocol](../../PROTOCOLS.md#contract-evolution-during-development).
- The feature really needs a separate service — not just an endpoint in the existing service → flag for `@platform-agent` (architect skill, ADR).

## What this skill does NOT do

- Write implementation code (that's `backend`; happens *after* the contract is agreed).
- Decide product-level scope (Strategist's `pm` skill does that).
- Make cross-service consistency calls unilaterally (Platform reviews; ties broken by Platform).
- Modify the contract in place after v1 is agreed *without raising a CCP* — mid-development changes go through the [contract evolution](../../PROTOCOLS.md#contract-evolution-during-development) protocol.
