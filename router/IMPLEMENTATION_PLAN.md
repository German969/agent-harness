# Router — Implementation Plan

Persistent build plan for the router service. Survives session boundaries — check items off as you complete them so multi-session work picks up cleanly.

This doc tracks **execution status**. For the **design**, read [ARCHITECTURE.md](ARCHITECTURE.md) — that's the single source of truth for what to build. This file is *how* to build it, in what order, with what acceptance criteria.

---

## Overall status

**Target**: a working router that can run agent sessions end-to-end (webhook → classify → spawn Claude SDK → reply) with all the gates (cost cap, hooks, PR-only enforcement) functional.

**Estimated effort**: 5–10 days of focused work. Phases can overlap once their dependencies are met.

**Last updated**: 2026-06-29

| Phase | Status | Notes |
|---|---|---|
| 0. Scaffold | ✅ Complete | Fastify + biome + vitest wired; `/health` + `/ready` working; lint + typecheck + build all green |
| 1. State (SQLite) | ✅ Complete | 10 tables via 000-init.sql; 8 query modules; 41 tests passing; /ready reports `db: "ready"`; backup verified |
| 2. Secrets (Infisical) | ✅ Complete | SecretProvider interface + EnvSecretProvider (dev/test) + InfisicalSecretProvider stub + resolver + pino redact. 60 tests. Infisical SDK integration deferred to Phase 1 of bootstrap PLAN.md. |
| 3. Ingress (webhooks + signature verify) | ✅ Complete | 6 routes (GH/Linear/Slack events + slash + interact + url_verification handshake); 3 HMAC verifiers with constant-time compare; Slack replay protection; dedup via `webhook_deliveries`; in-memory queue; 45 new tests (105 total). Identity resolver is a stub — Phase 4 wires the real one. |
| 4. Classifier (event → agent) | ✅ Complete | Identity loader (all 7 real identities parse); routing registry with 9 indices; classifier with 6-step resolution order (mention → assignment → auto-trigger → label → channel-default → agent_hint); skill resolver with per-agent selectors; thread-key builder; real SecretLookup replaces the Phase 3 stub. 45 new tests (150 total); `/ready` reports `routing: "ready (7 identities)"`. |
| 5. Workspace (worktree mgr) | ✅ Complete | paths + sanitization; `git worktree add/remove` via execFile (no shell); acquire/release via SQLite lease; LRU prune + force-prune. 22 tests against real temp git repos (172 total). |
| 6. Runtime (Claude SDK + hooks + MCP) | ✅ Complete | 6a + 6b + 6c + 6d done: agent config loader, hook orchestrator + 10 handlers, MCP spawn/teardown, preflight + sessionPrep + sdkCall + sessionComplete + errorHandler + orchestrator (SdkClient stubbed — Phase 13 swaps in real SDK). |
| 7. Reply streamer | ✅ Complete | Types + batcher + Slack/Linear/GitHub clients (native fetch, no SDK deps) + footer + streamer + resolveReplyTarget. 29 new tests. Runtime wiring lands in Phase 13 with the real Claude SDK. |
| 8. Cost cap + ledger | ✅ Complete | Preflight + per-turn cap done in 6d; 80%/100% threshold warnings + AlertPoster interface + `cost_alerts_emitted` idempotency added. Monthly reset is implicit (per-month schema). 9 new tests. |
| 9. Scheduler (cron + overrides) | 🟡 Core done | loader + effective-state resolver + project-phase gate + croner runner + overlap guard + `fireOnce`. 21 tests. Slack slash commands + admin authz + CLI deferred (Slack surface lands cleanly once Phase 7/10 wires the Slack MCP). |
| 10. Observability (logs / errors / metrics) | ✅ Core done | Session jsonl writer + Prometheus registry (10 metrics) + /metrics endpoint + real `SlackAlertPoster`. Sentry deferred (needs API key + is a separate concern). 19 new tests. |
| 11. CLI (`dev-team-logs`) | ✅ Complete | argv parser + 5 command handlers (session, agent, trigger, cost, schedule) + format helpers. 42 new tests. Smoke-tested against the real schedules.yml. `--tail` (session log follow) deferred to Phase 10. |
| 12. Integration tests | ✅ Complete | Built the missing ingress-queue → classifier → runtime consumer bridge + wired into server.ts. End-to-end test proves webhook → signature verify → normalize → enqueue → classify → runSession → DB. 19 new tests (extractMessage, consumer, integration). |
| 13. Deploy stack (Dockerfile + compose) | ✅ Complete | 13a wired runtime integrations (sessionLog + reply streamer + metrics). 13c produced deploy artifacts: Dockerfile, docker-compose, .env.example, cloudflared + Infisical example configs, backup script, git-pull-loop sidecar, VPS runbook. Anthropic SDK adapter documented as swap point in ANTHROPIC_SDK.md. |

Legend: ⬜ Not started · 🟡 In progress · ✅ Complete · ⏸ Paused · 🔴 Blocked

---

## Phase 0 — Scaffold (~2 hours) ✅

**Goal**: A bootable Node 20 TypeScript service with `/health` and `/ready` endpoints. No router behavior yet — just confirm the foundation works.

**Decisions locked**: biome over eslint+prettier (single tool); vitest over node:test (fast, good DX).

### Files to create

- [x] `router/package.json` (dependencies pinned; ESM `type: module`; scripts: dev/build/start/test/lint/typecheck)
- [x] `router/tsconfig.json` (strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` + NodeNext; output `dist/`)
- [x] `router/biome.json` (handles both lint + format; quote-style + organize-imports)
- [x] `router/src/server.ts` — Fastify entry with `/health` + `/ready` + pino logger (pretty in dev, JSON in prod)
- [x] `router/src/config.ts` — zod-validated env loader; fail-loud on bad config; exports `config` + `PACKAGE_VERSION`
- [x] `router/src/index.ts` — main entry; SIGINT/SIGTERM graceful shutdown
- [x] `router/src/types.ts` — shared types (`AgentId`, `SkillId`, `Provider`, `SessionStatus`, `TriggerKind`)
- [x] `router/README.md` — dev setup, scripts, env vars table, smoke-test commands
- [x] `router/.gitignore` (node_modules, dist, coverage, .env*)
- [x] `router/tests/` (empty dir — vitest needs the path to exist for biome scan)

### Directory structure (per [ARCHITECTURE.md → config repo shape](ARCHITECTURE.md))

```
router/
├── ARCHITECTURE.md              (exists)
├── IMPLEMENTATION_PLAN.md       (this file)
├── README.md
├── package.json
├── tsconfig.json
├── biome.json  (or eslint+prettier configs)
└── src/
    ├── server.ts
    ├── index.ts
    ├── config.ts
    ├── types.ts
    ├── auth/                    (Phase 3)
    ├── routing/                 (Phase 4)
    ├── workspace/               (Phase 5)
    ├── runtime/                 (Phase 6)
    ├── reply/                   (Phase 7)
    ├── state/                   (Phase 1)
    ├── secrets/                 (Phase 2)
    ├── scheduler/               (Phase 9)
    ├── mcp/                     (Phase 6)
    ├── hooks/                   (Phase 6)
    ├── observability/           (Phase 10)
    ├── config/                  (hot-reload — Phase 6 / TBD)
    └── cli/                     (Phase 11)
```

### Dependencies to pin

Core:
- `fastify` (HTTP server)
- `@fastify/sensible` (HTTP error helpers)
- `pino` (structured logging)
- `pino-pretty` (dev-mode prettifier)
- `better-sqlite3` (state DB)
- `croner` (cron scheduler)
- `simple-git` (git worktree mgmt)
- `@anthropic-ai/claude-agent-sdk` (Claude SDK)
- `@octokit/webhooks` (GitHub HMAC)
- `@slack/bolt` or `@slack/web-api` (Slack)
- `@linear/sdk` (Linear)
- `@sentry/node` (error tracking)
- `prom-client` (Prometheus metrics)
- `zod` (schema validation; very useful for parsing settings.json + identities/*.yml)
- `js-yaml` (YAML parsing for identities + schedules)
- `dotenv` (local-dev env loading)

Dev:
- `tsx` (run TS directly in dev)
- `typescript`
- `vitest` (tests)
- `@types/node`

### Acceptance criteria

- [x] `pnpm install` completes without errors
- [x] `pnpm dev` starts the server on port 8080
- [x] `curl localhost:8080/health` returns `{"ok":true,"version":"0.1.0","uptimeMs":<N>}`
- [x] `curl localhost:8080/ready` returns `200` with subsystem placeholders
- [x] `pnpm build` produces a `dist/` directory with `.js` + `.d.ts` + sourcemaps
- [x] `node dist/index.js` (via `pnpm start`) runs the built artifact
- [x] `pnpm test` runs vitest cleanly (using `--passWithNoTests`; turn off when real tests land in Phase 1)
- [x] `pnpm typecheck` is clean
- [x] `pnpm lint` is clean

---

## Phase 1 — State layer (SQLite) (~1 day) ✅

**Goal**: All 10 tables from [ARCHITECTURE.md §2.6](ARCHITECTURE.md#26-state--sqlite-schema) created via migrations + a typed query layer.

### Tables (per ARCHITECTURE.md §2.6)

- [x] `sessions`
- [x] `cost_ledger`
- [x] `webhook_deliveries` (idempotency)
- [x] `pending_sessions`
- [x] `schedule_runs`
- [x] `agent_chain` (loop prevention)
- [x] `worktrees` (lease tracking)
- [x] `schema_version`
- [x] `schedule_overrides` (per [ARCHITECTURE.md §2.8](ARCHITECTURE.md#28-scheduler))
- [x] `schedule_override_history`

### Files to create

- [x] `router/src/state/db.ts` — better-sqlite3 connection + WAL mode + foreign_keys + busy_timeout pragmas
- [x] `router/src/state/migrations/000-init.sql` — all 10 tables + indexes
- [x] `router/src/state/migrations/index.ts` — migration runner (forward-only; idempotent; transaction-wrapped)
- [x] `router/src/state/sessions.ts` — CRUD + continuation logic + listRunning + markRunningAsInterrupted
- [x] `router/src/state/cost.ts` — UPSERT ledger rollups + getMonthlyAgentSpend + UTC dayKey
- [x] `router/src/state/webhooks.ts` — idempotency check via INSERT-or-detect-PK-collision + pruneOldDeliveries
- [x] `router/src/state/schedule.ts` — schedule_runs + schedule_overrides + history (atomic upserts; reset preserves history)
- [x] `router/src/state/agent_chain.ts` — chainDepth + chainPath for loop prevention
- [x] `router/src/state/worktrees.ts` — registerWorktree + acquire/release lease + listIdle for prune
- [x] `router/src/state/index.ts` — public surface; other modules import from here
- [x] `router/tests/state/migrations.test.ts` — 5 tests; verifies all 10 tables + idempotency
- [x] `router/tests/state/sessions.test.ts` — 9 tests; CRUD + continuation window + interruption recovery
- [x] `router/tests/state/cost.test.ts` — 6 tests; UTC day keys + rollup math + per-month + per-agent isolation
- [x] `router/tests/state/webhooks.test.ts` — 4 tests; idempotency + outcome update + prune
- [x] `router/tests/state/schedule.test.ts` — 8 tests; runs + overrides + history + active-run detection
- [x] `router/tests/state/agent_chain.test.ts` — 3 tests; depth + path
- [x] `router/tests/state/worktrees.test.ts` — 6 tests; register + lease + prune
- [x] `router/scripts/copy-assets.mjs` — postbuild script to copy `*.sql` to `dist/`

### Acceptance criteria

- [x] Fresh DB applies all migrations on startup (`schema_version` row 0 written)
- [x] Re-startup detects existing schema; skips applied migrations
- [x] `sqlite3 state.sqlite '.tables'` shows all 10 tables
- [x] All 41 unit tests pass
- [x] Backup script (`sqlite3 .backup <path>`) works against the live DB while router runs
- [x] `/ready` reports `db: "ready"` (or 503 with `db: "down"` on failure)
- [x] On boot, any `status='running'` sessions get marked `interrupted_needs_resume` (recovery per ARCHITECTURE.md §3.2)
- [x] All TS strict checks pass (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)
- [x] biome lint + format clean

### Notes

- **Foreign keys**: `worktrees.active_session_id` references `sessions(id)`. Tests must use real session IDs (not synthetic numbers). The FK is enforced because `db.pragma('foreign_keys = ON')`.
- **schema_version sentinel**: bootstrap edge case — the table is created BY migration 000, so the runner checks `sqlite_master` first to detect a fresh DB.
- **clearOverride**: writes a sentinel `enabled = -1` history row so the audit trail captures resets. UI/CLI should treat `-1` as "reverted to YAML".
- **Postbuild SQL copy**: `scripts/copy-assets.mjs` copies `*.sql` to `dist/`. Without this, `node dist/index.js` would fail on the first migration read.
- **No env override yet for the in-memory DB**: tests pass `:memory:` directly via `openDb({ path: ':memory:' })`. Production reads `STATE_DB_PATH` (default `/var/lib/agents/state.sqlite`).

---

## Phase 2 — Secrets (Infisical) (~half day) ✅

**Goal**: Per-session credential fetch; secrets become env vars scoped to the session; never written to disk.

**Decisions locked**: designed the provider interface generically so we could ship the pattern now (with `EnvSecretProvider` for dev/test) and finalize the Infisical wire-up during Phase 1 of the bootstrap PLAN when Infisical is actually deployed. The router works today against `SECRETS_PROVIDER=env`; switching to Infisical is a one-flag change.

### Files to create

- [x] `router/src/secrets/types.ts` — `SecretProvider` interface + `IdentitySecretsBlock` + `SessionEnv`
- [x] `router/src/secrets/env-provider.ts` — reads process.env; used for dev + test + `SecretNotFoundError`
- [x] `router/src/secrets/infisical-provider.ts` — stub with typed config; SDK integration marked as Phase-1-bootstrap TODO
- [x] `router/src/secrets/resolver.ts` — `resolveSecrets` + `resolveSecretsWithExtras` (secrets override extras — safer default)
- [x] `router/src/secrets/factory.ts` — `createSecretProvider(cfg)` — picks impl by config
- [x] `router/src/secrets/log-redact.ts` — pino redact paths + censor for defense-in-depth logging
- [x] `router/src/secrets/index.ts` — public surface
- [x] `router/tests/secrets/env-provider.test.ts` — 5 tests
- [x] `router/tests/secrets/resolver.test.ts` — 7 tests (uppercasing, per-agent isolation, extras merge)
- [x] `router/tests/secrets/factory.test.ts` — 3 tests
- [x] `router/tests/secrets/log-redact.test.ts` — 4 tests (env block, secrets block, common patterns)

### Acceptance criteria

- [x] Router startup connects to a secret provider (`env` locally; `infisical` stub in prod-config mode)
- [x] `resolveSecrets` fetches secrets by name (e.g. `GITHUB_APP_PRIVATE_KEY_strategist`) and returns them keyed by the identity's uppercased LHS (`GITHUB_APP_PRIVATE_KEY`)
- [x] Per-agent isolation verified: two agents with different Infisical names for the same role get different values
- [x] Secrets are NOT logged. Pino redact scrubs known secret-shaped fields as defense-in-depth.
- [x] Per-session env vars are ephemeral by design (not stored on the process; returned by the resolver as a fresh map each call)
- [x] `/ready` reports `secrets: "ready (env)"` (or "stub (infisical)" when the Infisical impl is a stub)
- [x] End-to-end smoke: identity block → EnvSecretProvider → resolved SessionEnv with keys `[GITHUB_APP_PRIVATE_KEY, LINEAR_TOKEN, SLACK_BOT_TOKEN]`
- [x] All 60 unit tests pass
- [x] biome lint + typecheck clean

### Notes

- **Provider swap for Phase 1 (bootstrap)**: When Infisical is deployed, implement `getSecret` in `infisical-provider.ts` using `@infisical/sdk` (or the current canonical package). Add the SDK dep to `package.json`. All other Phase-2 code is provider-agnostic.
- **Redact policy — safer default**: The pino redact scrubs the ENTIRE `env` block when it sees one, not individual fields. Public IDs (like `SLACK_TEAM_ID`) mixed into the same block get scrubbed too. Log public IDs OUTSIDE the env block if they need to remain visible.
- **`resolveSecretsWithExtras` conflict rule**: secrets override extras on key collision. Prevents a leaked "extra" from silently supplanting a real secret.
- **`process.env` deletion in tests**: uses `delete process.env.X` (with a biome-ignore comment) — Node's `process.env` requires `delete`; assigning `undefined` coerces to the string `"undefined"`.
- **Rotation**: The provider interface supports lazy re-fetch (each `getSecret` call is independent). When Infisical is wired, we don't need explicit rotation hooks — each session fetches fresh.
- **Cost cap deferred**: Phase 2 doesn't yet enforce the `/ready` endpoint's `secrets: "stub"` as a 503 — an env-mode router with the stub Infisical provider still returns 200 for the env provider path. The distinction is captured in the response body.

---

## Phase 3 — Ingress (webhooks + signature verify) (~1 day) ✅

**Goal**: HTTP routes for GitHub / Linear / Slack webhooks with signature verification + idempotency dedup.

### Files to create

- [x] `router/src/server.ts` — extended with the 5 webhook routes + `buildStubSecretLookup()` placeholder (Phase 4 replaces this)
- [x] `router/src/ingress/routes.ts` — the actual route handlers + custom content-type parsers (JSON + form-urlencoded) that capture raw body for signature verify
- [x] `router/src/ingress/types.ts` — `WebhookEvent`, `SecretLookup` interface
- [x] `router/src/ingress/queue.ts` — `EventQueue` — in-memory FIFO with async consumer + resilience to consumer errors
- [x] `router/src/ingress/normalize/github.ts` — GH payload → `WebhookEvent`; extracts `event_type` (with action) + `agent_hint` (App ID)
- [x] `router/src/ingress/normalize/linear.ts` — Linear payload → `WebhookEvent`; uses `webhookId` as both delivery_id + agent_hint
- [x] `router/src/ingress/normalize/slack.ts` — Slack events payload → `WebhookEvent`; extracts `event_id` + `api_app_id`
- [x] `router/src/auth/github.ts` — `X-Hub-Signature-256` HMAC-SHA256 with constant-time compare
- [x] `router/src/auth/linear.ts` — `Linear-Signature` HMAC-SHA256 (raw hex, no prefix)
- [x] `router/src/auth/slack.ts` — `X-Slack-Signature` + `X-Slack-Request-Timestamp` (5-min replay window)
- [x] `router/tests/auth/github.test.ts` — 7 tests: valid + tampered + wrong secret + missing header + wrong prefix + malformed hex + array headers
- [x] `router/tests/auth/linear.test.ts` — 5 tests
- [x] `router/tests/auth/slack.test.ts` — 7 tests: valid + old timestamp + future timestamp + tampered + missing headers + invalid timestamp + wrong prefix
- [x] `router/tests/ingress/normalize.test.ts` — 10 tests across all 3 normalizers
- [x] `router/tests/ingress/queue.test.ts` — 5 tests: empty start, enqueue-before-consumer, consumer-drains-buffer, streaming, error-recovery
- [x] `router/tests/ingress/routes.test.ts` — 11 end-to-end tests using `server.inject()`: valid webhook, invalid signature, duplicate delivery, unknown agent, missing headers, Slack handshake, Slack replay attack, slash-command ack

### Acceptance criteria

- [x] Valid GitHub webhook → 202 with `{queued: true, delivery_id}` + persisted in `webhook_deliveries`
- [x] Tampered signature → 401 with `{error: 'invalid_signature'}`, nothing queued
- [x] Duplicate delivery_id → 200 with `{deduplicated: true}`, no re-enqueue
- [x] Slack timestamp >5 min old → 401 with reason `timestamp_too_old`
- [x] Slack `url_verification` handshake → 200 with challenge echoed
- [x] Unknown agent hint → 404 with `agent_not_configured`
- [x] Missing required headers → 400 with structured error
- [x] `/ready` reports `ingress: "ready (queue depth: N)"`
- [x] All 105 unit + integration tests pass
- [x] biome lint clean; typecheck clean

### Notes

- **Stub secret lookup**: Phase 3 ingress routes take a `SecretLookup` callback as a dependency. The router wires in `buildStubSecretLookup()` (rejects every call with `identity_loader_not_yet_implemented`). Phase 4 replaces this with a real loader that reads `identities/*.yml` and matches `agent_hint` → agent + webhook_secret. Tests bypass the stub by injecting their own `SecretLookup`.
- **Raw body capture**: Fastify's default JSON parser doesn't retain the raw bytes. I registered a per-app JSON parser (`parseAs: 'buffer'`) that stashes `req.rawBody` before parsing. Signature verification uses the raw buffer; the parsed body is available for normalizer use.
- **Slack url_verification handshake**: Slack's initial handshake sends `{ type: 'url_verification', challenge }`. Standard practice is to echo the challenge WITHOUT full signature verify — Slack does sign these, but the URL-verification event predates any signature-verify infrastructure the receiving app might have. Documented inline in `routes.ts`.
- **Slash commands + interactivity**: Phase 3 wires the routes but only acks 200. Actual command routing (e.g. `/agents schedule enable`) lands in Phase 9 (Scheduler).
- **Dedup is post-verify**: `tryRegisterDelivery` is called AFTER signature verify + agent lookup succeed. If verify fails, we never touch the DB — an attacker can't fill the dedup table with garbage.
- **`agent as any`**: One `biome-ignore` in `routes.ts` for the agent-id cast when writing to `webhook_deliveries`. Phase 4's classifier will validate the agent ID against the identity registry; for Phase 3 the SecretLookup is trusted (it only returns valid agent names).
- **Queue is fire-and-forget**: No consumer attached in Phase 3. Events accumulate in the buffer until Phase 4 (classifier) attaches. Persistence for restart-safety is handled by `webhook_deliveries` + provider redelivery APIs, not by a durable queue.

---

## Phase 4 — Classifier (event → agent + skill + continuation) (~1 day) ✅

**Goal**: Given a verified webhook event, produce a `Classification` per [ARCHITECTURE.md §1.2 + §2.2](ARCHITECTURE.md#22-event-router).

### Files to create

- [x] `router/src/routing/schema.ts` — zod schema for `identities/*.yml`; tolerates YAML `~` placeholders; narrow `AgentId` guard
- [x] `router/src/routing/loader.ts` — reads + validates each identity file; skips broken files with a warning
- [x] `router/src/routing/registry.ts` — 9 in-memory indices (GitHub App ID, Linear webhook_id, Linear agent_id, Linear user_id, Slack app_id, Slack bot_user_id, labels, channels, auto-triggers); first-writer-wins on collisions
- [x] `router/src/routing/threadKey.ts` — Slack (`slack:channel/ts`), Linear (`linear:ENG-1234`), GitHub (`github:org/repo/pr/N` or `.../issue/N`)
- [x] `router/src/routing/mention.ts` — extracts explicit `@bot` mentions from Slack + GitHub + Linear payloads
- [x] `router/src/routing/skill.ts` — 4-step resolution (selector → label → trigger-default → fallback); per-agent selector maps + label→skill map + defaults
- [x] `router/src/routing/classifier.ts` — 6-step resolution: explicit mention → Linear assignment → GitHub auto-trigger → Linear label → Slack channel-default → agent_hint fallback; returns `Classification` with `match_reason`; integrates continuation via `state/sessions.findContinuation`
- [x] `router/src/routing/secret-lookup.ts` — replaces the Phase 3 stub; uses registry + `SecretProvider` to answer `SecretLookup` calls
- [x] `router/src/routing/index.ts` — public surface
- [x] `router/tests/routing/loader.test.ts` — 6 tests: missing dir, well-formed file, YAML nulls, unknown agent, non-yml files, schema errors (isolated failure)
- [x] `router/tests/routing/registry.test.ts` — 10 tests: all 9 indices + null skipping + first-writer-wins + `findAgentByHint`
- [x] `router/tests/routing/threadKey.test.ts` — 10 tests across Slack (top-level + reply) / Linear (issue + comment) / GitHub (PR + issue + issue_comment on PR)
- [x] `router/tests/routing/classifier.test.ts` — 12 tests covering all 6 resolution steps + skill resolution (selector vs. default) + continuation (new vs. continue)
- [x] `router/tests/routing/secret-lookup.test.ts` — 6 tests: per-provider resolution + not-found paths (unknown hint / missing secret ref / secret fetch fails / no secrets block)

### Acceptance criteria

- [x] All 7 identity files load from the real `dev-team/identities/*.yml` (verified via `/ready`)
- [x] Explicit mention wins over all other signals (`@strategist-bot` in Slack routes to strategist regardless of channel/label)
- [x] Linear ticket assigned to guardian's `user_id` → guardian (`match_reason: linear_assignment`)
- [x] PR opened → guardian (via `github_auto_triggers: [pull_request.opened]` in guardian identity)
- [x] Linear ticket with `campaign` label + no mention → marketer (`match_reason: linear_label`)
- [x] Continuation: prior session in same `thread_key` within window → `continuation: { mode: 'continue', claude_session_id }`
- [x] Unmatched event → `route: 'unmatched'` (no fake routing to default)
- [x] `/ready` reports `routing: "ready (7 identities)"`
- [x] Real webhook flow works end-to-end: Ingress → SecretLookup (from routing registry) → signature verify → dedup → enqueue
- [x] All 150 unit + integration tests pass
- [x] biome lint + typecheck clean

### Notes

- **Real SecretLookup replaces Phase 3 stub**: `server.ts` now calls `buildSecretLookup(registry, secretProvider)` which uses the registry to find the agent and the secret provider to fetch its webhook_secret. All ingress routes now work end-to-end (given a matching identity + populated env vars).
- **First-writer-wins on label collisions**: If two agents claim the same Linear label, the first-loaded identity wins. Curator's quarterly drift check (Phase 8 scheduled work) should surface these — logged as a config smell.
- **Slack selector regex handles both formats**: `@bot-name-bot <selector>` (GitHub/Linear) AND `<@USER_ID> <selector>` (Slack). Documented in `skill.ts`.
- **Continuation window in ms**: `continuation_timeout_days` (from identity) × `DAY_MS`, passed to `findContinuation` which does the "ended_at > now - window" check inside SQLite.
- **Slack channel-default routing needs channel_name**: Slack payloads carry channel IDs (`C0123`) but routing keys use names (`#security`). For v1 we require `channel_name` in the payload; if missing, we fall through to other resolution steps. Full ID→name resolution needs a Slack API call — added to open questions.
- **DEV_TEAM_ROOT env var**: new config; defaults to `/var/lib/agents/dev-team` (production path). Local dev sets it to the repo root.
- **The classifier isn't wired into the queue yet**: Phase 4 stops at "produce a Classification." Phase 6 (Runtime) hooks the queue consumer that reads events, classifies them, and spawns Claude sessions.

---

## Phase 5 — Workspace (worktree manager) (~half day) ✅

**Goal**: Per-task git worktrees at `/var/lib/agents/worktrees/<agent>/<task-id>/`. LRU cleanup. Concurrency-safe via `worktrees` table lease.

### Files to create

- [x] `router/src/workspace/paths.ts` — `sanitizeTaskId` + `worktreePath` + `branchName`; rejects `..`, path traversal, control chars, dotfiles
- [x] `router/src/workspace/git.ts` — `addWorktree` / `removeWorktree` / `pruneWorktreeAdmin` / `hasBranch` / `listWorktrees` via `execFile` (no shell interpolation); `GitError` class
- [x] `router/src/workspace/manager.ts` — `acquireWorkspace(db, cfg, req)` — combines path/branch computation, DB registration, git worktree creation, lease acquisition; returns a `WorkspaceLease` with `.release()`
- [x] `router/src/workspace/prune.ts` — `pruneIdle` + `forcePrune`; skips leased worktrees; runs `git worktree prune` after
- [x] `router/src/workspace/index.ts` — public surface
- [x] `router/tests/workspace/paths.test.ts` — 15 tests (sanitize + worktreePath + branchName)
- [x] `router/tests/workspace/manager.test.ts` — 9 tests against real temp git repos: create, reuse (continuation), parallel tasks, busy lease, release+reacquire, missing repo, escape attempts, pruneIdle, forcePrune

### Acceptance criteria

- [x] First session for task X creates worktree (verified: `README.md` from base branch is present in the worktree)
- [x] Second session for the same task X reuses the worktree (`lease.isReused === true`)
- [x] Two parallel sessions for different tasks get separate worktrees
- [x] Concurrent same-task acquire returns `{ ok: false, reason: 'busy' }`
- [x] Release + reacquire works
- [x] `pruneIdle` removes stale worktrees but skips leased ones
- [x] `forcePrune` removes the N oldest idle worktrees
- [x] Task-ID sanitization rejects `..`, `/`, `\`, spaces, control chars, dotfiles
- [x] All 172 tests pass
- [x] biome lint + typecheck clean

### Notes

- **No shell interpolation**: `git.ts` uses `execFile('git', ['-C', cwd, ...args])`, never `exec` with a shell. Task IDs are already sanitized upstream but this is belt-and-suspenders — even if a bad ID slipped through, argv boundaries protect against shell injection.
- **`--force` on removeWorktree**: Cleanup removes worktrees even with uncommitted changes. Accepts the data loss for mid-run interrupts. Normal-completion sessions should commit + push before triggering cleanup — enforced by Phase 6 SessionEnd hooks.
- **Branch reuse over create**: `addWorktree` checks `hasBranch` first. If the branch exists (continuation across router restarts), reuse it. If not, `-b` creates it from `baseBranch`.
- **Not wired into server.ts yet**: Phase 5 is a library. Phase 6 (Runtime) wires `acquireWorkspace` into the session prep pipeline + `release()` into SessionEnd.
- **Prune scheduling is Phase 9**: `pruneIdle` + `forcePrune` are runnable now but don't fire automatically. Phase 9 (Scheduler) adds a cron entry: something like `router-workspace-prune-daily` running `pruneIdle({ maxIdleMs: 7 * DAY })`.
- **Source repo path is a session-level input**: `acquireWorkspace` takes `sourceRepo` + `baseBranch`. The router will need a mapping from "webhook event → source repo path on disk" — that's Phase-1-bootstrap ops work (clone target repos to `/var/lib/agents/repos/<name>/`). For test/dev, callers pass a local repo path directly.

---

## Phase 6 — Runtime (Claude SDK + hooks + MCP) (~2 days — the biggest phase)

**Goal**: Invoke the Claude Agent SDK with prepared inputs, apply hooks, manage MCP lifecycle. This is the heart of the router.

### Sub-phase 6a — Agent config loader (hot-reload) ✅

- [x] `router/src/config/agentLoader.ts` — mtime-based cache; per-agent bundle (CLAUDE.md + settings.json + mcp.json + skills/*.md)
- [x] `router/src/config/settingsSchema.ts` — zod schemas (`AgentSettings`, `McpConfig`) with passthrough for `_comment` fields + `activeServers()` helper that filters `_`-prefixed placeholder MCPs
- [x] `router/src/config/index.ts` — public surface
- [x] `router/src/routing/loader.ts` — identity loader (done in Phase 4; separate module — different domain)
- [x] `router/tests/config/settingsSchema.test.ts` — 8 tests: minimal + full + rejections + passthrough
- [x] `router/tests/config/agentLoader.test.ts` — 10 tests including a real end-to-end load of all 7 dev-team agents

### Sub-phase 6a acceptance criteria

- [x] Loads CLAUDE.md as raw markdown; settings.json + mcp.json as validated + typed objects
- [x] Cache returns the same reference until any file mtime changes (or files add/remove)
- [x] Missing CLAUDE.md / bad JSON / schema violation → `AgentConfigError` with `agent`, `file`, `reason`
- [x] Missing `skills/` directory is tolerated (returns empty map)
- [x] All 7 real dev-team agents load without error
- [x] `activeServers()` skips underscore-prefixed placeholder entries + silently drops malformed servers

### Sub-phase 6b — Hook handler registry ✅

- [x] `router/src/hooks/types.ts` — `HookHandler`, `ToolCallHookHandler`, `SessionContext`, `ToolCallContext`, `HookResult`, `PhaseResult`
- [x] `router/src/hooks/registry.ts` — command → handler maps + `inferCommand()` (supports both explicit `command:` and shape-based inference)
- [x] `router/src/hooks/orchestrator.ts` — `runSessionPhase` + `runToolCallPhase`; first-gate/first-deny early-exit; unknown-command skip; error accumulation
- [x] `router/src/hooks/placeholder.ts` — `contextVars` + `resolveVars` + `resolvePath` (`<target-project>`, `<target-project>-marketing`, `dev-team/`, `dev-team-state/` prefixes + `${VAR}` interpolation)
- [x] `router/src/hooks/commands/load.ts` — SessionStart file-loader with missing/exception policies
- [x] `router/src/hooks/commands/check.ts` — founding-docs gate
- [x] `router/src/hooks/commands/conditional_load.ts` — skill-conditional loader
- [x] `router/src/hooks/commands/block_if_path_matches.ts` — PreToolUse; glob-based path deny (minimatch)
- [x] `router/src/hooks/commands/block_if_action_matches.ts` — Marketer's publish-gate; action-verb deny
- [x] `router/src/hooks/commands/validate_structured_data.ts` — PostToolUse JSON/YAML parse check
- [x] `router/src/hooks/commands/git_commit.ts` — SessionEnd commit; no-op if unchanged
- [x] `router/src/hooks/commands/git_commit_if_changed.ts` — commit + optional PR intent (Harness's PR-only enforcement uses this)
- [x] `router/src/hooks/commands/lint_stubs.ts` — `lint_and_format` + `format_and_lint` stubs (deferred; Phase 9 wires project tooling)
- [x] `router/src/hooks/index.ts` — public surface
- [x] `router/tests/hooks/_rig.ts` — shared test rig
- [x] `router/tests/hooks/placeholder.test.ts` — 13 tests
- [x] `router/tests/hooks/commands.test.ts` — 20 tests across load/check/conditional_load/block_if_path/block_if_action/validate_structured_data
- [x] `router/tests/hooks/git_commit.test.ts` — 5 tests against real temp git repo (commit + PR intent + no-op + label rules)
- [x] `router/tests/hooks/orchestrator.test.ts` — 9 tests (session phase, tool-call phase, first-gate, first-deny, unknown-command skip, shape-based inference)

### Sub-phase 6b acceptance criteria

- [x] All 8 hook commands implemented + tested
- [x] 2 lint stubs registered (real project-tool integration deferred to Phase 9)
- [x] `classify_path_tier` (Guardian-specific) + `validate` custom validators deferred with documented reasons
- [x] Orchestrator threads SessionContext through every handler
- [x] First gate short-circuits the SessionStart phase; first deny short-circuits PreToolUse
- [x] Placeholder resolver handles both `${VAR}` interpolation and `<target-project>` / `dev-team-state/` path prefixes
- [x] All 237 tests pass; biome + typecheck clean

### Notes

- **What's deferred**: `classify_path_tier` (Guardian's three-tier scan needs `sensitive-paths.yml` infra — Phase 6c or a Guardian-specific extension), `validate` custom validators (e.g. Marketer's `testimonial_permission_check` — needs testimonials/approved.md parsing).
- **Still-inert PreToolUse gate shapes (followups)**: two condition shapes present in `settings.json` are still not recognized by `inferCommand`, so the orchestrator skips them and the gates never fire:
  - `if_url_or_query_matches` + `deny_always` — Marketer's benchmarking gate (blocks login-gated competitor URLs/queries on `WebFetch`/`WebSearch`). Needs a handler that inspects `input.url` / `input.query` against the pattern list.
  - `if_content_matches_pattern` + `validate: testimonial_permission_check` — Marketer's customer-quote gate. Needs the `testimonial_permission_check` validator (parses `testimonials/approved.md`), which is the same deferred-validator work noted above.
  `block_if_command_matches`'s `deny_always` inference deliberately excludes both keys so it never over-blocks them into an unconditional deny; enabling either is a dedicated follow-up (new handler/validator + tests), not part of the `patterns`/`deny_always` fix.
- **`git_commit_if_changed` + `create_pr: true`**: Phase 6b commits locally + returns the PR intent as `side-effect.data`. The actual PR-open call (branch push + GitHub MCP call) is wired in Phase 6d, when the SDK-invocation orchestrator can dispatch to the GitHub MCP.
- **Conditional label rules**: Phase 6b implements the skill-based auto-label (`_misbehavior_debugger` → `urgent`). Path-based conditional labels (`agents/harness/**` → `meta-self-modify`, `router/src/**` → `router-change`) need access to the actual diff — added in Phase 6d. *(Phase 6d never did it. Implemented in HAR-13 / #66 against `git diff <base>...HEAD`; `router-change` now matches `router/**`, `deploy/**` and `identities/*.yml`.)*
- **Shape-based inference**: for hook entries without an explicit `command:` field but with a distinctive field like `block_if_path_matches: [...]`, the orchestrator infers the command from shape. Matches how the real settings.json files are authored. Covers `block_if_path_matches`, `block_if_action_matches`, and (added later) `block_if_command_matches` — the last handles `patterns`/`pattern` regex gates (git-push-to-main, `--no-verify`/`--force` bypass) and flat `deny_always` tool denials (`merge_pull_request`, `mcp__infisical__*`, `mcp__secrets__*`) that every agent's settings.json relies on.

### Sub-phase 6c — MCP lifecycle ✅

- [x] `router/src/mcp/types.ts` — `SpawnedMcp`, `McpBundle`, `McpEnvResolutionError`, `McpSpawnError` *(all but `McpEnvResolutionError` removed in [#12](https://github.com/German969/dev-team/pull/12))*
- [x] `router/src/mcp/env.ts` — resolve `${VAR}` references in mcp.json env from session `SessionEnv`; strict-fail on missing
- [x] `router/src/mcp/spawn.ts` — spawn stdio MCP children via `child_process.spawn` (no shell); pipe stderr → session log; skip servers with unresolved env / immediate crash; readiness delay 250 ms default
- [x] `router/src/mcp/teardown.ts` — SIGTERM → wait → SIGKILL after 10 s; parallel across handles; per-server `TeardownReport`
- [x] `router/src/mcp/index.ts` — public surface
- [x] `router/tests/mcp/env.test.ts` — 7 tests (placeholders, literals, mix, missing-var, error metadata, empty block, mid-string treated literal)
- [x] `router/tests/mcp/spawn.test.ts` — 10 tests (env injection, `_`-prefixed skip, missing env skip, crash-at-spawn skip, graceful SIGTERM, SIGKILL after timeout, already-exited, parallel teardown, empty bundle)

### Sub-phase 6c acceptance criteria

- [x] `activeServers()` filters `_`-prefixed and malformed entries at the config layer; spawn only iterates good ones
- [x] Env resolution is strict — a missing `${VAR}` skips the server + logs error rather than spawning with an empty credential
- [x] Immediate spawn failures (ENOENT / spawn error / instant exit) drop the server from the bundle without throwing (session degraded, not aborted)
- [x] Teardown is best-effort + parallel; SIGKILL only fires when SIGTERM times out
- [x] All 254 tests pass; biome + typecheck clean

### Notes

- The `ChildProcess` handles are ready for the Claude Agent SDK — Phase 6d wires the SDK's `mcpServers` argument to receive `McpBundle.handles`. stdin/stdout are left piped (untouched by the router) so the SDK owns the JSON-RPC transport.
  - **Superseded.** That wiring never landed: the Anthropic adapter builds `options.mcpServers` from `mcpServersConfig` and never read the handles. The spawn path was removed in [#12](https://github.com/German969/dev-team/pull/12) — see the double-spawn cleanup item below.
- The `session-logs` filesystem MCP (Harness's misbehavior-debugger dependency) is still a placeholder in `agents/harness/mcp.json` — its final shape (filesystem MCP vs router-internal endpoint) is decided in Phase 6d + 10.

### Sub-phase 6d — Claude SDK invocation ✅

- [x] `router/src/runtime/sdk.ts` — `SdkClient` interface + `SdkRunInputs` + `SdkCallbacks` + `SessionOutcome` + `PlaceholderSdkClient` (real SDK swap-in is Phase 13)
- [x] `router/src/runtime/preflight.ts` — cost-cap check + SessionStart-hook gate check
- [x] `router/src/runtime/sessionPrep.ts` — Prepare phase orchestration (§1.3): preflight → workspace (opt) → secrets → MCP boot → SessionContext
- [x] `router/src/runtime/sdkCall.ts` — invokes `SdkClient.runSession` with bridged callbacks (PreToolUse via `runToolCallPhase`, per-turn cost + per-job cap cancellation)
- [x] `router/src/runtime/sessionComplete.ts` — Complete phase (§1.5): SessionEnd hooks → session row update → MCP teardown → workspace release; each step guarded
- [x] `router/src/runtime/errorHandler.ts` — `categorizeError` + `mapErrorToStatus`: MCP / rate-limit / transient / config / unknown → SessionStatus
- [x] `router/src/runtime/orchestrator.ts` — top-level `runSession()` (prep → sdk → complete; guarantees completion runs regardless of SDK outcome)
- [x] `router/src/runtime/index.ts` — public surface
- [x] `router/tests/runtime/integration.test.ts` — 9 tests: golden path, SessionStart context threading, cost-cap refusal, founding-docs gate, per-job cap mid-cancel, SDK error mapping (2 categories), SessionEnd hook order, PreToolUse deny bridge

### Sub-phase 6d acceptance criteria

- [x] A prepared session runs Prepare → SDK → Complete end-to-end (mocked SDK)
- [x] SessionStart hooks load context files → threaded into `SdkRunInputs.initialContext`
- [x] PreToolUse hooks intercept and can deny tool calls via the SDK bridge (verified via `mcp__cms__publish` publish-gate test)
- [x] SessionEnd hooks commit state + return PR intents (`git_commit` integration exercised)
- [x] MCP servers spawn at prep + terminate at complete (integration test uses empty MCP config; unit tests in 6c cover env injection + teardown outcomes)
- [x] Founding-docs gate refuses substantive sessions when required files are missing (test drops STACK.md → session marked `gated`)
- [x] Cost cap refuses over-limit sessions BEFORE SDK invocation (SDK is not called; test asserts `sdk.received === undefined`)
- [x] Per-job cap cancels mid-session; final status = `cancelled`
- [x] SDK error → status mapped via `categorizeError` (permission_denied → `failed`; ETIMEDOUT → `interrupted_needs_resume`)
- [x] All 263 tests pass; biome + typecheck clean

### Notes

- **SDK is stubbed**: `PlaceholderSdkClient.runSession` always returns `{kind: 'error'}`. Real SDK wiring is Phase 13. The `SdkClient` interface is what every runtime call depends on — swapping in `@anthropic-ai/claude-agent-sdk` is a one-adapter change; nothing else in the runtime module needs to move.
- **PostToolUse is deferred to a runtime-lifecycle wiring**: the current design treats PostToolUse as a per-tool-call side-effect that would need SDK hook points. Empty entries pass through today; when the real SDK is wired, `sdkCall.ts` will bridge `onToolResult` → `runToolCallPhase('PostToolUse', ...)`.
- **Cost cap is checked at prep AND per-turn**. Prep refuses if `perJobCostUsd + monthToDate > monthlyCostUsd`. Per-turn cancels the SDK loop if session cost exceeds `perJobCostUsd`. Phase 8 will add the 80% warning + reset cron.
- **Workspace acquisition is opt-in** (`acquireWorkspace: false` in the integration test to avoid needing a real repo). Real-world flows will pass `true` for Builders / Guardian PR reviews; read-only sessions (Strategist digest, Marketer draft) skip it.
- **`completeSession` is guaranteed to run** even if the SDK throws or the prep partially failed after workspace acquisition — the orchestrator ensures MCP teardown + workspace release happen. Missing this would leak worktrees + zombie processes.

---

## Phase 7 — Reply streamer ✅

**Goal**: Stream Claude output back to the trigger surface (Slack thread, Linear comment, PR comment) in real time + post the session footer.

### What landed

- [x] `router/src/reply/types.ts` — `ReplyTarget` (discriminated by provider) + `StreamChunk` + `SessionFooter` + `ReplyClient` interface + `FetchLike` injection point
- [x] `router/src/reply/batcher.ts` — `ReplyBatcher`: coalesces chunks + flushes at `intervalMs`; `finalize` bypasses the timer + is idempotent; per-flush error → `onError` callback, batcher keeps going
- [x] `router/src/reply/footer.ts` — `renderFooter`: agent • skill • duration • $cost • session-link (optional log-link)
- [x] `router/src/reply/slack.ts` — `chat.postMessage` on first send, `chat.update` on subsequent; 1000ms batching; native fetch
- [x] `router/src/reply/linear.ts` — GraphQL `commentCreate` / `commentUpdate`; 200ms batching
- [x] `router/src/reply/github.ts` — `POST /repos/O/R/issues/N/comments` then `PATCH /repos/O/R/issues/comments/ID`; 500ms batching
- [x] `router/src/reply/streamer.ts` — `buildReplyClient` factory + `ReplyStreamer` class (accumulates + push+finalize)
- [x] `router/src/reply/index.ts` — public surface
- [x] `router/src/consumer/replyTarget.ts` — `resolveReplyTarget(event, sessionEnv)` → `ReplyTarget | undefined` (per-provider parsing of channel/issue_id/PR-number + token lookup)
- [x] `router/tests/reply/footer.test.ts` — 4 tests (fields, no skill, log link, duration bands)
- [x] `router/tests/reply/batcher.test.ts` — 5 tests (first-chunk-fast, coalesce, finalize idempotent, error resilience, push-after-finalize noop)
- [x] `router/tests/reply/slack.test.ts` — 3 tests (post → update, thread_ts, Slack ok:false surfaced)
- [x] `router/tests/reply/streamer.test.ts` — 6 tests (factory returns correct client per provider + full push+finalize routing for each)
- [x] `router/tests/consumer/replyTarget.test.ts` — 11 tests across all 3 providers

### Acceptance criteria

- [x] Slack: streaming output appears as message updates (not new messages per chunk) — post-then-update sequence tested
- [x] Linear: comment edits in place — commentCreate returns id, subsequent chunks use commentUpdate
- [x] GitHub: PR/issue comment edits in place — POST returns comment id, subsequent chunks PATCH
- [x] Footer appears at session completion with all metrics — `renderFooter` composes agent + skill + duration + cost + link
- [x] Per-provider rate limits respected — Slack 1000ms, Linear 200ms, GitHub 500ms; batcher enforces via lastFlushAt gate
- [x] Zero new external SDK deps — uses native fetch throughout
- [x] All 381 tests pass; biome + typecheck clean

### Notes

- **No @slack/web-api / @linear/sdk / @octokit/rest.** The endpoint surface we need is tiny (create + update × 3 providers). Using native fetch keeps the dep tree flat + startup fast, and avoids being locked into any SDK's version churn.
- **Runtime wiring is deliberately deferred to Phase 13.** The reply layer is standalone + fully tested. Tying it into `runSession` (`onPartial: chunk => streamer.push` + `streamer.finalize(footer)` after the SDK returns) requires resolving secrets outside the runtime OR restructuring runSession to expose an "env resolved" callback. Since PlaceholderSdkClient never streams anything today, the wiring gains no functional value until the real SDK arrives. The `resolveReplyTarget()` helper is ready to be plugged in.
- **Message-editing semantics via idempotent PATCH.** Every provider is "post once, edit many times." Batching stores the current comment id / ts and swaps endpoint after the first successful post. This means the SDK can emit 100 chunks in a second and we'll only make 1-2 API calls per second per provider.
- **finalize is idempotent.** Called twice? No-op after the first. This matters because both the runtime's happy-path completion AND its error-path cleanup would like to flush the footer; making finalize safe to double-call avoids finger-pointing about ownership.
- **`onError` doesn't kill the batcher.** A Slack 429 or a Linear GraphQL error surfaces via the callback but the batcher keeps accepting chunks; the next flush retries. Aggressive give-up isn't the right behavior — a transient failure shouldn't stop the whole reply.
- **`resolveReplyTarget` lives in `consumer/`, not `reply/`.** The reply layer knows nothing about webhooks. Turning a WebhookEvent into a ReplyTarget is the consumer's job.

---

## Phase 8 — Cost cap + ledger ✅

**Goal**: Pre-flight check refuses sessions over monthly cap; per-turn ledger updates; per-job cap cancels mid-session; 80% warning posts to `#agents-alerts`.

### What landed

- [x] `router/src/runtime/preflight.ts` — cost-cap pre-flight (done in 6d)
- [x] `router/src/runtime/sdkCall.ts` — per-turn cost persist + per-job cap cancel (done in 6d)
- [x] `router/src/runtime/capWarnings.ts` — 80% + 100% threshold posts with per-month idempotency
- [x] `router/src/observability/alerts.ts` — `AlertPoster` interface + `NoopAlertPoster` + `MemoryAlertPoster`
- [x] `router/src/observability/index.ts` — public surface
- [x] `router/src/state/migrations/001-cost-alerts.sql` — `cost_alerts_emitted` idempotency table
- [x] `router/src/state/cost_alerts.ts` — `wasAlertEmitted` + `recordAlertEmitted`
- [x] `router/tests/cost/capWarnings.test.ts` — 7 tests (below-threshold, 80% cross, idempotency, jump-both, per-agent isolation, divide-by-zero)
- [x] `router/tests/observability/alerts.test.ts` — 2 tests (memory + noop posters)

### Acceptance criteria

- [x] Sessions refuse when monthly cap is hit (per agent) — 6d preflight + 6d integration test
- [x] Sessions cancel mid-run when per-job cap exceeded — 6d per-turn cancel + 6d integration test
- [x] `#agents-alerts` gets a post at 80% threshold (once per agent per month) — `checkCapWarnings` + `cost_alerts_emitted` PK
- [x] Both 80% and 100% thresholds fire in a single call when a session jumps across both bands
- [x] Monthly counters reset cleanly on the 1st (UTC) — implicit; `cost_ledger` is per-day + PK includes year/month, so a new month naturally reads $0

### Notes

- **No `monthlyReset.ts` needed**: the schema is already per-month bucketed. `getMonthlyAgentSpend(agent, year, month)` returns 0 for a fresh month automatically — nothing to "reset."
- **`AlertPoster` is stubbed**: `NoopAlertPoster` is the default; `MemoryAlertPoster` is for tests. Real Slack impl lands in Phase 10 (or Phase 7 if the reply streamer surfaces first) — one adapter class implementing the same interface.
- **Threshold order matters**: 100% is checked BEFORE 80% so a single call can emit both alerts when a session jumps over both bands (e.g. $0 → $120 on a $100 cap). Order in the returned `emitted[]` reflects that: `[100, 80]`.
- **Divide-by-zero guard**: `monthlyCostUsd: 0` returns `percentOfCap: 0` (never emits). Prevents nuisance-post storms if a config is misconfigured.

---

## Phase 9 — Scheduler (cron + overrides) 🟡 Core done

**Goal**: Load `scheduler/schedules.yml`; register entries with croner; respect `enabled` + phase gate + runtime overrides; expose Slack slash-commands + CLI for toggle.

### What landed

- [x] `router/src/scheduler/schema.ts` — zod schemas (`ScheduleEntrySchema`, `ReplyToSchema`); agent narrowed to `AgentId` union
- [x] `router/src/scheduler/loader.ts` — mtime-cached YAML loader; duplicate-id detection; `ScheduleFileError`
- [x] `router/src/scheduler/projectPhase.ts` — reads `<target-project>/.dev-team.yml`; defaults to `phase-0` on missing/bad; `phaseSatisfies` comparator
- [x] `router/src/scheduler/effective.ts` — `resolveEffective` — YAML → override → phase-gate resolution
- [x] `router/src/scheduler/runner.ts` — croner registration; `fireOnce` for testing/admin dispatch; overlap guard via `hasActiveRunFor`; records to `schedule_runs` on every tick
- [x] `router/src/scheduler/index.ts` — public surface
- [x] `router/tests/scheduler/loader.test.ts` — 7 tests (minimal, full, unknown-agent reject, duplicate-id, empty, mtime cache, real schedules.yml)
- [x] `router/tests/scheduler/effective.test.ts` — 8 tests (YAML/override combos, phase-gate crossing, missing .dev-team.yml default)
- [x] `router/tests/scheduler/runner.test.ts` — 6 tests (fires when enabled, skipped_disabled/phase_gate/overlap outcomes, onTick throws → `failed_to_start`, override enable)
- [x] Croner installed (`croner ^10.0.1`)

### Deferred (surface + integration bits)

- [ ] `router/src/scheduler/slashCommands.ts` — Slack `/agents schedule …` handler
- [ ] `router/src/scheduler/admin.ts` — admin authz gate
- [ ] Wire runner's `onTick` → `runSession` in the top-level server entrypoint (Phase 12 integration)

### Acceptance criteria

- [x] `schedules.yml` entries load + zod-validate; real project file parses
- [x] Default-off discipline holds — YAML `enabled: false` + no override → `disabled`
- [x] Phase gate blocks enabled-in-config entries when project phase is below required
- [x] Overlap protection prevents stacking (checks `sessions.status = 'running'` linked from `schedule_runs`)
- [x] Schedule run history persisted (every tick writes a `schedule_runs` row with outcome)
- [ ] `/agents schedule enable <id>` from Slack → next tick fires (deferred — slash-command surface)
- [ ] `/agents schedule list` returns the full state (deferred — same)

### Notes

- **Effective state is re-resolved at each tick**, not at registration. That's the "hot toggle" story — `setOverride(...)` in the DB takes effect on the very next cron fire without a restart.
- **Croner used as-is**: pattern + `{ timezone, name, catch }` + a callback. The callback is a thin wrapper that fires `handleTick` and swallows Promise rejections (croner's callback is `void | Promise<void>` — a `ScheduleOutcome` return would break the type).
- **`fireOnce` is the same code path** as the cron callback (both go through `handleTick`). Admin-triggered "run now" gets identical semantics to a scheduled tick — overlap guard included.
- **No `overrides.ts` module** — the state helpers (`setOverride`, `getOverride`, `clearOverride`) already live in `src/state/schedule.ts` from Phase 1. `effective.ts` uses them directly. Adding a scheduler-side facade would be pure indirection.
- **Slash-command surface deferred**: needs Slack signature verification threaded from ingress into a dedicated `/webhooks/slack/commands` handler, admin-list config (`identities/router.yml` or env), and immediate-response semantics within Slack's 3s window. Cleaner to build after the Slack MCP integration exists (Phase 7 or 10).

---

## Phase 10 — Observability ✅ Core done

**Goal**: Pino structured logs → stdout + per-session jsonl; Sentry errors with session_id; Prometheus metrics; Slack webhook for alerts.

### What landed

- [x] `router/src/observability/sessionLog.ts` — `openSessionLog({ logDir, sessionId })` returns a synchronous jsonl writer at `<logDir>/<id>.jsonl`; `noopSessionLog(id)` for disabled runs
- [x] `router/src/observability/metrics.ts` — `createMetrics()` builds a fresh Prometheus `Registry` with all 10 metrics documented in ARCHITECTURE.md §2.12 (session_total, session_duration, session_cost, cap_proximity, webhook_total, signature_failure, mcp_status, in_flight, pending, sqlite_bytes); `scrape(m)` returns the exposition text
- [x] `router/src/observability/slackAlertPoster.ts` — `SlackAlertPoster` implements `AlertPoster` interface (from Phase 8); posts one-shot messages to `chat.postMessage` via native fetch; injectable `fetch` + `defaultChannel` + `onError`; `renderAlertText` composes title + body + bulleted fields
- [x] `router/src/observability/index.ts` — expanded public surface
- [x] `router/src/server.ts` — `GET /metrics` endpoint added; `BuildServerOverrides.metrics` for test injection
- [x] `router/tests/observability/sessionLog.test.ts` — 5 tests (jsonl append, ts fill-in, multi-line append, nested dir creation, noop)
- [x] `router/tests/observability/metrics.test.ts` — 5 tests (all metric names present, counter labels, histogram buckets, gauge value, default node metrics opt-in)
- [x] `router/tests/observability/slackAlertPoster.test.ts` — 7 tests across `renderAlertText` + `SlackAlertPoster` (bearer + channel, fallback channel, missing-channel onError, Slack API error, HTTP error)
- [x] `router/tests/observability/metricsRoute.test.ts` — 2 tests (`/metrics` returns Prometheus text, injected registry surfaces its counters)
- [x] `prom-client` installed (`^15.1.3`)

### Acceptance criteria

- [x] `<logDir>/<id>.jsonl` created per session + accepts appended lines
- [x] Secrets never appear in logs — inherited from Phase 2's pino `redact` config (unchanged by Phase 10)
- [x] `/metrics` endpoint returns valid Prometheus exposition
- [x] All 10 metrics defined per ARCHITECTURE.md §2.12
- [x] `SlackAlertPoster` implements the AlertPoster interface — drop-in replacement for `NoopAlertPoster` when Phase 13 provides a real Slack bot token
- [x] All 400 tests pass; biome + typecheck clean

### Deferred

- [ ] `sentry.ts` — Sentry init + session_id tagging. Deferred: needs an API key + SaaS account setup. Adding it is one file (`@sentry/node`.init + a `withScope` helper) once the deploy is ready.
- [ ] `alertRules.ts` — continuous evaluators for the 8 alert conditions. In practice this belongs in Prometheus alertmanager (or Grafana Cloud), not the router. The router emits the underlying metrics; a scraper evaluates the rules. Keeping the rules in-router would duplicate what Prometheus already does well.
- [ ] Runtime + consumer wiring to actually write session events to `sessionLog`. Same story as Phase 7's reply-streamer wiring: today's `PlaceholderSdkClient` doesn't emit anything real to log. Phase 13 wires both.
- [ ] `session --tail` in the CLI — needs the sessionLog to be actively written to first.

### Notes

- **Fresh Registry per server instance**, not the global default. Every `createMetrics()` call creates its own Registry so tests can inspect isolated state + the server owns its metrics lifecycle. `prom-client`'s default global would leak across test runs.
- **`SlackAlertPoster` is one-shot, not streaming**. Distinct from Phase 7's `SlackReplyClient` (which post-then-edits). Alerts fire and forget; no batching needed. Reuses the same fetch pattern to keep the deps flat.
- **`onError` swallows Slack failures instead of throwing**. Alerts are best-effort — a Slack outage shouldn't cascade into router errors. Errors get logged; the caller (cap warnings, error handlers) proceeds.
- **Metrics defined but not yet emitted from most call sites**. The registry + endpoint are ready; each phase's code should update the relevant counters at its natural events (session complete → sessionTotal + sessionDuration + sessionCost; webhook received → webhookTotal; MCP spawn → mcpStatus). These call-site updates are best done alongside the runtime wiring in Phase 13, when actual traffic can validate them.

---

## Phase 11 — `dev-team-logs` CLI ✅

**Goal**: Operational CLI per [ARCHITECTURE.md §2.12](ARCHITECTURE.md#212-observability). Separate binary; reads SQLite + jsonl files + optionally Axiom.

### What landed

- [x] `router/src/cli/argv.ts` — dependency-free argv parser (`parseArgv`, `getStringFlag`, `hasFlag`)
- [x] `router/src/cli/format.ts` — `fmtTs`, `fmtUsd`, `table`, `parseDuration`, `parseYearMonth`
- [x] `router/src/cli/commands/session.ts` — `session <id>` (linked schedule_run if from cron)
- [x] `router/src/cli/commands/agent.ts` — `agent <name> [--since] [--status]`
- [x] `router/src/cli/commands/trigger.ts` — `trigger <thread-key>`
- [x] `router/src/cli/commands/cost.ts` — `cost --month YYYY-MM`
- [x] `router/src/cli/commands/schedule.ts` — `schedule <list|enable|disable|reset|run|history>`
- [x] `router/src/cli/main.ts` — dispatcher + env-config surface
- [x] `router/src/cli/index.ts` — public exports
- [x] `router/tests/cli/argv.test.ts` — 11 tests
- [x] `router/tests/cli/format.test.ts` — 10 tests
- [x] `router/tests/cli/commands.test.ts` — 21 tests (all commands + subcommands)

### Acceptance criteria

- [x] `dev-team-logs session <id>` prints session row + trigger_payload + linked schedule_run
- [x] `dev-team-logs schedule list` outputs the table (id, agent, cron, state, source, last_run, last_outcome)
- [x] `dev-team-logs schedule enable <id>` writes override + appends history + reports new effective state
- [x] `schedule disable` / `reset` / `run` / `history` all working end-to-end
- [x] Smoke-tested against the real `/path/to/dev-team/scheduler/schedules.yml` (23 entries)
- [x] `cost --month YYYY-MM` returns per-agent breakdown + month total
- [x] `trigger <thread-key>` cross-agent listing with thread total cost
- [x] `agent <name> --since 1h --status running` filters both dimensions

### Deferred

- [ ] `session <id> --tail` — needs jsonl session log; Phase 10 wires that
- [ ] `schedule list --next 7d` — needs croner introspection to compute next-fire times
- [ ] `bin: { dev-team-logs }` — declaration in package.json; Phase 13 (deploy) adds it alongside the compiled output path

### Notes

- **Zero new deps**. Argv parser + table renderer + duration parser all hand-rolled — Commander/Cac would be overkill for the ~200 lines this CLI needs. Also keeps startup fast (SQLite open + migrations in ~30 ms).
- **Command handlers are pure functions**: `(db, args) → string` (or `(db, args, opts) → Promise<string>` for `schedule`). Testable without spawning a subprocess; every test in `commands.test.ts` calls handlers directly.
- **CLI actor recorded in overrides**: `CLI_ACTOR` env var → `process.env.USER` → `'cli'`. Ensures the audit trail (`schedule_override_history.set_by`) attributes changes to a human, not "cli".
- **`schedule run` in the CLI is a stub tick**: no SdkClient / secretProvider wired in from the CLI, so `onTick` is a noop. It still records `schedule_runs` + returns the outcome — the router process picks up dispatch when Phase 12 wires the bridge.

---

## Phase 12 — Integration tests ✅

**Goal**: End-to-end tests covering the verification list in [PLAN.md → Verification](../PLAN.md#verification).

### What landed

The bigger discovery in Phase 12: the ingress queue had no consumer wired. Webhooks landed in the queue and stopped there. Building the missing bridge was Phase 12's real work; the integration test proves it.

- [x] `router/src/consumer/extractMessage.ts` — per-provider "initial message" extractor (Slack `event.text`, Linear `body/description/title`, GitHub `comment.body / review.body / pr.title+body / issue.title+body`)
- [x] `router/src/consumer/consumer.ts` — `handleEvent`: classify → find identity → load agent config → create session row → `runSession(...)`; typed `ConsumerOutcome` (unmatched / identity_missing / config_load_failed / dispatched)
- [x] `router/src/consumer/index.ts` — public surface
- [x] `router/src/server.ts` — `buildServer(overrides)` accepts `sdk`, `alertPoster`, `dbPath`, `devTeamRoot`, `targetProjectRoot`, `projectName`; wires `queue.onEvent(consumer)`
- [x] `router/tests/consumer/extractMessage.test.ts` — 9 tests across all 3 providers
- [x] `router/tests/consumer/consumer.test.ts` — 4 tests (matched dispatch, unmatched, config_load_failed, continuation link)
- [x] `router/tests/integration/end-to-end.test.ts` — 4 tests:
  - `/health` + `/ready` (subsystems all report `ready`)
  - full Slack webhook signature → dispatched → session `completed` (matches PLAN test 3 solo-agent)
  - dedup (same delivery_id twice → 202 then 200 `deduplicated`; SDK called once)
  - bad signature → 401, SDK not invoked

### Acceptance criteria

- [x] Consumer bridge lives + is wired into server.ts
- [x] `POST /webhooks/slack/events` end-to-end goes signature verify → normalize → classify → runtime → completed session row
- [x] Idempotency: same delivery_id enqueued twice → dispatched once
- [x] Signature failure returns 401 without invoking the SDK
- [x] `/health` + `/ready` return 200 when subsystems load
- [x] All 352 tests pass (352 total; 19 new for Phase 12)

### Notes

- **Not every PLAN item got a dedicated integration test.** Most (cost-cap, phase-gate, hot-reload, schedule activation, recovery, harness-pr-only) are already exhaustively covered by unit tests in earlier phases. Duplicating them as HTTP-shaped tests would add wall-clock cost without new signal. The integration test focuses on the one path that WAS still notional — the ingress → runtime bridge.
- **`resetDbForTests()` between integration tests.** `initDb` uses a process-level singleton — without a reset, test 2 would reuse test 1's stale DB pointer (whose file was rm'd in `afterEach`). This is a real bug the tests would surface if a second router process ever booted in the same node — worth documenting.
- **`buildServer` overrides make the module unit-testable.** `dbPath` + `devTeamRoot` used to be locked to `config.STATE_DB_PATH` / `config.DEV_TEAM_ROOT` at module load. Threading them as overrides doesn't change production behavior (defaults still apply) but lets tests run against tmp dirs.
- **Deferred integration scenarios**: `harness-scope-deny` (writeScope enforcement — hook infrastructure exists but no `writeScope`-checking PreToolUse hook is registered yet), `parallel-agents` (workspace concurrency already unit-tested but a real 3-way race test would need real repos), `hot-reload` (mtime caches are already tested and the E2E surface would be `write file → wait → dispatch → assert new content` — flaky by nature). All can be added later if a specific regression pushes for it.

---

## Phase 13 — Deploy stack ✅

**Goal**: Production-deployable Docker stack: router + cloudflared + Infisical. Documented bootstrap process.

Split into two passes to keep changes reviewable:

### Sub-phase 13a — Runtime wiring ✅

Wired the deferred integrations (sessionLog, reply streamer, metric emission) into the runtime + consumer so Phase 7 / Phase 10 stop being "built but disconnected."

- [x] `RunSessionOptions` accepts `sessionLog`, `buildReplyStreamer` factory, `metrics` registry
- [x] Runtime writes `session.started` / `session.refused` / `session.setup_failed` / `session.completed` jsonl events
- [x] Reply streamer factory called AFTER `prepareSession` (so secrets are available); `onPartial → streamer.push`; `streamer.finalize(footer)` after SDK returns
- [x] Metrics updated per-session: `sessionTotal(agent, skill, outcome)`, `sessionDuration(agent, skill)`, `sessionCost(agent)`, `inFlight` up/down
- [x] Consumer opens the session log + builds the streamer factory + threads metrics through
- [x] `SESSION_LOG_DIR` added to config (default `/var/log/agents/sessions`)
- [x] `router/tests/runtime/wiring.test.ts` — 5 tests (session log lines, metrics counters + duration + cost, streamer with Slack fetch mock)

### Sub-phase 13c — Deploy artifacts ✅

- [x] `deploy/Dockerfile` — 3-stage build (deps → build → runtime); non-root user; tini as PID 1
- [x] `deploy/docker-compose.yml` — router + cloudflared + infisical + git-pull sidecar + shared network + persistent volumes + healthcheck
- [x] `deploy/.env.example` — router + Infisical + repo + tunnel vars documented
- [x] `deploy/cloudflared/config.example.yml` — tunnel template
- [x] `deploy/infisical/.env.example` — encryption + auth + JWT secrets
- [x] `deploy/infisical/README.md` — first-boot Infisical checklist + secret-naming convention
- [x] `deploy/scripts/git-pull-loop.sh` — clones + `git pull --rebase` every 60s
- [x] `deploy/backup.sh` — online SQLite `.backup` + gzip + retention + optional S3
- [x] `deploy/README.md` — full VPS provisioning runbook (11 steps: provision → clone → configure → build → Infisical bootstrap → start → backup cron → smoke test → restore → upgrade → SDK wiring)
- [x] `router/src/runtime/ANTHROPIC_SDK.md` — adapter shape + instantiation notes for when `@anthropic-ai/claude-agent-sdk` gets installed
- [x] `router/package.json` — `bin: { "dev-team-logs": "dist/cli/main.js" }` + shebang added to CLI

### Acceptance criteria

- [x] `pnpm build` produces `dist/cli/main.js` with a `#!/usr/bin/env node` shebang
- [x] Dockerfile builds successfully in principle (multi-stage, pinned base image, non-root user)
- [x] docker-compose defines router + cloudflared + infisical + git-pull-loop + healthcheck + volume mounts
- [x] .env.example enumerates every env var
- [x] Deploy README walks a new operator through Hetzner provisioning → running router end-to-end
- [x] Backup script tested for correctness (sqlite3 `.backup` + gzip + retention)
- [x] Anthropic SDK swap point documented in [ANTHROPIC_SDK.md](../src/runtime/ANTHROPIC_SDK.md)

### Landed after initial 13c

- [x] **Real Anthropic SDK adapter** (`anthropicAdapter.ts`) — implemented against `@anthropic-ai/claude-agent-sdk@0.3.204`. Translation-only: `SdkRunInputs` → SDK `Options`, `SDKMessage` stream → `SdkCallbacks`, terminal `SDKResultMessage` → `SessionOutcome`. Cost estimated via a per-model rate table (opus/sonnet/haiku) with a `default` fallback. 2 smoke tests + `SdkRunInputs.mcpServersConfig` extension so the SDK spawns its own MCP children.
- [x] **Dockerfile better-sqlite3 native binding fix** — deps stage installs `python3 make g++` + drops `--ignore-scripts` so `better-sqlite3`'s postinstall builds the native `.node` binary against the container's arch.

### Deferred (last-mile / not blocking)

- [x] **MCP double-spawn cleanup** — done in [#12](https://github.com/German969/dev-team/pull/12). Went further than the two options sketched here (skip-when-anthropic / make MCP-ownership a client property): `SdkRunInputs.mcpServers` turned out to have **no reader at all**, in any adapter, so the handles were not an extension point worth gating — they were dead weight. `spawnMcpServers`/`teardownMcpServers`, `McpBundle`, `SpawnedMcp` and `McpSpawnError` were removed outright; `pickChildBaseEnv` moved to `mcp/env.ts`, which `sdkCall.buildMcpServersConfig` already used. The router now only resolves MCP config; the SDK owns the whole child lifecycle.
- [ ] **Cost reconciliation with SDK's total_cost_usd** — our per-turn `estimateTurnCost` uses a hand-maintained rate table. The SDK's terminal `SDKResultSuccess.total_cost_usd` is authoritative. Adjust the ledger at session complete to reconcile: `ledger_delta = sdk_total_cost - accumulated_estimates`. Small delta expected; matters if pricing changes and the table drifts.
- [ ] **`docker-compose.override.example.yml`** — local-dev overrides. In practice `docker compose -f deploy/docker-compose.yml up --build router` suffices for local iteration.
- [ ] **Sentry** — `sentry.ts` + `@sentry/node`. Adding this is a single-file change once a Sentry DSN is provisioned.
- [ ] **Live deploy validation** — actually running `docker compose up` end-to-end on a Hetzner VPS. That's operator work, not code work; the artifacts + runbook are ready.

### Notes

- **The wiring pattern is a factory that receives resolved env, not a pre-built streamer.** The consumer can't build the streamer before `runSession` runs because it doesn't have the session env yet (secrets are resolved inside the runtime). Passing `buildReplyStreamer: (env) => ReplyStreamer | undefined` lets the runtime call it at the right moment, after `prepareSession` completes but before the SDK loop starts. Same pattern would work for future integrations that need per-session env.
- **The Anthropic SDK is deliberately not shipped in-tree.** We don't bake in a specific SDK version until we've validated compatibility with a real API key against real webhooks. Every module (runtime, hooks, reply, session log, metrics) is agnostic to which `SdkClient` implementation is used.
- **Runtime wiring is idempotent to disabled deps.** Every new option (`sessionLog`, `buildReplyStreamer`, `metrics`) is optional; the runtime does no-op branches when they're absent. All existing tests continued to pass after the wiring — zero regressions on 400+ tests.
- **`dev-team-logs` is now a first-class binary.** `pnpm build` emits it with a shebang; `npm link` (or the Docker image's node_modules) surfaces it as a shell command. No separate CLI package.

---

## Cross-phase concerns (apply throughout)

- **Type safety end-to-end** — every external input (webhook payload, settings.json, identities/*.yml, schedules.yml, mcp.json) parsed via zod with descriptive errors. No `any` in production paths.
- **Pino logger threaded through** — every function that does anything observable takes a logger parameter (child of the session logger). No `console.log` anywhere in src/.
- **Test as you go** — each module gets unit tests in the same phase. Integration tests are Phase 12, not a Phase 12-only activity.
- **No secrets in tests** — test fixtures use placeholder values; the real secret-resolver layer is mocked.
- **Match the established stack** ([ARCHITECTURE.md §0](ARCHITECTURE.md#0--orientation)) — TypeScript / Node 20 / Fastify / SQLite / Infisical / pino / Sentry / Prometheus / Claude Agent SDK. Don't deviate without an explicit ADR-style rationale in this doc.

---

## Resume protocol (for multi-session work)

When picking back up in a fresh session:

1. Read this file's "Overall status" table to see the current phase + state
2. Read the in-progress phase's checklist to see what's done vs. pending
3. Read [ARCHITECTURE.md](ARCHITECTURE.md) for the design of the phase you're in
4. Check `git log --oneline -5` for what was last committed
5. Run `pnpm test` to verify the current state is green
6. Continue from the next unchecked item

When ending a session mid-phase:

1. Update the checkbox for any item completed
2. Add a short "Notes" entry under the phase if there's a non-obvious context (a half-finished refactor, a TODO worth highlighting, a dependency upgrade pending)
3. Commit with a message that includes the phase number (e.g. `[router phase 6b] hook registry + load/check commands`)
4. Push so the next session sees the work

---

## Out of scope (deliberate, for v1)

- **Multi-VPS scale** — single-node only. Postgres replacement of SQLite is a future extension (per ARCHITECTURE.md §3.5).
- **Web UI** — `dev-team-logs` CLI is the operational surface. UI is a v2 idea.
- **Approval gates** (the per-trigger human-button-click pause) — designed but not built (ARCHITECTURE.md §3.5).
- **Containerized MCP** — MCPs run as stdio subprocesses of the router. Container isolation is a future extension.
- **OpenTelemetry traces** — Pino + Sentry + Prometheus cover the v1 needs; OTEL is a v2 add.
- **Custom Harness MCP for LLM-as-judge** — speculative; not built.

---

## Open questions (decide as encountered)

1. **eslint + prettier vs biome** — pick one in Phase 0. Lean biome (single tool, faster, simpler config).
2. **Test runner** — vitest (fast, good DX) vs node:test (built-in, fewer deps). Lean vitest.
3. **MCP package names** — the agent `mcp.json` files use plausible-but-unverified package names (`@modelcontextprotocol/server-linear` etc.). Verify in Phase 6c.
4. **Session-log MCP vs router-internal endpoint** — for Harness's `misbehavior-debugger` skill. Default to filesystem MCP (per mcp.json); revisit if filtering becomes needed.
5. **Hot-reload mechanism** — git pull loop (simple) vs inotify-based file watcher (faster). Lean git pull loop on a 60s interval; sufficient for our cadence.
6. **Sentry vs Better Stack** — both have free tiers; pick one in Phase 10. ARCHITECTURE.md leans Sentry; let's go with that.
7. **The `${PROJECT}` placeholder resolution** — when multiple target projects are running, the router needs to know which project context to use. For v1: single-project; resolve from env. Multi-project comes when Phase 8 of PLAN.md happens.
