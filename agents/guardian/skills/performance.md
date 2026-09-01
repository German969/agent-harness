---
name: performance
description: Performance regression detection — pattern-based scan (N+1 queries, render thrash, missing indices, unbounded list ops) + benchmark-based (when the project has perf benchmarks in CI). Reactive — fires on perf-tagged PRs or paths in perf-sensitive-paths.yml. Routes substantive perf fixes to Builders.
---

# Skill — Performance

## Activate when

- Linear `perf` tag
- Perf-regression CI alert (when the project has perf benchmarks in CI)
- Paths in perf-sensitive areas (defined in `agents/guardian/perf-sensitive-paths.yml`)
- `@guardian-agent perf-profile <endpoint>` for explicit invocation
- Scheduled monthly baseline review

## Specialized knowledge

- **Reading query plans** (PostgreSQL `EXPLAIN ANALYZE`), identifying full-table scans, missing indices, N+1 patterns
- **Frontend perf**: render thrash, bundle size regressions, oversized assets, missing memoization where it matters (and ignoring where it doesn't)
- **Benchmark interpretation**: signal vs noise, baseline drift, real regressions
- **Common backend perf gotchas**: synchronous I/O in async paths, unbounded list operations, missing pagination, eager loading entire trees
- **Pattern library** at `dev-team-state/global/guardian/perf-pattern-library.md` (cross-project observations)

## Procedure

1. **For PR-triggered**: scan the diff for known perf-regression patterns:
   - The N+1 list (loops calling find/query inside)
   - The eager-load list (fetching whole trees when partial data would do)
   - The bundle-bloat list (importing whole libraries when targeted imports suffice)
   - The synchronous-I/O list (await chains that could parallelize)
2. **If the project has benchmarks**, run them on the branch vs. baseline; flag regressions > threshold.
3. **Categorize**: regression-confirmed (real data) / suspected (pattern-only) / pattern-only-low-confidence.
4. For confirmed regressions, post the **before/after numbers** and the proposed fix direction.

## Outputs

- Findings in the unified Guardian review comment
- `<target-project>/docs/perf/reports/<date>-<slug>.md` for confirmed regressions
- Linear tickets routing substantive perf fixes to the relevant Builder
- Updated `dev-team-state/projects/<project>/guardian/perf/baseline.md` after intentional baseline changes

## Label conventions

When creating tickets per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol):
- Type: `bug` (regression) or `chore` (optimization)
- Area: relevant (`backend` / `frontend` / `mobile`)
- `perf` (activates relevant agent's perf-skill consciousness)
- Severity: based on user impact (P0 if outage-level; P2 typical)

## Examples

> **Finding**: "Perf-suspected: the new `/exports/list` endpoint at `server/services/exports/exports.service.ts:42` calls `findOne` in a loop over the project list (N+1). At 500 projects per user (90th percentile), this is ~500 round trips. Recommend a single `find` with `IN (...projectIds)` and a map. Routing to `@server-agent`."

## Escalation

- **Regression confirmed but root cause non-obvious** → ping `@platform-agent` (architect skill) for deeper analysis.
- **Production perf incident** → already handled by Platform's `incident-response` skill, not Guardian.
- **Benchmark infrastructure itself is broken** (flaky benchmarks, no baseline available) → ping `@platform-agent` (DevOps skill).

## What this skill does NOT do

- Fix substantive perf issues (Builders do).
- Decide perf SLOs at the product level (PM + humans do that).
- Run load tests against production (that's a deliberate exercise, not routine PR review).
- Profile production traffic (read-only access to telemetry only).
