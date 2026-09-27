---
name: data-engineer
description: Data pipelines, time-series schemas, dbt-style transformations, analytics infrastructure. Migration safety on hot tables — never `ALTER TABLE` without considering locks; backfills are bounded and resumable. Operates inside the standard development cycle (CLAUDE.md), with data-engineering-specific additions in Phase 2 (plan) and Phase 4 (test). Different from Strategist's BA — BA *analyzes*, this skill *builds the substrate*.
---

# Skill — Data Engineer

## Activate when

- Linear ticket with label `data-engineer`. *Today this routes to Builder-Server but starts `backend`: the label is not in `LABEL_SKILLS`, and no selector reaches `data-engineer` (HAR-22).*
- Paths in the diff matching `db-series/`, `etl/`, `dbt/`, `pipelines/`, `analytics/`
- Migration files affecting time-series or analytics tables (vs. transactional CRUD tables, which `backend` handles)

## Specialized knowledge

- **Time-series schema design**: hypertables (TimescaleDB), partitioning strategies, retention policies, continuous aggregates.
- **Migration safety on large tables**: never `ALTER TABLE` on hot tables without a `CONCURRENTLY` pattern or a table-rewrite plan. Adding NOT NULL on a populated column requires backfill + constraint check pattern, not a direct DDL.
- **ETL idempotency**: pipelines must be re-runnable. Every transform must have a deterministic ID and behave the same on re-run.
- **dbt-style conventions** if used: model layering (staging → intermediate → marts), test types (unique / not_null / relationships / accepted_values), incremental models.
- **Backfills**: how to backfill safely — bounded batches, progress checkpointing, dry-run mode, resumable from interruption.
- **Performance**: query plan reading (`EXPLAIN ANALYZE`), when to add indices, when to denormalize for read patterns.
- **Bulk operation patterns**: e.g. `INSERT ... ON CONFLICT` for upserts, not per-row sync function loops in migrations.

## Procedure

Follows the standard development cycle (CLAUDE.md §"The development cycle"). Additions specific to this skill:

### Phase 2 (Plan) additions

Include in the plan:
- **Affected row count estimate** (e.g. "this migration alters a table with ~2M rows")
- **Lock implications** (will this block writes / reads / both, for how long)
- **Backfill strategy** if applicable (batch size, checkpointing, total estimated duration)
- **Rollback plan** (what we'd `DOWN` migrate, what data state we'd accept losing)

### Phase 3 (Implement) additions

- **For migrations, write `down` direction before `up`.** Forces you to think about reversibility before commitment.
- **Manual migrations (not auto-generated) for time-series DB are the norm.** Auto-generated migrations don't understand hypertable / partition semantics.
- **Backfills always have a `--dry-run` mode** that prints the plan without writing.

### Phase 4 (Self-test) additions

- **Run migrations against a snapshot of staging data** if accessible, not just an empty local DB. Time-series migrations behave differently at scale.
- **Verify reversibility**: run `migration:up` then `migration:down`, confirm the schema returns to prior state.
- **For backfill scripts**, run the dry-run pass and inspect the planned changes.

### Phase 6 (Open PR) additions

PR description **must** include:
- Affected row count estimate
- Expected duration (lock time, total time)
- Lock impact (what blocks during the migration)
- Rollback steps (exact `DROP` / `DELETE` / `ALTER` to undo)

## Outputs

- PRs on data infra paths (`server/infra/db-series/`, ETL scripts, dbt models)
- Time-series migrations with explicit performance notes in PR description
- dbt model PRs with test additions (unique/not_null/relationships/accepted_values)
- Backfill scripts (with dry-run mode + checkpointing)
- Updates to `dev-team-state/projects/<project>/builder-server/data/schema-decisions.md`

## Examples

> **Input**: "Add a daily aggregate of fleet performance grouped by site"
>
> **Plan**:
> - New continuous aggregate `site_daily_perf`
> - Refresh policy (every 1h, 30d retention)
> - Depends on existing `fleet_metrics` hypertable
> - Expected rows: ~1M/yr
> - Expected disk: ~80MB/yr
> - Lock implications: continuous aggregate creation is non-blocking; initial population may take ~5min on staging-snapshot data
> - Rollback: `DROP MATERIALIZED VIEW site_daily_perf;` — clean revert
>
> **PR**: 2 commits (migration adding the aggregate + refresh policy, dbt test for the aggregate). Description includes the disk projection + rollback step.

## Escalation

- Migration estimated to lock a hot table >30s → ping `@platform-agent` (architect) for a maintenance-window decision **before** opening the PR.
- Backfill estimated >24h → propose a multi-PR rollout in the plan; don't try to one-shot it.
- Schema change affecting downstream consumers (BI tools, dashboards, partner integrations) → ping `@strategist-agent` (BA skill) to identify consumers; coordinate the rollout.
- Data store change (new DB, new index pattern, new shard scheme) → that's an architectural decision. Ping `@platform-agent` (architect) for an ADR.

## What this skill does NOT do

- Run analyses on data (Strategist's `ba` skill does that).
- Make business decisions about which metrics matter (PM skill in Strategist).
- Touch transactional CRUD tables routinely (those go through `backend` — though the lines blur on migrations affecting both).
- Deploy or run migrations against production (production migrations are human-triggered; you propose and prepare).
