---
name: qa
description: Quality assurance — coverage check, missing-test detection, bug-repro reuse. Auto-fires on every PR with code changes. Owns the integration test for the API Contract Protocol (proving producer + consumer actually meet at the contract). Writes test files for trivial coverage gaps; routes substantive missing-test issues to the responsible Builder.
---

# Skill — QA

## Activate when

- Auto-fires on every PR with code changes. Step 0 below decides the tier — skip, light or deep.
- Linear bug assignment (`@guardian-agent reproduce ENG-1234`)
- `@guardian-agent coverage <path>` for explicit invocation

## Specialized knowledge

- **The project's coverage philosophy** (threshold, what to cover, what's exempt — loaded from `STACK.md`)
- **Test-pattern recognition**: unit, integration, API/contract, e2e. Where each lives and which to write for what
- **Integration-test ownership** per the [API Contract Protocol](../../PROTOCOLS.md#integration-verification): when a feature crosses the API boundary, QA owns the e2e test that exercises the real endpoint through the real client path
- **Common test gaps**: error paths missing, edge cases (empty / null / large / boundary) missing, async race conditions untested, retry logic untested
- **Flake detection**: distinguishing intermittent failures from deterministic ones

## Step 0 — classify the path tier (PR-triggered only)

Do this FIRST, before reading any code. It decides how deep the rest of the scan
goes and whether a comment is posted at all, and it is the reason the tier table is
loaded into this session.

1. **Get the changed files.** The session's `[PR context]` header names the repo and
   PR number. Use `pull_request_read` (`get_files`) on it. The local checkout is on
   the BASE branch and does not have the changes — do not `git diff` for this.
2. **Match every changed path** against `agents/guardian/sensitive-paths.yml`, which
   is in this session's context.
3. **Pick the tier**, per AGENTS.md "Guardian auto-trigger — three-tier path scan":

   | Tier | When | Scan | Comment |
   |---|---|---|---|
   | **deep** | ANY changed path matches a `patterns` entry | full QA + threat-model diff + auth/authz review + perf + compliance | **always**, even "all clear" |
   | **skip** | EVERY changed path matches the `skip` list (docs, `*.md`, CODEOWNERS, LICENSE) | none | none |
   | **light** | anything else | quick coverage, dep-CVE, secret leak, design-system compliance | only if findings |

   Deep wins. A PR touching both `docs/**` and a deep path is deep — the skip list
   spares a docs-only PR, it is not an escape hatch.

4. **Say which tier you picked and why** at the top of the review comment, naming the
   matched glob. A deep scan nobody can tell happened is worth as much as one that
   did not run — which is exactly what this step replaced.
5. **If a changed path looks sensitive and matches NO pattern**, that is a
   sensitive-path candidate: scan it at deep tier anyway, and raise the addition per
   the [Sensitive-Paths Protocol](../../PROTOCOLS.md#2-sensitive-paths-protocol).
   You own that file; a producer proposing is the other half of the same loop.

## Procedure (PR-triggered)

1. Identify what changed; map changes to test surfaces (component / endpoint / migration / etc.)
2. Check existing coverage on the changed code paths. Where coverage drops below the project threshold, flag the specific paths.
3. Inspect new code for: missing tests on happy + edge + error paths.
4. For contract-touching changes, verify the integration test exists or is being added in the same PR.
5. **Write missing tests in low-risk cases** — open a small follow-up PR with tests; tag `agent:guardian-bot`, type `Improvement`, area as relevant.
6. **Route substantive missing-test issues to the responsible Builder** — Linear ticket with: area, type `Feature` or `Bug`, severity if applicable.
7. Aggregate findings into the unified Guardian review comment.

## Outputs

- Findings in the unified Guardian review comment
- Follow-up test PRs for trivial coverage gaps
- Linear tickets for substantive missing-test issues, assigned to the relevant Builder

## Label conventions

When creating tickets for substantive missing-test issues, per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol):
- Type: `Bug` (broken test) or `Improvement` (coverage gap)
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
