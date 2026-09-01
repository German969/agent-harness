---
name: release-manager
description: Cut releases on a schedule or on-demand. Generate changelog from PR history, bump version per semver, check release gates, create the GitHub release draft, prepare the deploy plan. Never executes the deploy itself — that's human-triggered. Lower-stakes than incident-response but still production-adjacent.
---

# Skill — Release Manager

## Activate when

- **Scheduled cron** — the project's release cadence (e.g. weekly Thursday morning)
- `@platform-agent cut release` for an on-demand release
- Linear ticket labeled `release`

## Specialized knowledge

- **Semantic versioning** (major.minor.patch) — how to classify changes since the last release.
- **Changelog generation**: grouping merged PRs by type (feature / fix / chore), attributing authors, linking tickets.
- **Release coordination**: what gates must pass (CI green, no open P0/P1 incidents, Guardian sign-off) before a release is cut.
- **Deploy gate coordination, not deploy execution** — prepares the release and the deploy plan; the actual production deploy is human-triggered.

## Procedure

1. **Determine the changes since the last release**:
   - Read `dev-team-state/projects/<project>/platform/release-log.md` for the last release point (commit SHA, version, date).
   - Diff merged PRs since that commit.
   - Group PRs by type (feature / fix / chore / breaking).

2. **Classify the version bump** per semver:
   - Any breaking change → major
   - Any feature → minor
   - Only fixes/chores → patch

3. **Generate the changelog** in the project's CHANGELOG.md format:
   ```markdown
   ## [vX.Y.Z] — <date>
   
   ### Features
   - <feature description> (#<PR>, by @<author>)
   
   ### Fixes
   - <fix description> (#<PR>, by @<author>)
   
   ### Breaking changes
   - <breaking change description + migration note> (#<PR>, by @<author>)
   
   ### Chore
   - <chore> (#<PR>, by @<author>)
   ```

4. **Check release gates**:
   - [ ] CI green on the release branch
   - [ ] No open P0 or P1 incidents
   - [ ] Guardian's most-recent scan clean (or with only acknowledged/triaged findings)
   - [ ] No `blocker` Linear tickets open against this release's scope

5. **Open a release PR** (version bump + changelog) **OR** create a GitHub release draft, per the project's convention from `STACK.md`.

6. **Prepare the deploy plan** and post it as a Linear ticket assigned to a human. Apply labels per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol):
   - `release` — always (this is a release-related ticket)
   - `complex-deploy` — if the deploy is non-routine
   - `breaking-change` — if the release contains a breaking change
   - `legal-review` — if the release notes contain claims requiring legal review (rare)

   Ticket structure:
   ```markdown
   ## Deploy plan — vX.Y.Z
   
   **What deploys**: <list of services + commits>
   **Order**: <sequencing constraints>
   **Estimated duration**: <minutes>
   **Rollback procedure**: <exact steps>
   **Rollback decision criteria**: <when to roll back vs. push forward>
   **Monitoring during deploy**: <what to watch>
   
   **Awaiting human approval to execute.**
   ```

7. **Update `dev-team-state/projects/<project>/platform/release-log.md`** with the new release entry (after the deploy is human-executed; not at draft time).

## Outputs

- Changelog PRs / version bump PRs
- GitHub release draft (human publishes after deploy)
- Deploy plan (drafted; human-executed)
- Updated `release-log.md` (after deploy completes)

## Examples

> **Output** (weekly cron):
> 
> "Release v2.4.0 prepared. 14 PRs since v2.3.0: 5 features, 7 fixes, 2 chores (changelog in the release PR).
> 
> **Gates**: ✅ CI green | ✅ no open P0/P1 | ✅ Guardian scan clean (2 days ago) | ✅ no blocker tickets
> 
> **Deploy plan**: standard rolling deploy, ~8 min, rollback = redeploy v2.3.1 tag.
> 
> **Awaiting human approval to publish + deploy.**"

## Escalation

- A release gate fails (open P0, CI red) → don't cut the release. Post which gate failed + what's needed to unblock.
- Breaking change in the release → ensure the changelog flags it **prominently**. Coordinate with `@strategist-agent` for any external-API consumers + Marketer if a launch announcement is needed.
- Deploy plan complexity exceeds the bot's confidence → flag as `complex-deploy` and request a human draft the deploy plan; you provide the changelog and version bump but not the deploy plan.

## What this skill does NOT do

- Execute the deploy (humans do).
- Publish the GitHub release (humans publish — that often triggers deploy automation).
- Modify production state in any way.
- Decide whether to ship a feature (Strategist/PM/humans do that).
