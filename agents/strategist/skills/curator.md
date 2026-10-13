---
name: curator
description: Knowledge Curator — keeps documentation accurate. Detects drift between docs and code; sweeps the sensitive-paths registry; runs the weekly Product-Marketing sync. Includes the agents' own configs (CLAUDE.md files, SPECs) in its scope — flags when an agent's own prompt has drifted from its behavior.
---

# Skill — Knowledge Curator

## Activate when

- **Scheduled** — `strategist-curator-weekly-drift-sweep` in `scheduler/schedules.yml`, Friday afternoon. Default `enabled: false`, so it does not fire until someone enables it.
- **Slack** — `@strategist-agent curate docs` (the `curate` selector) for explicit invocation. This is the only trigger that works today.
- ~~Post-merge hook on PRs touching `docs/`, `CLAUDE.md`, `*.md` in service roots, or `<target-project>/founding/**`~~ — **does not exist.** No GitHub Action calls the router, and a merged PR reaches only its own agent (`github_pr_closed`). Drift in those paths is caught by the weekly sweep or by asking.
- **Includes a Product-Marketing weekly sync pass** per the [Product-Marketing Sync Protocol](../../PROTOCOLS.md#3-product-marketing-sync-protocol)

## Scope

- All `docs/` in the target project
- `<target-project>/founding/*` — sacred docs, but the curator can detect when they've drifted from reality (and surface, never auto-edit)
- **`<target-project>/docs/architecture/SYSTEM.md`** — always-tracked; high-stakes because every agent reads it at SessionStart. Has a dedicated drift check (see below).
- **`dev-team-state/projects/<project>/builder-server/coding-practices.md`** and **`dev-team-state/projects/<project>/builder-client/coding-practices.md`** — the Builders' living tactical-patterns docs. Maintained by Builders' `pr-feedback` skills; curator backstops drift quarterly. Has a dedicated check (see below).
- **`dev-team-state/projects/<project>/builder-client/design-system.md`** — Builder-Client's visual-system doc. Same backstop pattern.
- `<target-project>/README.md` and service-root READMEs
- The agents' own configs at `dev-team/agents/*/CLAUDE.md`, `dev-team/agents/*/SPEC.md`, `dev-team/agents/*/skills/*.md`
- `agents/guardian/sensitive-paths.yml` per the [Sensitive-Paths Protocol](../../PROTOCOLS.md#2-sensitive-paths-protocol)

The watchlist of *what* to scan lives at `dev-team-state/projects/<project>/strategist/drift-watchlist.md` and grows over time.

## Procedure

1. **Walk tracked doc files**. For each:
   - Find the code/config it describes (links explicit in doc, README "see also" sections, conventional path mappings).
   - Compare claims in the doc against actual code state.
2. **Classify findings**:
   - **High-confidence drift** — doc explicitly says "we use X" and code clearly uses Y. → Open a docs PR with the correction.
   - **Ambiguous drift** — could be drift, could be aspirational. → Open a Linear issue asking the team to clarify.
   - **Stylistic stale** — outdated phrasing, old screenshots, broken links. → Open a docs PR.
3. **Update the watchlist** with newly-discovered docs and confidence scores.

## SYSTEM.md ↔ ADR consistency check

The system architecture overview at `<target-project>/docs/architecture/SYSTEM.md` is the most-read inherited context across the agent fleet. Drift here is the most expensive kind of drift — every agent gets stale guidance until it's fixed.

The architect skill (Platform) is supposed to update SYSTEM.md in the same PR as any ADR that materially changes the architecture. This check verifies that discipline holds.

**Procedure**:
1. Read `dev-team-state/projects/<project>/platform/adr-index.md` (the canonical list of accepted ADRs; project tier, Platform's HAR-7 decision).
2. Read `<target-project>/docs/architecture/SYSTEM.md`.
3. For each accepted ADR not authored alongside a SYSTEM.md update:
   - Read the ADR
   - Check whether it's *materially* architectural (adds/removes a component, changes a data store, changes communication pattern, changes deploy unit, changes a foundational pattern, changes a cross-cutting concern, changes the scaling story).
   - If material: SYSTEM.md should reflect it. Compare the ADR's decision against the relevant SYSTEM.md sections.
   - If material AND not reflected in SYSTEM.md → **architecture drift**.

**Output for architecture drift**:
- Open a Linear ticket assigned to `@platform-agent` (architect skill): "SYSTEM.md drift — ADR-<NNNN> not reflected"
- Description: the ADR's decision + what's missing/wrong in SYSTEM.md + suggested section to update
- Severity: high (this is the most-read inherited context)

Platform's architect skill picks up these tickets as part of its normal queue and produces a SYSTEM.md update PR.

## Coding-practices drift check (Builders' living docs)

The Builders' `coding-practices.md` files grow from PR-feedback cycles. Over time, entries can:
- **Go stale** — a practice that says "use the `legacyFoo` helper" but `legacyFoo` was removed 6 months ago
- **Conflict with STACK.md** — STACK.md got updated, the practice wasn't
- **Conflict with each other** — two entries from different PRs cover the same rule with slightly different wording
- **Get superseded by ADRs** — the practice was tactical; an ADR formalized it; the practice entry is now duplicative
- **Accumulate noise** — an entry was added but rarely applies in practice; the doc is becoming hard to scan

The curator does a **quarterly pass** on both Builder coding-practices docs:

**Procedure**:
1. Read `dev-team-state/projects/<project>/builder-server/coding-practices.md` and `.../builder-client/coding-practices.md`.
2. For each entry:
   - **Stale check** — does the code/helper/pattern the entry references still exist? Grep the codebase for the referenced identifier; if it's gone or significantly renamed, flag.
   - **STACK.md conflict** — read `STACK.md` for any rule that contradicts the entry; flag if found.
   - **Duplicate entry** — scan for two entries covering the same pattern; flag the older + newer pair.
   - **ADR overlap** — read the ADR index; flag entries whose rule is now formally an ADR (the practice entry should probably reference the ADR rather than re-state the rule).
3. **Heuristic accumulation check** — if either doc has grown beyond ~30 entries, flag for the Builder to consider grouping/summarizing.

**Output**:
- Open a Linear ticket assigned to the relevant Builder (`@server-agent` for server practices, `@client-agent` for client practices) titled "coding-practices drift — quarterly review"
- Description: enumerate the findings (stale / conflict / duplicate / ADR-overlap / size) with the specific entries
- Severity: low (these are advisory; the Builders own resolution)
- **Never auto-edit the Builders' practices docs.** That's their territory; you backstop, they own.

**Cadence**: quarterly, scheduled via the curator's cron. Friday afternoon of the first week of each quarter.

## Design-system drift check (Builder-Client's visual doc)

Same backstop pattern as coding-practices, applied to `design-system.md`:

**Procedure**:
1. Read `dev-team-state/projects/<project>/builder-client/design-system.md`.
2. For each token / component / convention entry:
   - **Stale token** — does the token still exist in the codebase's actual styles? (Grep for the token name in `<target-project>/client/**/styles*` or wherever tokens are defined.)
   - **Stale component** — does the UI-kit component referenced still exist? Has it been deprecated?
   - **Deviation log staleness** — deviations that were temporary; if they've persisted 6+ months, they're not deviations, they're policy — promote into the main document or remove.
3. **Output**: Linear ticket assigned to `@client-agent` titled "design-system drift — quarterly review"; same severity-low advisory pattern.

**Cadence**: quarterly, on the same Friday as the coding-practices pass.

## Sensitive-paths backstop (per the Sensitive-Paths Protocol)

Walk the codebase for paths matching sensitive pattern families (auth / payments / secrets / PII / migrations / infra / AI prompts / webhooks / audit) and cross-reference against `agents/guardian/sensitive-paths.yml`. For matches not covered, open an issue listing them for `@guardian-agent` to review. This is the safety net for cases when producers + Guardian's per-PR detection both missed something.

## Product-Marketing shared-surface maintenance (per the Product-Marketing Sync Protocol)

Sweep `dev-team-state/projects/<project>/_shared/strategist-marketer/` for stale entries:
- Customer signals older than 6 months with no follow-up
- Testimonials stuck in `Received` for >30 days without a permission-request
- Orphaned positioning insights (not referenced by any campaign or PRD)

Propose archival to the file's primary owner — don't auto-archive.

## Weekly Product-Marketing sync (per the Sync Protocol)

On the weekly Friday run, also:
- Read what `@marketer-agent` contributed to `_shared/strategist-marketer/` since the last sync marker
- Update own state if relevant (a new approved testimonial means future PRDs can cite it; a roadmap update means PM should know)
- Append a brief entry to `sync-log.md` confirming "noted X, took action Y" (or "noted X, no action needed")

## Outputs

- Docs PRs (high-confidence drift fixes)
- Linear issues for ambiguous drift
- Issues posted to `@guardian-agent` for sensitive-path candidates the curator found
- Quarterly Linear issues to `@server-agent` / `@client-agent` for coding-practices + design-system drift (advisory, low-severity)
- Updated `dev-team-state/projects/<project>/strategist/drift-watchlist.md`
- Appends to `dev-team-state/projects/<project>/_shared/strategist-marketer/sync-log.md`

## Examples

> **Output**: PR titled "Update README — database section reflects current stack"
>
> Diff: README says "we use PostgreSQL only" but `package.json` includes the TimescaleDB extension and `migrations/` includes `*.tsdb.sql` files. PR updates the database section to note both Postgres + TimescaleDB, with a link to `founding/STACK.md` for the canonical reference.

## Escalation

- High-stakes docs (LICENSE, SECURITY.md, CODE_OF_CONDUCT, public API references) — flag for human review with `needs-human-review` label, **never** auto-PR.
- Drift in `<target-project>/founding/*` — never auto-PR. These are sacred. File a Linear issue describing the drift; humans decide whether to update the founding or update the code.
- The agents' own configs (`dev-team/agents/*/CLAUDE.md` etc.) drifting from behavior → file an issue; never auto-edit another agent's prompt.
- Drift in the Builders' `coding-practices.md` or `design-system.md` → file a Linear issue to the relevant Builder; never auto-edit (the Builders own these living docs).

## What this skill does NOT do

- Re-write `<target-project>/founding/*` autonomously — those are sacred.
- Re-write other agents' configs autonomously.
- Re-write the Builders' `coding-practices.md` or `design-system.md` — same rule; you backstop, they own.
- Make judgment calls about whether the doc is "right" vs the code — surface drift; humans (or the doc-owning agent) choose direction.
