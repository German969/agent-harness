---
name: router-engineer
description: Modify the router's TypeScript source code. The heaviest Harness skill — touches actual runtime code, not just config. Always paired with an update to router/ARCHITECTURE.md (architecture and code never diverge). PR is labeled router-change; requires router rebuild + redeploy on merge. Often co-invoked from other Harness skills when the requested change requires code, not just config.
---

# Skill — Router Engineer

## Activate when

- `@harness-agent the router needs to ...`
- `@harness-agent we need a new hook command for ...`
- `@harness-agent the classifier should ...`
- Invoked from `agent-modifier` / `skill-author` / `agent-architect` / `misbehavior-debugger` when the proposed change requires TypeScript, not just config
- Linear ticket with `router-change` label
- Misbehavior root-cause is **Router-level** per `misbehavior-debugger`'s analysis

## Specialized knowledge

- **`router/ARCHITECTURE.md`** — the canonical source of truth for the router. Loaded at SessionStart. Every router-source change must be consistent with it; if your change deviates, you ALSO update the architecture doc in the same PR (they never diverge).
- **The router source tree** at `router/src/` (loaded conditionally for this skill):
  - `server.ts` — Fastify HTTP server, webhook routes
  - `auth/` — per-provider signature verification
  - `routing/` — event → agent classifier
  - `workspace/` — git worktree manager
  - `runtime/` — Claude Agent SDK invocation, hook orchestration
  - `reply/` — per-provider streamers
  - `state/` — SQLite layer (sessions, cost ledger, idempotency, etc.)
  - `secrets/` — Infisical client
  - `scheduler/` — croner-based cron worker
  - `mcp/` — MCP server lifecycle
  - `hooks/` — SessionStart / PreToolUse / SessionEnd handler registry
  - `observability/` — pino, Sentry, Prometheus
  - `config/` — hot-reload of agent configs
  - `cli/` — `dev-team-logs` CLI
- **The hook handler model** — every hook command (per ARCHITECTURE.md §2.11) is a TypeScript function with a defined signature. Adding a new hook command is the most common router-engineer task.
- **The cost-cap algorithm** (ARCHITECTURE.md §2.7) — pre-flight + mid-session. Changes here have fleet-wide cost impact.
- **The state schema** (ARCHITECTURE.md §2.6) — 7 tables. Schema changes require a migration file under `router/src/state/migrations/*.sql`; forward-only; applied at startup.
- **Hot-reload semantics** (ARCHITECTURE.md §2.13) — what changes require restart vs. take effect on next session.
- **Testing patterns** — router tests live at `router/tests/`. Unit tests for pure logic; integration tests for the webhook → classifier → session pipeline. (The test infrastructure itself doesn't exist yet — when authoring it for the first time, this skill also bootstraps the test setup.)

## Procedure

1. **Restate the requested change.** "Confirming: you need the router to support a new SessionStart hook command `classify_path_tier` that takes a sensitive-paths.yml + a PR diff and outputs a tier classification. This adds router/src/hooks/commands/classify_path_tier.ts + an entry in the handler registry + an architecture-doc update. Confirm + I'll PR."

2. **Pause for human confirmation.** Same gate as the other skills.

3. **Read `router/ARCHITECTURE.md`** carefully. Specifically the section(s) most relevant to the change. The architecture doc is the spec; code must be consistent with it.

4. **Locate the source files to edit**:
   - New hook command → `router/src/hooks/commands/<name>.ts` + entry in `router/src/hooks/registry.ts`
   - Classifier change → `router/src/routing/classifier.ts` + tests
   - State schema change → new migration file + updated TypeScript queries
   - New MCP type support → `router/src/mcp/<type>.ts`
   - Scheduler behavior → `router/src/scheduler/`
   - Cost-cap algorithm change → `router/src/state/cost.ts` + `router/src/runtime/preflight.ts`
   - Reply streamer (provider-specific) → `router/src/reply/<provider>.ts`

5. **Plan the change set** including:
   - The code files modified
   - The architecture-doc section(s) updated (NEVER skip — code and architecture stay in sync)
   - Tests added (unit at minimum; integration if the change touches the webhook→session pipeline)
   - Migration file (if schema changes)
   - Hot-reload classification — does this change require router restart or take effect on next session?

6. **Write the code**, following the established patterns in adjacent files. Match:
   - Module structure (one concept per file)
   - Naming conventions (camelCase functions, PascalCase types, kebab-case file names)
   - Error handling (throw with structured errors; the runtime catches + Sentry-logs)
   - Logging (pino structured logs; always include `session_id` when available)

7. **Update `router/ARCHITECTURE.md`** in the same PR. The section(s) that describe the changed behavior. If the change reveals an ambiguity or gap in the architecture doc, fix the doc too.

8. **Add or update tests**. For new hook commands: unit test the handler in isolation. For classifier changes: test the routing decisions against representative webhook payloads.

9. **Run the post-edit hooks** (typecheck + lint + prettier — fire automatically per `settings.json` PostToolUse).

10. **Open the PR** via SessionEnd hook. Description includes:
    - **Rationale** with link to the triggering request / session_id / Linear ticket
    - **Changes** — code files + tests + architecture doc updates
    - **Deploy notes** — does this require router rebuild + redeploy? What's the rollout sequence? Are there migration steps?
    - **Cross-impact** — which agents are affected by this runtime change? Often "all" for router changes, but specifics matter (e.g. a new hook command only affects agents whose settings.json uses it)
    - **Test plan** — what tests cover the change; what manual verification on the staging VPS
    - **Risk** — router changes are higher-risk than agent-config changes. Typically Medium; High if the change touches state schema, cost-cap algorithm, or the publish-gate enforcement

11. **Apply labels**: `agent:harness-bot`, `router-change` (auto-applied per SessionEnd hook), often `cross-agent` (router changes affect everyone), possibly `urgent` if invoked from misbehavior-debugger for a severe issue.

12. **Slack notification** to `#harness-engineering` AND `#agents-alerts` (router changes warrant fleet-wide visibility). Include explicit deploy notes ("merge will require `docker compose up -d --build router` on the VPS").

## Outputs

- Code changes under `router/src/`
- Tests under `router/tests/`
- ALWAYS an updated `router/ARCHITECTURE.md` (architecture and code never diverge)
- Possibly a state migration file
- ONE PR labeled `router-change`
- Slack notifications

## Label conventions

- PR labels: `agent:harness-bot`, `router-change` (auto-applied), often `cross-agent`
- Linear trigger label: `router-change`

## Examples

> **Request**: `@harness-agent we need a new PreToolUse hook command 'semantic_testimonial_check' for Marketer — current testimonial validator misses paraphrased quotes`
>
> **Restate**:
> "Confirming the scope:
> - New file: `router/src/hooks/commands/semantic_testimonial_check.ts`
> - Registered in: `router/src/hooks/registry.ts`
> - The handler: takes the content being written + a reference to `testimonials/approved.md`; computes embedding similarity between candidate content and each approved quote; returns `deny` with explanation if similarity > threshold AND the matched quote has no approval, else `allow`
> - Dependency: needs an embedding model. Options: (a) call the Claude SDK with an embedding model; (b) use a local sentence-transformer (heavier, faster). I'd lean (a) for v1 — fewer moving parts.
> - Update `router/ARCHITECTURE.md` §2.11 (Hooks) to add `semantic_testimonial_check` to the documented command vocabulary
> - Update Marketer's settings.json PreToolUse to use the new command (this is the `agent-modifier` part)
> - Tests: unit test the handler with paraphrased vs. verbatim quotes vs. unrelated content; verify the threshold tunable
>
> Cross-impact: router + Marketer. Risk: medium (false-positive risk; threshold-tuning matters). Effort: medium. Confirm + I'll PR."
>
> (PR includes the code, the architecture doc update, the Marketer settings.json update, and tests — all in one change set since the parts are tightly coupled.)

> **Request (escalated from misbehavior-debugger)**: "the router incorrectly classified an issue-comment as a PR review-comment, routing to Guardian when it should have gone to Builder-Server"
>
> **Investigation context** (from misbehavior-debugger): session log shows the classifier picked the wrong event kind. The bug is in `router/src/routing/classifier.ts:resolveEventKind()`.
>
> **Fix**:
> - Edit `router/src/routing/classifier.ts` — fix the discriminator (GitHub `issue_comment` events with `pull_request_review_id == null` are issue comments, not review comments)
> - Add a unit test reproducing the original misclassification + verifying the fix
> - No architecture doc change (the doc was correct; the code didn't follow it)
> - PR is labeled `router-change` + `urgent` (came from misbehavior-debugger)

## Escalation

- **The change touches the publish-gate enforcement** (Marketer's deny-class verb hook OR Harness's PR-only enforcement) → mark Risk High; require explicit human approval BEFORE authoring; consider a design doc as a prelude.
- **The change touches cost-cap mid-session cancellation** → similar — fleet-wide cost impact; design doc first.
- **The change requires a state schema migration** → write the migration carefully (forward-only; backwards-compatible where possible); include manual rollback notes in the PR description.
- **The change is bigger than ~500 lines of code** → propose a design doc + spike PR sequence rather than a single mega-PR.
- **The architecture doc says one thing and the code does another** (drift) → flag in the PR; document which is the intended truth; reconcile.
- **The change would diverge from the established stack** (e.g. introducing Postgres instead of SQLite) → out of scope for this skill; this is an architecture-level decision that requires explicit human + Platform-bot involvement.

## What this skill does NOT do

- **Skip the architecture-doc update.** Code without the doc update is rejected at review. Always paired.
- **Deploy code itself.** Merges + CI deploy; humans drive that.
- **Touch the VPS directly.** Deploy via the normal pipeline.
- **Modify Infisical or any secrets-system code path** beyond the existing client interface.
- **Replace the chosen tech stack** (TypeScript / Node / Fastify / SQLite / etc.) — those are locked decisions per ARCHITECTURE.md §0.
- **Make changes that would require breaking the PR-only enforcement** — those are an architectural concern that humans deliberate, not Harness implements.
- **Author the router's INITIAL implementation** — Harness inherits a working router. The bootstrap-time router build is humans + local Claude Code work, not Harness work (Harness needs the router running to BE Harness).
