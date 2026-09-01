---
name: backend
description: Default skill for backend work. Implements features following the project's stack and conventions (loaded from STACK.md + SYSTEM.md). Runs the full development cycle from CLAUDE.md (Plan → Implement → Self-test → Self-review → Open PR → React → Post-merge). Produces code + tests + migrations + contract updates in the same PR.
---

# Skill — Backend Engineering (default)

## Activate when

- Any Linear ticket assigned to Builder-Server without a more specific tag (i.e. the default)
- `@server-agent` mention in PR / issue comments without a specialized tag
- A Phase-0-created feature ticket (from Strategist's `founding` skill) gets picked up for development — Strategist's `pm` skill produces the full PRD, then Builder-Server's `backend` skill implements it
- Triage bug ticket (from Strategist's `triage` skill) with reproduction + severity

**Refuse to activate** if `STACK.md` or `SYSTEM.md` is missing — recommend Phase 0 / Phase 3 first.

## Specialized knowledge

This skill provides the project-specific knowledge layered on top of the development cycle (defined in CLAUDE.md §"The development cycle"):

- **The stack**: framework, ORM, testing framework, build system. Specifics loaded from `<target-project>/founding/STACK.md`.
- **The system organization**: where this code fits, what components exist, what data flows. From `<target-project>/docs/architecture/SYSTEM.md`.
- **Conventions**: file layout, naming, error handling patterns, module structure, dependency injection patterns (from STACK.md).
- **Migrations**: how to generate, name, apply, reverse. Whether they're auto-generated from entity diffs or hand-written.
- **Database**: connection patterns, transaction boundaries, common query gotchas, indexing patterns.
- **Test patterns**: unit, integration, API. Where each lives. Fixture/factory conventions.
- **API conventions**: REST vs GraphQL split, naming, status codes, error envelopes, versioning.
- **Inter-service communication patterns**: HTTP, message queue, shared DB tables.
- **API contract production**: the contract (OpenAPI / GraphQL SDL / shared types) is a first-class deliverable, updated in the same PR as the code that changes the API surface. See the [API Contract Protocol](../../PROTOCOLS.md#1-api-contract-protocol) for producer responsibilities. Knows the project's `generate_command` (from `.dev-team.yml`) and runs it rather than hand-editing.
- **Third-party API contracts**: when the change integrates an external API, `WebFetch` that provider's own documentation before writing the client — and again before writing the test that asserts its request shape. Two providers solving the same problem often disagree on details that look interchangeable, and a wrong assumption reproduces itself in the test, which then passes.

  Not hypothetical: IRS-46's Anthropic adapter gave each tool result its own `user` message. That is correct for OpenAI and a 400 on Anthropic, which wants every `tool_result` for a turn in one message. Parallel tool calls could never succeed, and the round-trip test asserted the same wrong shape — so CI was green. Priors are not a substitute for the provider's own docs.

## Procedure

This skill **does not have its own procedure** — it follows the development cycle defined in CLAUDE.md §"The development cycle" (Phases 1–8). What this skill *adds* is project-specific knowledge applied during Phase 3 (Implement) and Phase 4 (Self-test).

The cycle phases happen across sessions. Each session does one phase or transitions through closely-coupled phases (e.g. Phase 3 → 4 → 5 → 6 in one session is normal for small features).

**During Phase 2 (Plan)**:
- Read `coding-practices.md` (auto-loaded at session start) for tactical patterns the project has accumulated. The plan should be consistent with those patterns — if it isn't, that's worth flagging in the plan ("deviating from practice X because Y").
- Apply the **simplest-design** rule (CLAUDE.md Critical Behavior #2). The plan picks the simple design; implementation executes it. If the plan grew an abstraction, a config option, or a base class with no current consumer, pause and ask whether it's actually needed *for this story*. Three similar lines in implementation is better than a premature abstraction in the plan.

## Outputs

- PRs targeting the project's default base branch (typically `staging`)
- Migrations with both `up` and `down` directions
- Tests in the project's test directories
- API contract updates (when the API surface changes) in the same PR as the code

## Examples

> **Input** (Linear ticket): "Add an endpoint to export project data as CSV"
>
> **Plan output** (Phase 2): structured plan covering — new route `GET /projects/:id/export.csv`, streaming response with `csv-stringify`, async job + email-when-ready for >10k rows, RFC 4180 quoting + UTF-8 BOM, CSV-injection escape, AC-mapped tests including a 50k-row case. Notes the contract change (new endpoint) and that the contract will be regenerated via `pnpm gen:openapi` in the same PR.
>
> **PR output** (Phase 6): branch `agent/server-bot/eng-1234-csv-export`, 4 commits (route, service, async-job, tests), updated `contracts/openapi.yaml`, PR description with test plan + risk notes + reference to ADR-0023 (the async-export decision).

## Escalation

- Stuck on a test failure after 3 attempts → draft PR + escalate (per Phase 4 rules in CLAUDE.md).
- Architectural ambiguity ("should this live in service A or B?") → ping `@platform-agent` for an ADR.
- Security-sensitive change (auth, payments, PII) → ping `@guardian-agent` for a pre-implementation review **before** coding.
- Plan reveals the work is bigger than the ticket described (a 1-pointer turns into a 5-pointer of cross-cutting changes) → bounce back to Strategist (PM skill) to re-scope.

## What this skill does NOT do

- Modify frontend code (Builder-Client owns the client-side).
- Modify infra files (Platform owns `.github/workflows/`, Dockerfiles, IaC).
- Deploy anything.
- Merge PRs.
- Author or modify the project's founding docs, SYSTEM.md, or ADRs.
- Bypass safety: no `--no-verify`, no skipped tests, no force-push to shared branches.
