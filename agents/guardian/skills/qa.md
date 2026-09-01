---
name: qa
description: Quality assurance — coverage check, missing-test detection, bug-repro reuse. Auto-fires on every PR with code changes. Owns the integration test for the API Contract Protocol (proving producer + consumer actually meet at the contract). Writes test files for trivial coverage gaps; routes substantive missing-test issues to the responsible Builder.
---

# Skill — QA

## Activate when

- Auto-fires on every PR with code changes (Light or Deep tier)
- Linear bug assignment (`@guardian-agent reproduce ENG-1234`)
- `@guardian-agent coverage <path>` for explicit invocation

## Specialized knowledge

- **The project's coverage philosophy** (threshold, what to cover, what's exempt — loaded from `STACK.md`)
- **Test-pattern recognition**: unit, integration, API/contract, e2e. Where each lives and which to write for what
- **Integration-test ownership** per the [API Contract Protocol](../../PROTOCOLS.md#integration-verification): when a feature crosses the API boundary, QA owns the e2e test that exercises the real endpoint through the real client path
- **Common test gaps**: error paths missing, edge cases (empty / null / large / boundary) missing, async race conditions untested, retry logic untested
- **Flake detection**: distinguishing intermittent failures from deterministic ones

## Procedure (PR-triggered)

1. Identify what changed; map changes to test surfaces (component / endpoint / migration / etc.)
2. Check existing coverage on the changed code paths. Where coverage drops below the project threshold, flag the specific paths.
3. Inspect new code for: missing tests on happy + edge + error paths.
4. For contract-touching changes, verify the integration test exists or is being added in the same PR.
5. **Write missing tests in low-risk cases** — open a small follow-up PR with tests; tag `agent:guardian-bot`, type `chore`, area as relevant.
6. **Route substantive missing-test issues to the responsible Builder** — Linear ticket with: area, type `feature` or `bug`, severity if applicable.
7. Aggregate findings into the unified Guardian review comment.

## Outputs

- Findings in the unified Guardian review comment
- Follow-up test PRs for trivial coverage gaps
- Linear tickets for substantive missing-test issues, assigned to the relevant Builder

## Label conventions

When creating tickets for substantive missing-test issues, per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol):
- Type: `bug` (broken test) or `chore` (coverage gap)
- Area: `backend` / `frontend` / `mobile` per the affected code

## Examples

> **Finding**: "PR adds `POST /exports` endpoint. No test exercises the 409 (export-already-running) path. Recommend adding a test in `tests/api/exports.spec.ts` that triggers the conflict. Routing to `@server-agent` as follow-up ENG-XXXX."

## Escalation

- Test failures aren't reproducible locally but are reproducible in CI → ping `@platform-agent` (DevOps skill) — possibly an infra/flake issue.
- The PR's test coverage looks fine but *behavior* coverage feels wrong (untested user flow) → call it out, recommend a Strategist-PRD review of AC.
- Contract integration test is missing for an API-boundary feature → block in the review comment ("contract-integration test is required for API-boundary features per the API Contract Protocol — must be added before merge").

## What this skill does NOT do

- Write substantive feature tests (Builders do that as part of the dev cycle).
- Decide test strategy at the project level (that's Builders + humans).
- Disable or skip flaky tests as a workaround.
