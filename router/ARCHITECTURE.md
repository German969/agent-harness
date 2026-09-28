# Router — Architecture

The router is the runtime substrate for the six-agent dev team. It does the job Cyrus would have done — webhook ingestion, worktree management, Claude session spawning, output streaming — plus the things Cyrus doesn't (multi-persona native, cron scheduling, cost caps, per-agent identities, programmatic hooks).

This document is the **single source of truth** for the router's design. Read it before writing or changing any router code. Updates to the router that change behavior described here should update this doc in the same PR.

Companion docs:
- [PLAN.md](../PLAN.md) — the system-level plan; explains why Option C and where the router fits
- [AGENTS.md](../AGENTS.md) — agent roster + responsibilities
- [agents/PROTOCOLS.md](../agents/PROTOCOLS.md) — cross-agent protocols (Sensitive Paths, Product-Marketing Sync, etc.)
- Each agent's `agents/<name>/{CLAUDE.md, settings.json, mcp.json}` — the router loads these at session start

---

## Part 0 — Orientation

### Goals

1. **Multi-agent native** — six distinct bots, each with its own GitHub App / Linear agent / Slack app identity, its own system prompt, its own MCP set, its own cost budget.
2. **Event-driven + scheduled** — webhooks from GitHub / Linear / Slack are first-class; cron-triggered jobs use the same pipeline.
3. **Hot-reload of agent configs** — editing an agent's CLAUDE.md / settings.json / skills doesn't require a router restart; the next session picks up the change.
4. **Cost caps enforced pre-flight** — per-agent monthly + per-job ceilings refuse runaway sessions before they start.
5. **Resumable conversations** — a follow-up mention in the same Slack thread / Linear comment chain continues the prior session.
6. **Idempotent webhook handling** — replayed deliveries from GitHub / Linear / Slack do not produce duplicate work.
7. **Observable** — every session produces a structured trace; errors hit Sentry with the session_id as the join key; metrics drive dashboards + alerts.
8. **Recovery-safe** — a router restart resumes interrupted sessions cleanly per the [Token / Cost Resilience Protocol](../agents/PROTOCOLS.md#6-token--cost-resilience-protocol).
9. **No secrets on disk** — all credentials live in Infisical and are fetched into process memory only.

### Non-goals

- **A general-purpose agent platform.** This router is for our six agents. We won't add plugin systems or a third-party agent SDK.
- **Multi-VPS scaling.** Single-node SQLite + single-process router. If we need to scale out, we revisit — but not now.
- **Replacing the Claude Agent SDK.** We use the SDK directly. We don't reimplement what it does.
- **Replacing Cyrus's worktree algorithm.** Cyrus's worktree-per-task model is sound; we copy that pattern.

### Tech stack — locked decisions

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript / Node 20 | Claude Agent SDK is first-class TS; team familiarity; single artifact deploy |
| HTTP framework | Fastify | Fast, low-allocation, first-class schema validation, great plugin ecosystem |
| State DB | SQLite (better-sqlite3) + WAL mode | Embedded, ACID, debuggable via `sqlite3` CLI; backup is file copy |
| Secrets | Infisical (self-hosted on same VPS) | Per-secret audit log; rotation tooling; never on disk in our repos |
| Scheduler | `croner` | Production-grade cron; supports timezones; safer than node-cron |
| Logging | `pino` | Fast structured JSON; pairs with Axiom natively |
| Errors | `@sentry/node` | Industry standard; free tier covers us |
| Metrics | `prom-client` | Prometheus format; Grafana Cloud scrapes |
| Git ops | `simple-git` + shell-out for worktree | Worktree command is shell-only |
| Claude calls | `@anthropic-ai/claude-agent-sdk` | Direct SDK use; not via CLI |

---

# Part 1 — System in motion

A tour of the router's runtime through the lifecycle of a single trigger. Read this once front-to-back to understand what the router does. Detailed component reference follows in Part 2.

## §1.1 Arrival — webhook ingress

A webhook lands at `https://agents.<domain>/webhooks/<provider>`, routed through Cloudflare Tunnel to the Fastify server on the VPS at `127.0.0.1:8080`. Three providers, three routes:

```
POST /webhooks/github
POST /webhooks/linear
POST /webhooks/slack
```

For each request, the ingress pipeline does in order:

1. **Read raw body** with body parsing disabled (signatures verify against the raw bytes).
2. **Verify signature** per provider:
   - GitHub: `X-Hub-Signature-256` HMAC-SHA256 against the App's webhook secret
   - Linear: `Linear-Signature` HMAC-SHA256 against the agent's signing secret
   - Slack: `X-Slack-Signature` + `X-Slack-Request-Timestamp` per Slack's signing-secret scheme; reject requests with a timestamp older than 5 minutes (replay protection)
3. **Idempotency dedup** — extract the provider's delivery ID (`X-GitHub-Delivery`, Linear `webhookId`, Slack `event_id`) and check the `webhook_deliveries` table. If present, return `200 OK` immediately and do not process. If absent, insert it and proceed.
4. **Enqueue the event** for classification. The HTTP request returns `202 Accepted` immediately so the provider's webhook retry doesn't fire on a slow agent session.

Failed signature verification logs a `webhook.signature_failure` event with the source IP, increments a counter, and returns `401` — never logs the body. A spike in this counter triggers the `webhook-signature-failure-burst` alert.

Why the 202 + queue: agent sessions take seconds-to-minutes; webhooks must ack within 10s or providers retry. The queue is a single in-memory channel (no Redis); on router restart, in-flight events are recovered from the dedup table + the per-provider replay APIs (see [§3.2 Recovery](#32-recovery)).

## §1.2 Classify — trigger → agent + skill + continuation

The classifier is a small synchronous function that takes the verified event and returns:

```ts
type Classification = {
  agent: AgentId;             // 'strategist' | 'platform' | 'builder-server' | 'builder-client' | 'guardian' | 'marketer'
  skill?: SkillId;            // optional — null = let the agent pick (default skill activates)
  trigger: TriggerDescriptor; // what to tell the agent
  continuation: ContinuationDecision;
}
```

### Picking the agent

The agent is determined by **which bot identity was addressed**, in this order of specificity:

1. **Explicit mention** — `@strategist-bot`, `@guardian-bot` in a comment body → routes to that agent. The mention's bot identity is matched against `identities/<agent>.yml` (which holds GitHub App ID / Linear agent UUID / Slack bot user ID).
2. **Assignment / review-request** — issue assigned to the bot's Linear agent ID; PR review requested from the bot's GitHub App user → routes to that agent.
3. **Webhook installed for the agent** — a PR-opened event arrives on the agent's installation hook (e.g. Guardian's auto-fire on PR opens) → routes to that agent.
4. **Label-based** — a Linear ticket gets the `screenshot` label and no other agent is mentioned → routes to Builder-Client per the label registry (see [Linear Labels Protocol](../agents/PROTOCOLS.md#5-linear-labels-protocol)).
5. **Channel-default in Slack** — a message in `#growth` with no mention routes to Marketer; in `#security` to Guardian; etc. (configured per project).

If two agents are mentioned in the same message, the router emits **two independent sessions** (one per mention).

### Picking the skill (optional)

Skill is inferred from:
- Explicit selector in the message: `@guardian-bot llm-redteam <feature>` → activates the `llm-security` skill in focused-redteam mode
- Label on the originating ticket: `pr` → `pr-brand-steward` on Marketer
- Default for the trigger: PR-opened on Guardian → `qa` + `security` + others fire per the three-tier path scan

If unset, the agent's `CLAUDE.md` decides which skill activates from session start.

### Continuation decision

If the message is in an active thread (Slack reply, Linear comment, PR comment thread) and the most recent session for that thread completed less than `continuation_timeout` ago (default 30d, configurable per-agent in `settings.json`):

→ Continue the existing session. Use the same Claude session_id; restore conversation context.

Otherwise: start a fresh session.

The classifier writes a `sessions` row before returning. The session is now reserved.

## §1.3 Prepare — worktree, secrets, MCP, pre-flight

For each new session (continuation skips most of this; see [§2.4](#24-runtime--claude-agent-sdk)):

1. **Cost-cap pre-flight** — read the agent's `settings.json` → `costCap.monthlyCostUsd` + `perJobCostUsd`. Read the `cost_ledger` for the current month's spend. If adding this job would exceed either cap, refuse the session, post to `#agents-alerts`, and notify the trigger surface ("monthly cap reached; new sessions paused until reset").
2. **Secrets fetch** — pull the agent's runtime credentials from Infisical via the SDK. These become process env vars scoped to this session only. Credentials: `ANTHROPIC_API_KEY`, `GITHUB_APP_PRIVATE_KEY_<agent>`, `LINEAR_TOKEN_<agent>`, `SLACK_BOT_TOKEN_<agent>`, MCP-specific keys from the agent's `mcp.json`.
3. **Worktree setup** — for sessions that involve git operations (Builders, Guardian on PR reviews):
   - `git -C /var/lib/agents/dev-team pull --rebase` (config repo)
   - `git -C /var/lib/agents/dev-team-state pull --rebase` (state repo)
   - For target-project work: `git worktree add /var/lib/agents/worktrees/<agent>/<task-id> <branch>`
   - Worktree names use the task id (PR number, Linear ticket key, or generated UUID for ad-hoc work)
4. **Load agent config** — read fresh from disk (hot-reload):
   - `agents/<agent>/CLAUDE.md` → becomes the SDK's `system_prompt`
   - `agents/<agent>/settings.json` → derives model, max_turns, allowed_tools, hooks, costCap
   - `agents/<agent>/skills/*.md` → made available to the agent (the skill files describe how the agent should activate them)
   - `agents/<agent>/mcp.json` → MCP servers to boot for this session
5. **MCP boot** — start the agent's MCP stdio servers as child processes; pipe their stdio into the SDK call. Servers terminate at session end.
6. **SessionStart hooks** — execute every `SessionStart` entry in `settings.json`. These typically load context files (founding docs, ADR index, brand-voice, sensitive-paths.yml, design-system.md, etc.) and inject them into the SDK's initial context. The hook handler model is documented in [§2.11](#211-hooks).
7. **Founding-docs gate** — if any `check` hook (e.g. `STACK.md` missing → refuse) returns `refuse_substantive`, the router short-circuits: post a message to the trigger surface explaining the gate, mark the session `gated`, and end.

## §1.4 Execute — SDK call loop

The router invokes the Claude Agent SDK with:

```ts
claudeSDK.runSession({
  model: settings.model,
  systemPrompt: claudeMd,                  // loaded in Prepare
  initialContext: hookOutputs.sessionStart, // from SessionStart hooks
  initialMessage: trigger.message,         // the user's message that triggered the session
  maxTurns: settings.max_turns,
  allowedTools: settings.permissions.allow, // possibly modified by PreToolUse hooks
  thinkingBudget: settings.thinking?.budget_tokens,
  mcpServers: mcpHandles,                  // booted in Prepare
  onToolCall: preToolUseHandler,           // PreToolUse hooks intercept here
  onPartial: streamToReply,                // streams chunks back to trigger surface
  onComplete: completionHandler,
  onError: errorHandler,
  sessionId: classification.continuation.sessionId,  // null = new session
})
```

Inside the SDK call loop:

1. **Each turn** the model may emit text (streamed via `onPartial` to the trigger surface in real time) and/or tool calls.
2. **For each tool call**, `onToolCall` (the PreToolUse hook handler) runs. Hooks can:
   - Allow the call (default if no hook matches)
   - Deny the call with a message back to the model (e.g. publish-class action blocked)
   - Rewrite the call (rare; not used in current agent configs)
3. **Cost tracking** — the SDK emits per-call token usage; the router updates the `cost_ledger` after every turn. If the per-job cap is exceeded mid-session, the router cancels the session, posts a "session cancelled — per-job cap" comment, and proceeds to Complete.
4. **Streaming output** — `onPartial` emits chunks; the router's reply streamer batches them (per provider's rate limits) and updates the trigger-surface message.
5. **Tool use** — common tools: file Read/Edit/Write (Builders, Guardian), Bash (constrained per `settings.json`), MCP servers (Linear/GitHub/Slack/CMS/etc.).

The loop ends when:
- The model emits a final response and stops (normal)
- `max_turns` reached (escalation per session-incomplete pattern)
- Per-job cap hit (session cancelled)
- Unrecoverable error (Sentry-logged, fail-safe reply posted)

## §1.5 Complete — wrap, commit, reply, cleanup

After the SDK call returns:

1. **SessionEnd hooks** run in order. These typically:
   - Commit state changes to `dev-team-state` (per-agent state, shared surface)
   - Open PRs to `dev-team` when the agent modified its own configs (Guardian's sensitive-paths.yml, Builder-Client's design-system.md, etc.)
   - Open PRs to the content repo (Marketer)
   - Lint/format any files the agent wrote
2. **Finalize the reply** — the streamed message gets a final update (the full response + a session footer with cost + duration + session_id link for debugging).
3. **Cost ledger commit** — persist the session's final cost to SQLite. Reconcile against the streamed pre-commits.
4. **Update `sessions` row** — status `completed` (or `failed`, `cancelled`, `gated`); final_cost; final_turns; ended_at.
5. **MCP shutdown** — terminate the session's MCP server processes.
6. **Worktree cleanup** — for completed PR work, prune the worktree; for in-progress work, retain (the next session in the same thread reuses it).
7. **Observability flush** — emit `session.completed` event with all metrics to Pino → Axiom; update Prometheus counters; flush Sentry if any errors were captured.
8. **End**.

If the session was **interrupted** (max_turns, cap-hit, or process death), the SessionEnd path runs a smaller version: persist whatever partial state exists, mark the session `interrupted needs resume` per the [Token / Cost Resilience Protocol](../agents/PROTOCOLS.md#6-token--cost-resilience-protocol), post a brief "session interrupted; next session resumes" message. Resume happens on the next trigger in the same thread.

## §1.6 Scheduled — cron triggers

Scheduled jobs share the pipeline from §1.3 onward. The differences are in arrival + classification:

1. **Cron tick** — `croner` fires per `scheduler/schedules.yml` entries. Example entry:
   ```yaml
   - id: guardian-llm-security-weekly
     cron: "0 9 * * MON"
     timezone: America/New_York
     agent: guardian
     skill: llm-security
     trigger:
       kind: scheduled
       message: "Run the weekly llm-security eval suite against the production AI features. Compare to baseline; report regressions."
       reply_to:
         provider: slack
         channel: "#security"
   ```
2. **Synthetic trigger** — the cron handler synthesizes a `TriggerDescriptor` and feeds it to the classifier. The classifier sees a `kind: scheduled` trigger, skips signature verification (cron is in-process trusted), skips dedup (cron entries fire once per scheduled time), and produces a classification with the configured agent + skill.
3. **Pipeline resumes at §1.3** (Prepare) and runs through Complete.

Scheduled jobs that overlap with their previous still-running invocation skip (the scheduler checks `sessions` for an active session with the same `(agent, skill, cron_id)` tuple).

## §1.7 Inter-agent coordination

Agents trigger each other through normal trigger surfaces (Linear ticket assignment, PR comment mention, Slack ping). The router doesn't have a special inter-agent channel — A creates a Linear ticket assigned to B's agent → B's GitHub App receives a webhook → router classifies → B's session starts. Same pipeline.

Loop-prevention discipline:
- The `sessions` table includes `triggered_by_session_id` for agent-initiated sessions
- A chain of 5+ agent-to-agent triggers in a row without human intervention triggers a `coordination_loop_suspected` alert
- Agents shouldn't create work that triggers themselves (validated at trigger-classification time)

---

# Part 2 — Component reference

Per-component detail. State schema, hook semantics, API surfaces, error modes. Read selectively when you need to change or extend a specific module.

## §2.1 Webhook ingress

**Source location**: `router/src/server.ts`, `router/src/auth/*`

### Responsibilities
- HTTP server (Fastify, port 8080 local-only via Cloudflare Tunnel)
- Per-provider signature verification
- Webhook idempotency
- Per-provider event normalization → `WebhookEvent` discriminated union
- Health endpoints (`/health`, `/ready`)
- Metrics endpoint (`/metrics`, Prometheus format)

### Routes
```
POST /webhooks/github          — GitHub App webhook payloads (PRs, issues, comments, reviews, pushes)
POST /webhooks/linear          — Linear agent webhook payloads (assignments, comments, status)
POST /webhooks/slack/events    — Slack Events API (mentions, messages, app_mention, etc.)
POST /webhooks/slack/commands  — Slack slash-command surface (e.g. /agents schedule ...; see §2.8)
POST /webhooks/slack/interact  — Slack interactivity (button clicks, modals; future)
GET  /health                   — { ok: true, version, uptime }
GET  /ready                    — 200 if all subsystems healthy (DB, Infisical, MCP, queue not backlogged), else 503
GET  /metrics                  — Prometheus exposition
```

Slash commands aren't agent-triggering events — they're admin operations on the router itself (toggle schedules, query state). They go through their own handler chain (signature verify → admin authz check → command dispatch → respond inline within Slack's 3-second window), not the classification/runtime pipeline.

### Signature schemes

| Provider | Header | Algorithm | Secret source |
|---|---|---|---|
| GitHub | `X-Hub-Signature-256` | HMAC-SHA256 | Infisical: `GITHUB_APP_WEBHOOK_SECRET_<agent>` |
| Linear | `Linear-Signature` | HMAC-SHA256 | Infisical: `LINEAR_WEBHOOK_SECRET_<agent>` |
| Slack | `X-Slack-Signature` + timestamp | `v0=` HMAC-SHA256 | Infisical: `SLACK_SIGNING_SECRET_<agent>` |

The webhook hits the bot's installation endpoint; the App ID / agent ID in the payload tells us which agent's secret to verify against. Cross-app payloads (an event arriving on the wrong agent's webhook) are rejected with a `signature_mismatch_agent_routing` error.

### Idempotency

```sql
CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  agent TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  outcome TEXT  -- 'enqueued' | 'duplicate' | 'invalid' | 'gated'
);
CREATE INDEX idx_webhook_deliveries_received ON webhook_deliveries(received_at);
```

Retention: 30 days (older rows pruned by a daily job). Providers retry for hours, not days; 30d is conservative.

### Error responses

| Outcome | Status | Body |
|---|---|---|
| Signature invalid | `401` | `{"error":"invalid_signature"}` |
| Body too large (>1MB) | `413` | `{"error":"body_too_large"}` |
| Unknown agent in payload | `404` | `{"error":"agent_not_configured"}` |
| Duplicate delivery | `200` | `{"deduplicated":true}` |
| Accepted | `202` | `{"session_id":"<id>","queued_at":<ts>}` |

## §2.2 Event router

**Source location**: `router/src/routing/*`

### Responsibilities
- Take a verified `WebhookEvent` → produce a `Classification` per [§1.2](#12-classify--trigger--agent--skill--continuation)
- Match mentions / assignments / labels / channels to agent identities
- Decide skill activation
- Decide session continuation (continue prior session vs start new)

### Identity matching

Identities live in `dev-team/identities/<agent>.yml`:

```yaml
# identities/strategist.yml
agent: strategist
github:
  app_id: 123456
  bot_username: "strategist-bot"
  installation_url: "https://github.com/apps/strategist-bot"
linear:
  agent_id: "agent_abc123"
  user_id: "usr_def456"
slack:
  app_id: "A0123456"
  bot_user_id: "U0123456"
  channels:
    primary: "#planning"
    alerts: "#agents-alerts"
continuation_timeout_days: 30
```

The router loads all seven identities **once at startup** and builds the routing registry from them; there is no reload path, so an identity edit needs a router recreate even though the git-pull sidecar refreshes the file on disk. The identity files are committed to git (no secrets here — just IDs).

### Skill resolution

Order of resolution:
1. Explicit selector in message body: `@guardian-bot llm-redteam X` → skill=`llm-security` (matches the `@<agent> <action> ...` pattern)
2. Label-based: `LABEL_SKILLS` in `routing/skill.ts` maps Linear labels to skills **per agent**. Only the routed agent's own labels are read, so a ticket labeled `security` + `campaign` that routed to Guardian does not start Marketer's `campaign-lead` (HAR-23)
3. Trigger-type default: PR-opened on Guardian → multiple skills (qa, security, design-system if UI files touched, llm-security if AI paths touched) per the three-tier path scan
4. Fallback: the agent's primary skill (`backend` for Builder-Server, `frontend` for Builder-Client, `pm` for Strategist, etc.)

### Continuation logic

```ts
function findContinuation(event: WebhookEvent): ContinuationDecision {
  const threadKey = buildThreadKey(event);  // e.g. "slack:C123/T456" or "linear:ENG-1234"
  const lastSession = db.get(`
    SELECT * FROM sessions
    WHERE thread_key = ?
      AND status IN ('completed', 'interrupted_needs_resume')
      AND ended_at > ?
    ORDER BY ended_at DESC LIMIT 1
  `, threadKey, now() - continuationTimeoutMs);

  if (!lastSession) return { mode: 'new' };
  return { mode: 'continue', sessionId: lastSession.claude_session_id, parentRow: lastSession.id };
}
```

A `thread_key` uniquely identifies a conversation surface:
- `slack:<channel_id>/<thread_ts>` — a Slack thread
- `linear:<issue_key>` — a Linear issue (all comments on it count as one thread)
- `github:<repo>/pr/<number>` — a PR (review + comments + commits)
- `github:<repo>/issue/<number>` — an issue
- `scheduled:<cron_id>` — a scheduled job (each tick is a fresh session; no continuation)

## §2.3 Worktree manager

**Source location**: `router/src/workspace/*`

### Responsibilities
- Create per-task git worktrees at `/var/lib/agents/worktrees/<agent>/<task-id>/`
- Reuse worktrees across continuation sessions
- LRU cleanup of stale worktrees
- Branch naming + push at session end

### Path scheme

```
/var/lib/agents/worktrees/
├── strategist/
│   └── eng-1234/         (e.g. for Linear ENG-1234)
├── builder-server/
│   ├── eng-1235/
│   └── pr-789/           (PR-triggered session)
├── builder-client/
│   └── eng-1236/
└── guardian/
    └── pr-790/
```

### Lifecycle

| Phase | Action |
|---|---|
| Create | `git worktree add /var/lib/agents/worktrees/<agent>/<task-id> -b agent/<agent>/<task-id>` from the target project repo |
| Reuse | If a worktree already exists for the task, pull the latest branch and reuse |
| Commit | At session end, commit + push if any tracked changes exist |
| Idle prune | If a worktree hasn't been touched in 7 days and its branch has been merged/closed → remove |
| Force prune | On disk-pressure alert (`>90%` used), prune oldest worktrees regardless of staleness |

### Concurrency

Two parallel sessions never share a worktree. If two events for the same task arrive concurrently:
- The second is queued in the `pending_sessions` table
- After the first completes, the second runs (continuation logic kicks in — usually the second is a follow-up the first should have handled, so it continues the same Claude session_id)

### Branch naming

`agent/<agent>/<task-id>` (e.g. `agent/builder-server/eng-1234`). Builder-* agents push on completion; Guardian and Strategist mostly don't push to target-project branches (Guardian's writes go to its own state or as PRs to dev-team).

## §2.4 Runtime — Claude Agent SDK

**Source location**: `router/src/runtime/*`

### Responsibilities
- Invoke the Claude Agent SDK with prepared parameters
- Apply hooks (SessionStart-results-as-context, PreToolUse interception, SessionEnd handlers)
- Stream output to the reply layer
- Track per-turn cost and emit it to the cost ledger
- Cancel mid-session on cap-hit

### Inputs (prepared by previous phases)

```ts
type RuntimeInputs = {
  agentId: AgentId;
  sessionRowId: number;
  claudeSessionId?: string;       // null = new; set = continue
  systemPrompt: string;           // from CLAUDE.md
  initialContext: ContextBlock[]; // from SessionStart hooks
  initialMessage: string;         // trigger.message
  model: string;                  // from settings.json
  thinkingBudget?: number;
  maxTurns: number;
  allowedTools: string[];         // from settings.json permissions.allow
  deniedTools: string[];          // from settings.json permissions.deny + action-verb blocks
  mcpServers: McpServerHandle[];
  costCap: { perJobUsd: number; remainingMonthlyUsd: number };
  hooks: HookHandlers;
  trigger: TriggerDescriptor;     // who/what/where, for the reply layer
};
```

### SDK invocation shape

The router doesn't manage tokens or retries — that's the SDK's job. It manages the **boundary** between the SDK and the rest of the system:

```ts
const result = await claudeSDK.runSession({
  ...inputs,
  onPartial: chunk => reply.stream(inputs.trigger, chunk),
  onToolCall: async call => {
    const decision = await hooks.preToolUse(call, inputs);
    return decision; // 'allow' | { action: 'deny', message: string }
  },
  onTurnComplete: turn => {
    db.updateCost(inputs.sessionRowId, turn.cost);
    if (inputs.costCap.perJobUsd && getSessionCost(inputs.sessionRowId) > inputs.costCap.perJobUsd) {
      return { action: 'cancel', reason: 'per_job_cap_exceeded' };
    }
  },
});
```

### Error handling

| Error | Action |
|---|---|
| Anthropic API error (5xx, transient) | SDK retries; router logs and waits |
| Anthropic API error (4xx, config bug) | Fail session; Sentry; post short error to trigger surface |
| Anthropic API error (rate-limited) | Pause session 60s, then resume; if 3 rate-limits in row → mark interrupted |
| Per-job cap | Cancel session; reply with cap-hit footer; mark cancelled |
| Per-month cap | Refused pre-flight; never reached the SDK |
| MCP server crash | Mark session degraded; agent continues without that MCP; flag in reply footer |
| Process kill (OOM, restart) | Session marked `interrupted_needs_resume` via process-exit handler + signal trap |

## §2.5 Reply streamer

**Source location**: `router/src/reply/*`

### Responsibilities
- Stream Claude output back to the trigger surface in real time
- Batch chunks per provider's rate limit
- Update a single message (in-place) rather than creating many
- Append a session footer (cost / duration / session_id) on completion

### Per-provider adapters

| Provider | Update mechanism | Rate limit handling |
|---|---|---|
| Slack | Edit message via `chat.update`; first chunk creates the message via `chat.postMessage` | 1 update/sec/channel — batch 1-second windows |
| Linear | Comment-edit via Linear SDK; first chunk creates comment | ~5 req/sec — batch 200ms windows |
| GitHub | PR comment-edit (issue or review comment); first chunk creates | ~5000/hr per token — batch 500ms windows |

### Footer format

```markdown
---
*🤖 @<agent>-bot • <skill> • <duration> • $<cost> • session [`<id>`](<log-link>)*
```

The footer links to the session deep-log via `dev-team-logs session <id>` (the CLI prints the path; future-Grafana/Axiom dashboard view).

## §2.6 State — SQLite schema

**Source location**: `router/src/state/*`, `router/src/state/migrations/*`

WAL mode enabled at startup. Backups: daily `sqlite3 .backup /var/lib/agents/backups/state-<date>.sqlite` cron, plus a `litestream` replica to a Hetzner Storage Box if we want continuous replication.

### Tables

```sql
-- Active + historical sessions
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  skill TEXT,
  thread_key TEXT NOT NULL,
  claude_session_id TEXT,
  status TEXT NOT NULL,  -- 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'gated' | 'interrupted_needs_resume'
  triggered_by TEXT NOT NULL,  -- 'webhook:github' | 'webhook:linear' | 'webhook:slack' | 'scheduled:<cron_id>'
  triggered_by_session_id INTEGER,  -- for agent-to-agent chains
  trigger_payload JSON NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  turns INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  cost_input_tokens INTEGER DEFAULT 0,
  cost_output_tokens INTEGER DEFAULT 0,
  worktree_path TEXT,
  error_kind TEXT,
  notes TEXT
);
CREATE INDEX idx_sessions_thread ON sessions(thread_key, ended_at);
CREATE INDEX idx_sessions_agent_status ON sessions(agent, status);
CREATE INDEX idx_sessions_started ON sessions(started_at);

-- Cost ledger (per-agent + per-day rollup; sessions table has per-session truth)
CREATE TABLE cost_ledger (
  agent TEXT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  sessions_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent, year, month, day)
);
CREATE INDEX idx_cost_ledger_month ON cost_ledger(agent, year, month);

-- Webhook idempotency (see §2.1)
CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  agent TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  outcome TEXT
);
CREATE INDEX idx_webhook_deliveries_received ON webhook_deliveries(received_at);

-- Pending sessions (when a worktree is busy)
CREATE TABLE pending_sessions (
  id INTEGER PRIMARY KEY,
  thread_key TEXT NOT NULL,
  classification JSON NOT NULL,
  enqueued_at INTEGER NOT NULL
);

-- Schedule run history
CREATE TABLE schedule_runs (
  id INTEGER PRIMARY KEY,
  cron_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  fired_at INTEGER NOT NULL,
  session_id INTEGER REFERENCES sessions(id),
  outcome TEXT  -- 'started' | 'skipped_overlap' | 'skipped_disabled' | 'skipped_phase_gate' | 'failed_to_start'
);

-- Schedule runtime overrides (toggle on/off without editing YAML)
-- Effective enabled state = override.enabled if a row exists, else yaml.enabled
CREATE TABLE schedule_overrides (
  cron_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL,  -- 1 = on, 0 = off
  set_by TEXT NOT NULL,      -- 'slack:<user>' | 'cli:<user>' | 'system:<reason>'
  set_at INTEGER NOT NULL,
  reason TEXT                -- optional one-liner explaining the toggle
);

-- Schedule override history (audit trail; new row per change)
CREATE TABLE schedule_override_history (
  id INTEGER PRIMARY KEY,
  cron_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL,
  reason TEXT
);
CREATE INDEX idx_schedule_override_history_cron ON schedule_override_history(cron_id, set_at);

-- Inter-agent ticket cross-reference (loop prevention)
CREATE TABLE agent_chain (
  id INTEGER PRIMARY KEY,
  parent_session_id INTEGER REFERENCES sessions(id),
  child_session_id INTEGER REFERENCES sessions(id),
  via TEXT NOT NULL  -- 'linear_assign' | 'pr_review' | 'slack_mention' | etc.
);
CREATE INDEX idx_agent_chain_parent ON agent_chain(parent_session_id);

-- Which session created a work artifact (the cross-thread half of loop prevention).
-- A parent is normally found by thread_key continuation, which only ever sees a hop
-- INSIDE one thread; a ticket an agent files is a NEW thread, so depth restarted at
-- zero. Recorded at create_issue time, keyed by the thread_key events on that ticket
-- will carry, so the consumer's lookup is a direct hit with no extra parsing.
CREATE TABLE artifact_origin (
  thread_key TEXT PRIMARY KEY,  -- e.g. 'linear:IRS-47'
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_artifact_origin_session ON artifact_origin(session_id);

-- Worktree leases (for prune safety + concurrency)
CREATE TABLE worktrees (
  path TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  task_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  active_session_id INTEGER REFERENCES sessions(id)  -- NULL when idle
);

-- Schema version (for migrations)
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

### Migrations

Forward-only migrations in `router/src/state/migrations/*.sql`. The router checks `schema_version` at startup and applies any pending migrations before accepting webhooks.

## §2.7 Cost cap

**Source location**: `router/src/state/cost.ts`, `router/src/runtime/preflight.ts`

### Algorithm

Per session, before invoking the SDK:

```ts
const settings = loadAgentSettings(agent);
const { perJobCostUsd, monthlyCostUsd, warnAtPercent } = settings.costCap;

const monthSoFar = db.get(`
  SELECT COALESCE(SUM(cost_usd), 0) as spent
  FROM cost_ledger
  WHERE agent = ? AND year = ? AND month = ?
`, agent, currentYear, currentMonth).spent;

if (monthSoFar >= monthlyCostUsd) {
  return { action: 'refuse', reason: 'monthly_cap_reached', monthSoFar, cap: monthlyCostUsd };
}

if (monthSoFar / monthlyCostUsd >= warnAtPercent / 100) {
  postToAlertsChannel(agent, monthSoFar, monthlyCostUsd);
}

// Soft pre-flight estimate (we don't know the cost yet; per-job cap enforced mid-session)
return { action: 'allow', remainingMonthlyUsd: monthlyCostUsd - monthSoFar, perJobCapUsd: perJobCostUsd };
```

Mid-session, after each turn:

```ts
const sessionCost = db.get('SELECT cost_usd FROM sessions WHERE id = ?', sessionId).cost_usd;
if (sessionCost >= perJobCostUsd) {
  return { action: 'cancel', reason: 'per_job_cap_exceeded' };
}
```

Monthly counters reset on the 1st at 00:00 UTC.

### `onCapReached` behaviors

From `settings.json`:
- `"refuse_session"` — refuse new sessions; existing in-flight finish normally
- `"throttle"` (future) — slow rather than stop
- `"alert_only"` (future) — proceed but post a louder alert

Only `refuse_session` is implemented in v1.

## §2.8 Scheduler

**Source location**: `router/src/scheduler/*`

### Responsibilities
- Load `dev-team/scheduler/schedules.yml`
- Register each entry with `croner`
- Resolve effective enabled state from YAML + runtime overrides + project phase gate
- On tick: synthesize a trigger + invoke the classifier (skipping if not effectively enabled)
- Persist run history to `schedule_runs`
- Detect + skip overlapping runs
- Maintain runtime overrides via Slack command + CLI surfaces

### Default state — everything off until activated

**By design, schedules default to disabled.** Every new entry in `schedules.yml` starts at `enabled: false`. This matches the bootstrap discipline: at project birth, no crons fire; activations are deliberate, one-by-one or in agent-wide batches, as the project reaches the right phase.

Activation surfaces (any of the three):
- **Slack slash command** — `/agents schedule enable <id>` (the default day-to-day surface)
- **CLI** — `dev-team-logs schedule enable <id>` (for scripted ops or when Slack is down)
- **YAML edit + git push** — flip `enabled: true` for the entry (the long-term persistent choice; useful when the activation should travel with the codebase)

### Schedule entry format

```yaml
# scheduler/schedules.yml
- id: guardian-llm-security-weekly
  cron: "0 9 * * MON"
  timezone: America/New_York
  agent: guardian
  skill: llm-security
  trigger:
    kind: scheduled
    message: |
      Run the weekly llm-security eval suite. Compare to baseline; report regressions.
    reply_to:
      provider: slack
      channel: "#security"
  enabled: false                       # default-off; flip via Slack/CLI/YAML once Guardian is online
  requires_project_phase: phase-5      # phase gate; only fires when project.phase ≥ phase-5
                                       # (Guardian comes online in Phase 5 per PLAN.md)

- id: curator-quarterly-practices
  cron: "0 14 1 1,4,7,10 FRI"          # First Friday of each quarter, 2pm
  timezone: America/New_York
  agent: strategist
  skill: curator
  trigger:
    kind: scheduled
    message: |
      Run the quarterly coding-practices + design-system drift checks per the curator skill.
    reply_to:
      provider: slack
      channel: "#engineering"
  enabled: false
  requires_project_phase: phase-5      # need code shipping + Builder docs in place first

- id: marketer-weekly-benchmarking
  cron: "0 16 * * FRI"
  timezone: America/New_York
  agent: marketer
  skill: benchmarking
  trigger:
    kind: scheduled
    message: |
      Run the weekly competitor quick-scan. Post a summary to #growth if anything material changed.
    reply_to:
      provider: slack
      channel: "#growth"
  enabled: false
  requires_project_phase: phase-6      # Marketer comes online in Phase 6

# ... more entries: monthly compliance audit, weekly perf review, etc.
```

### Effective-enabled resolution

For each cron tick:

```
let yamlEnabled    = entry.enabled              // boolean from YAML
let override       = db.get(schedule_overrides, entry.id)
let projectPhase   = readProjectPhase()         // from <target-project>/.dev-team.yml
let phaseRequired  = entry.requires_project_phase
let phaseSatisfied = !phaseRequired || phaseGte(projectPhase, phaseRequired)

let effective =
  override                                       // runtime override is the strongest signal
    ? (override.enabled === 1 && phaseSatisfied)
    : (yamlEnabled && phaseSatisfied)
```

If `effective === false` the scheduler logs `schedule.skipped_disabled` (or `schedule.skipped_phase_gate` if the only blocker is the phase) and inserts a `schedule_runs` row with that outcome — useful for "why isn't my cron firing" debugging.

### Project phase

The phase declaration lives in `<target-project>/.dev-team.yml`:

```yaml
# <target-project>/.dev-team.yml
project:
  phase: phase-3        # current bootstrap phase (phase-0 through phase-8 per PLAN.md)
```

Phases are ordered (`phase-0 < phase-1 < ... < phase-8`); `phaseGte(current, required)` is a simple ordinal comparison. Updating the phase is itself a deliberate human action — pushed to the target repo when a phase verification passes.

Entries without `requires_project_phase` ignore the gate (treated as always phase-satisfied).

### Slack slash-command surface

Registered at `POST /webhooks/slack` (slash-command sub-route). Commands:

```
/agents schedule list                            # list all entries: id, agent, cron, enabled, last_run, next_fire
/agents schedule list --agent guardian           # filter to one agent
/agents schedule list --disabled                 # show only currently-disabled entries
/agents schedule enable <id> [reason="..."]      # turn on (writes override; reason logged)
/agents schedule disable <id> [reason="..."]     # turn off
/agents schedule enable --agent <name>           # bulk: turn on all of an agent's crons
/agents schedule disable --agent <name>          # bulk: turn off
/agents schedule run <id>                        # fire ONCE right now without changing enabled state
/agents schedule reset <id>                      # remove override; revert to YAML default + phase gate
/agents schedule history <id>                    # show toggle history for one entry (from schedule_override_history)
```

Slash-command auth: only users in the configured `slack_admins` list (per `identities/router.yml`) can mutate; everyone can `list` / `history`. Mutations emit a `#agents-alerts` post for visibility.

### CLI surface

Same commands available via `dev-team-logs schedule ...` for scripted ops, off-Slack toggling, and ops scripts:

```bash
dev-team-logs schedule list
dev-team-logs schedule list --agent guardian
dev-team-logs schedule enable guardian-llm-security-weekly --reason "Phase 5 verified"
dev-team-logs schedule disable --agent marketer --reason "brand voice still drafting"
dev-team-logs schedule run guardian-llm-security-weekly --once
dev-team-logs schedule reset guardian-llm-security-weekly
dev-team-logs schedule history guardian-llm-security-weekly
```

CLI auth: runs on the VPS; access is gated by file-system permissions (only `agents` user) and audit-logged the same way as Slack toggles.

### Override lifecycle

- **Write**: when a user enables/disables via Slack or CLI, the router:
  1. Upserts a row in `schedule_overrides` (one row per `cron_id`)
  2. Appends a row to `schedule_override_history` (audit trail; never deleted)
  3. Re-registers / deregisters the entry with `croner` immediately
  4. Posts to `#agents-alerts` (mutations only): `"⏰ schedule \`<id>\` ENABLED by @<user>; reason: <text>"`
- **Read**: each scheduler tick queries the override row inline (single-row index lookup; negligible cost)
- **Reset**: removes the override row entirely; the schedule reverts to its YAML + phase-gate computed state. The history rows stay.

### Hot-reload

`schedules.yml` is re-read on every git pull. New entries register with croner; removed entries are deregistered; modified cron expressions are updated. Overrides survive YAML changes (an entry's `enabled` flip in YAML doesn't clear its runtime override — explicit `reset` is required to drop the override).

If an entry is removed from YAML but still has an override row, that override is **orphaned** — the router logs `schedule.orphaned_override` and the next `/agents schedule list` shows the orphan with a flag. Clean up via `dev-team-logs schedule reset <id>`.

### Overlap protection

Before firing an enabled entry, the scheduler checks if a session for the same `(agent, skill, cron_id)` is currently `running`. If so:
- Log `schedule.skipped_overlap` with the prior session_id
- Insert `schedule_runs` row with outcome `skipped_overlap`
- Do not fire

This prevents a stuck weekly job from accumulating queued runs.

### Visibility — `/agents schedule list` example output

```
$ /agents schedule list
ID                                AGENT           CRON                ENABLED   PHASE-GATE   LAST RUN              NEXT FIRE             SOURCE
guardian-llm-security-weekly      guardian        0 9 * * MON         YES       phase-5 ✓    2026-06-08 09:00 EDT  2026-06-15 09:00 EDT  override (slack:@german, 2026-06-01)
curator-quarterly-practices       strategist      0 14 1 1,4,7,10 FRI no        phase-5 ✓    never                 (disabled)             yaml default
marketer-weekly-benchmarking      marketer        0 16 * * FRI        no        phase-6 ✗    never                 (gated by phase)       yaml default
guardian-monthly-compliance       guardian        0 10 1 * *          YES       phase-5 ✓    2026-06-01 10:00 EDT  2026-07-01 10:00 EDT  yaml default
```

Reading the columns:
- **ENABLED** — current effective state
- **PHASE-GATE** — ✓ if the phase gate is satisfied, ✗ if blocking
- **LAST RUN / NEXT FIRE** — actual cron behavior
- **SOURCE** — where the current state comes from (`yaml default` or `override (slack:@<user>, <date>)`); makes it obvious whether YAML or a runtime override is in effect

## §2.9 MCP lifecycle

**Source location**: `router/src/mcp/*`

### Responsibilities
- Load the agent's `mcp.json` at session start
- Resolve each active server's config — `${VAR}` placeholders against the session env, plus a minimal base env (`PATH`, `HOME`, …) so command lookups resolve
- Hand those configs to the SDK call as `SdkRunInputs.mcpServersConfig`

The router does **not** spawn or terminate MCP children. The Claude Agent SDK owns
that whole lifecycle: it spawns from the configs above, speaks JSON-RPC to them, and
terminates them itself.

> Until [#12](https://github.com/German969/dev-team/pull/12) the router *also* spawned a
> child per stdio server and passed the handles to the adapter as `SdkRunInputs.mcpServers`.
> Nothing ever read that field — the Anthropic adapter builds `options.mcpServers` from
> `mcpServersConfig` — so every session ran two copies of each server, one idle from birth
> until teardown SIGTERM'd it. The spawn + teardown path was removed rather than hardened.

### Per-agent `mcp.json` format

```json
{
  "mcpServers": {
    "linear": {
      "type": "stdio",
      "command": "node",
      "args": ["/opt/mcp-servers/linear/index.js"],
      "env": {
        "LINEAR_TOKEN": "${LINEAR_TOKEN}"
      }
    },
    "github": {
      "type": "stdio",
      "command": "node",
      "args": ["/opt/mcp-servers/github/index.js"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_APP_INSTALLATION_TOKEN}"
      }
    },
    "slack": {
      "type": "stdio",
      "command": "node",
      "args": ["/opt/mcp-servers/slack/index.js"],
      "env": {
        "SLACK_TOKEN": "${SLACK_BOT_TOKEN}"
      }
    }
  }
}
```

`${VAR}` references are resolved from the session's env vars (fetched from Infisical in Prepare).

### Future — remote MCP

For HTTP-based MCP servers (CMS APIs, analytics APIs), the lifecycle is connection-only (no spawn). The MCP HTTP client is reused across sessions (with appropriate authentication injected).

### In-process (SDK-hosted) MCP servers

Some tools are implemented inside the router rather than spawned as a child or reached over HTTP. An agent opts in with a marker entry in its `mcp.json`:

```json
"github_gitdata": { "type": "sdk" }
```

`activeServers()` drops `type: "sdk"` entries from the spawn path (they aren't processes); `sdkCall.collectInProcessMcp()` gathers their names into `SdkRunInputs.inProcessMcp`; the Anthropic adapter instantiates the known ones via the SDK's `createSdkMcpServer` and merges them into `options.mcpServers`. They surface to the model as `mcp__<name>__*` like any MCP, and — being mutating — are kept out of each agent's `allow` list so they route through `canUseTool` → PreToolUse.

**`github_gitdata`** (`router/src/github/gitDataMcp.ts` over `gitData.ts`) exposes content-free file operations via the GitHub Git Data API:

- `move_file` / `delete_file` — rename or remove a file by referencing its existing blob SHA (`ref → commit → tree → createTree(base_tree, blob-SHA) → commit → updateRef`). No file content is transferred, so this works for files past the Contents-API token cap (~40KB) that `create_or_update_file` / `get_file_contents` can't handle. This closes the delete/rename gap and the large-file content-transfer wall that previously forced a copy-then-ask-a-human-to-delete workaround.
- `apply_file_ops` — batch move/delete/upsert in a single commit.

Authed with the session's `GITHUB_APP_INSTALLATION_TOKEN` (the adapter skips the server if the token is absent). The tools **hard-refuse protected branches** (`main`/`master`/`staging`/`production`/`prod`/`release`) so they can't bypass the PR-only discipline the Bash push-gates enforce — agents commit to a feature branch and open a PR. Enabled for Strategist, Harness, and both Builders.

**Not covered**: *editing* a large file still requires reading it; a chunked read past the token cap is a separate follow-up. This server removes the content-transfer wall for *moves and deletes* only.

**`linear`** (`router/src/linear/linearMcp.ts` over `linearClient.ts`) wraps Linear's GraphQL API so Strategist can act on Linear without an external MCP package (the deprecated `@modelcontextprotocol/server-linear` stdio server is retired; Linear's own MCP is OAuth-interactive, which doesn't fit the headless per-agent-key model). Tools: `list_teams`, `list_labels`, `search_issues` (reads, for resolving ids + dedup), and `create_issue`, `create_comment`, `create_label`, `create_project`, `create_project_milestone` (writes). This is what makes founding Phase 0.6 (MVP epic → milestones → feature tickets) work. Authed with the session's `LINEAR_TOKEN` (adapter skips the server if absent). Only Strategist's **always-allowed** Linear tier is exposed — the gated tier (status change, reassign, close, archive, delete) is not implemented as tools, so the tiered-scope decision is enforced at the tool surface. Because this tier is always-allowed, `mcp__linear__*` stays in Strategist's `allow` list (unlike `github_gitdata`, which is kept out of `allow` so it routes through `canUseTool`).

**Deploy prerequisites for `linear`** (operational, outside the router code): a real Linear personal API key stored as `LINEAR_TOKEN_strategist` in Infisical, and a Linear team for the epic/tickets to live under (the agent resolves it via `list_teams`). Inbound Linear triggers (e.g. the `phase-0` label routing) additionally need the bot's `agent_id`/`user_id` + `linear_webhook_secret` filled in `identities/strategist.yml` — not required for founding's outbound Phase 0.6.

## §2.10 Secrets — Infisical client

**Source location**: `router/src/secrets/*`

### Responsibilities
- Connect to Infisical at startup
- Fetch per-agent credentials on demand (not eagerly — minimize secret exposure)
- Cache credentials in-memory for the duration of a session (then discarded)
- Refresh on rotation events (via Infisical's webhook or polling)

### Credential lifecycle

| Phase | Action |
|---|---|
| Router startup | Fetch the router's own service-account credential to access Infisical |
| Session prepare | Fetch the agent's credentials for this session; inject into env vars passed to the SDK + MCP children |
| Session end | Discard the credentials from memory (garbage collected after session-scoped env vars go out of scope) |
| Rotation | If Infisical signals rotation, evict the cached value; next session fetches fresh |

### Naming convention in Infisical

Project per agent: `dev-team/strategist`, `dev-team/platform`, etc. Plus a shared project `dev-team/shared` for `ANTHROPIC_API_KEY` and observability tokens (Axiom, Sentry, Grafana Cloud).

## §2.11 Hooks

**Source location**: `router/src/hooks/*`

The hooks listed in agent `settings.json` aren't Claude CLI hooks — they're handlers our router invokes. There are three hook types.

### `SessionStart` hooks

Run before the SDK call; produce context that's injected into the initial message.

Schema example (from Guardian's settings.json):
```json
{
  "SessionStart": [
    {
      "command": "load",
      "paths": [
        "<target-project>/founding/PRODUCT.md",
        "<target-project>/docs/architecture/SYSTEM.md",
        "dev-team-state/projects/${PROJECT}/platform/adr-index.md",
        "dev-team/agents/guardian/sensitive-paths.yml"
      ],
      "missing": "warn",
      "missingException": {
        "<target-project>/founding/COMPLIANCE.md": "ignore"
      }
    },
    {
      "command": "check",
      "if_missing": ["<target-project>/founding/STACK.md"],
      "then": "set_context",
      "context": "stack_missing=true",
      "message": "STACK.md missing; refuse substantive review."
    }
  ]
}
```

The router supports a small vocabulary of `command` values:
- `load` — read the listed files; if a file is missing, behavior per `missing` (`warn` / `error` / `ignore`); concatenate into a context block
- `check` — if certain files are missing, set a context flag the agent's CLAUDE.md can act on
- `conditional_load` — load files based on which skill is activating (used by Marketer)
- `classify_path_tier` — Guardian-specific; classify PR diff against `sensitive-paths.yml`

If we need new hook commands, we add them to the router's handler registry (`router/src/hooks/commands/*.ts`) — adding one is small.

### `PreToolUse` hooks

Run before each tool call the SDK wants to make. Can allow, deny, or rewrite.

Schema example (from Marketer's publish-gate):
```json
{
  "PreToolUse": [
    {
      "tool": "*",
      "block_if_action_matches": [
        "publish", "schedule_publish", "schedule_send", "send_now",
        "post_now", "launch", "spend", "go_live"
      ],
      "deny_always": true,
      "message": "🛑 Marketer NEVER publishes/sends/posts externally. Drafts only."
    }
  ]
}
```

Hook commands: `block_if_path_matches`, `block_if_action_matches`, `block_if_content_matches_pattern`, `validate` (custom validator like Marketer's testimonial-permission check).

### `SessionEnd` hooks

Run after the SDK call returns; persist state, commit, post final messages.

Schema example:
```json
{
  "SessionEnd": [
    {
      "command": "git_commit",
      "repo": "dev-team-state",
      "paths": ["projects/${PROJECT}/guardian/**"],
      "message_template": "[guardian] session ${SESSION_ID} — ${SKILL}"
    },
    {
      "command": "git_commit_if_changed",
      "repo": "dev-team",
      "paths": ["agents/guardian/sensitive-paths.yml"],
      "create_pr": true,
      "pr_label": "agent:guardian-bot"
    }
  ]
}
```

Hook commands: `git_commit`, `git_commit_if_changed`, `lint_and_format`, `format_and_lint`, `post_summary` (post a summary to Slack channel).

### Hook handler API

Each hook command is a TypeScript function with this signature:

```ts
type HookHandler<T = any> = (
  config: HookConfig,
  context: SessionContext
) => Promise<HookResult<T>>;

type SessionContext = {
  agent: AgentId;
  skill?: SkillId;
  sessionId: number;
  claudeSessionId?: string;
  workspaceDir: string;
  trigger: TriggerDescriptor;
  env: Record<string, string>;  // resolved env vars including secrets
  db: Database;                 // session-scoped state access
  log: Logger;
};

type HookResult<T> =
  | { kind: 'context'; content: string; tag?: string }   // SessionStart load
  | { kind: 'gate'; reason: string; message: string }    // founding-docs missing
  | { kind: 'allow' }                                    // PreToolUse pass
  | { kind: 'deny'; message: string }                    // PreToolUse block
  | { kind: 'side-effect'; summary: string }             // SessionEnd commit/post
  | { kind: 'error'; error: Error };
```

This boundary keeps each hook small and testable.

## §2.12 Observability

**Source location**: `router/src/observability/*`

### Layered architecture

| Layer | Tool | Sinks |
|---|---|---|
| Structured logs | `pino` | stdout (collected by Docker logs) + `/var/log/agents/sessions/<session-id>.jsonl` (deep trace) + Axiom (aggregation) |
| Errors | `@sentry/node` | Sentry SaaS |
| Metrics | `prom-client` | `/metrics` endpoint scraped by Grafana Cloud's Prometheus agent |
| Alerts | Slack webhooks | `#agents-alerts` |
| Debug CLI | `dev-team-logs` (separate binary) | Reads from local jsonl + Axiom API |

### Log schema

Every log line has:
```json
{
  "level": "info",
  "ts": "2026-06-15T13:42:18.123Z",
  "session_id": "12345",
  "claude_session_id": "msg_01abc...",
  "agent": "guardian",
  "skill": "qa",
  "trigger": "webhook:github",
  "thread_key": "github:org/repo/pr/789",
  "event": "session.started",
  "data": { /* event-specific */ },
  "duration_ms": 234   // for completion events
}
```

The `session_id` is the **join key** across all observability surfaces (Axiom logs, Sentry errors, Grafana metrics, the deep trace file). Any error or metric anomaly should be cross-referenceable to a specific session.

### Per-session deep trace

Each session writes a per-line jsonl to `/var/log/agents/sessions/<session-id>.jsonl`. Contents:
- Every log line emitted in that session's context (filtered by `session_id`)
- The full Claude SDK request + response trace (model input/output, tool calls, hook results)
- Cost ledger entries
- Reply streamer batches

Useful when something goes weird. The `dev-team-logs` CLI reads these directly.

### Metrics — what we emit

```
agent_session_total{agent,skill,outcome}        counter — sessions by outcome
agent_session_duration_seconds{agent,skill}     histogram — duration by agent/skill
agent_session_cost_usd{agent}                   counter — cost by agent
agent_cost_cap_proximity{agent,scope="monthly"} gauge — 0.0..1.0 fraction of cap used
agent_webhook_total{provider,outcome}           counter — webhook ingestion
webhook_signature_failure_total{provider}       counter — security signal
mcp_server_status{agent,server}                 gauge — 1 healthy / 0 down
router_in_flight_sessions                       gauge — concurrent sessions
router_pending_sessions                         gauge — waiting on worktree
sqlite_db_size_bytes                            gauge — disk usage
```

### Alert rules

| Rule | Condition | Channel |
|---|---|---|
| Spend warning | `agent_cost_cap_proximity > 0.8` | `#agents-alerts` |
| Spend cap hit | Agent refused a session due to cap | `#agents-alerts` |
| Process crash | Router restarted unexpectedly (uptime reset) | `#agents-alerts` |
| Webhook signature burst | `rate(webhook_signature_failure_total[5m]) > 0.1` | `#agents-alerts` |
| Agent error burst | `rate(agent_session_total{outcome="failed"}[5m]) > 0.1` by agent | `#agents-alerts` |
| SQLite size growing | `sqlite_db_size_bytes > 1GB` | `#agents-alerts` (operational) |
| MCP server down | `mcp_server_status == 0` for 5+ minutes | `#agents-alerts` |
| Disk pressure | VPS disk > 85% | `#agents-alerts` |

### Debug + ops CLI

```
# Sessions / debugging
dev-team-logs session <id>                       # full trace for a session
dev-team-logs session <id> --tail                # follow if running
dev-team-logs agent <name> --since 1h            # all sessions for an agent in time window
dev-team-logs trigger <thread-key>               # all sessions in a thread
dev-team-logs cost --month 2026-06               # cost breakdown for the month

# Schedule control (mirrors the /agents schedule Slack surface; see §2.8)
dev-team-logs schedule list                      # all entries: id, agent, cron, enabled, last_run, next_fire, source
dev-team-logs schedule list --agent guardian     # filter to one agent
dev-team-logs schedule list --disabled           # show only currently-disabled entries
dev-team-logs schedule list --next 7d            # upcoming scheduled jobs in the next N days
dev-team-logs schedule enable <id> [--reason "..."]
dev-team-logs schedule disable <id> [--reason "..."]
dev-team-logs schedule enable --agent <name>     # bulk per agent
dev-team-logs schedule disable --agent <name>
dev-team-logs schedule run <id> [--once]         # fire now without changing enabled state
dev-team-logs schedule reset <id>                # remove override; revert to YAML + phase gate
dev-team-logs schedule history <id>              # toggle audit trail
```

Reads jsonl files + queries SQLite + (optionally) Axiom API. Schedule mutations write to `schedule_overrides` + `schedule_override_history` (per §2.6 schema) and re-register with croner immediately.

## §2.13 Hot-reload

**Source location**: `router/src/config/*`

### Triggered by
- `git pull` on the VPS (automatic every 60s via a side-process, or manual via the deploy script)
- File-watch on `/var/lib/agents/dev-team` for development on the VPS

### Re-read on next session start (no router restart)

| File | Effect |
|---|---|
| `agents/<name>/CLAUDE.md` | New system prompt for the next session |
| `agents/<name>/settings.json` | New model, hooks, costCap, etc. for the next session |
| `agents/<name>/skills/*.md` | New skill available; deleted skill no longer surfaced |
| `agents/<name>/mcp.json` | New MCP servers spawned next session |
| `identities/<name>.yml` | New routing rules for next webhook |
| `scheduler/schedules.yml` | Re-registered with croner |

### Re-read requires router restart

| File | Why |
|---|---|
| `router/src/**` | TypeScript source — needs rebuild |
| `deploy/docker-compose.yml` | Container config |
| Database schema migrations | Run on startup; new migrations need restart |

---

# Part 3 — Cross-cutting

Things that don't fit cleanly into a single phase or component.

## §3.1 Multi-agent coordination

Agents trigger each other through normal surfaces (Linear assignment, GitHub mention, Slack ping). The router treats those as ordinary triggers — there's no agent-to-agent special channel. This means:

- Inter-agent communication is observable through normal surfaces (humans can see it)
- A bug where Agent A keeps pinging Agent B is visible in Linear/Slack
- Loop prevention happens via `agent_chain` table (§2.6)

### Loop prevention

When a session creates a trigger that will route to another agent (e.g. Strategist creates a Linear ticket assigned to Builder-Server):
1. Insert `agent_chain` row linking parent → child session
2. Before invoking the child session, walk the chain backwards
3. If chain depth > 5 without human intervention → refuse the child, post `coordination_loop_suspected` alert

The parent is found two ways, and both are needed:

- **Same thread** — the prior session on this `thread_key` (a reply in a Slack
  thread, a second comment on a ticket). Extends the chain only when the trigger is
  agent-authored: "human intervention" = a session triggered by a human-authored
  event, detected via the `trigger_payload` having a non-bot author.
- **Across threads** — a ticket an agent created is a *new* `thread_key`, so
  continuation finds nothing and the count used to restart at zero, leaving a
  fan-out of agent-created tickets uncapped. `artifact_origin` (§2.6) records the
  creating session at `create_issue` time, and the first session on that ticket
  links back to it (`via: 'ticket_created'`).

  This hop deliberately does **not** consult the agent-authored heuristic. A Linear
  `Issue` event carries neither a `botActor` nor our reply footer, so the heuristic
  returns false for exactly the hop being guarded. The origin row is stronger
  evidence anyway: we don't infer that an agent made the ticket, we recorded it. A
  ticket a human filed has no origin row and is never affected.

### Concurrent multi-agent triggers

A PR opened in the target project triggers Guardian (auto-review). The same PR has a `@server-bot` mention in the description → also triggers Builder-Server. Both run concurrently in separate worktrees.

If they both want to comment on the PR, they each get their own comment (no merge logic). Coordination, if needed, happens through the [API Contract Protocol](../agents/PROTOCOLS.md#1-api-contract-protocol) and explicit Linear tickets, not through router orchestration.

## §3.2 Recovery

### Router restart

On startup, the router:
1. Applies pending DB migrations
2. Connects to Infisical
3. Loads identities + schedules + agent configs
4. Boots cloudflared connection
5. Marks any `sessions` rows in `running` status as `interrupted_needs_resume` (process death assumption)
6. Replays webhook deliveries from the last 5 minutes via each provider's replay API (GitHub: redelivery API; Linear: webhook event log; Slack: events API isn't replayable but Slack queues for 30 min; our 5min window is for safety)
7. Posts a `router.started` event to `#agents-alerts`
8. Resumes scheduler

### Session resume

When a session has `interrupted_needs_resume` status and a new trigger arrives in the same thread:
1. The classifier detects the prior session
2. The runtime starts a new Claude session_id but injects the prior session's accumulated state (via SessionStart hook) including the work-so-far state file
3. The agent's CLAUDE.md (per the [Token / Cost Resilience Protocol](../agents/PROTOCOLS.md#6-token--cost-resilience-protocol)) reads the resume marker and continues from where it left off

### VPS reboot

Docker restart policy: `unless-stopped`. Router + cloudflared + Infisical all restart automatically. State persists in SQLite + Infisical's volume.

## §3.3 Threat model

### Trust boundaries

```
External:    GitHub | Linear | Slack | Anthropic API
             ↓ (signed webhooks; HTTPS)
Internal:    Router process (untrusted-input handling)
             ↓ (per-session env scoping)
SDK calls:   Claude Agent SDK (sandboxed by Anthropic)
             ↓
Workspace:   git worktrees (file-system isolated per task)
             ↓
Secrets:     Infisical (encrypted at rest; audited access)
```

### Mitigations

| Threat | Mitigation |
|---|---|
| Replayed webhook | Idempotency dedup table (§2.1) + Slack timestamp window |
| Forged webhook | Per-provider signature verification |
| Webhook flood (DoS) | Cloudflare Tunnel rate-limiting + signature-failure burst alert |
| Compromised bot credentials | Per-agent identities — one compromise doesn't escalate; rotation via Infisical |
| Prompt injection from webhook body | Agent CLAUDE.md treats trigger content as untrusted input; Guardian's llm-security skill specifically tests for this |
| Agent runaway loop | Per-job cap + max_turns + agent-chain depth limit |
| Secret in code/log | Pre-commit hooks + Sentry filter for secret-like strings + `/var/log` access-controlled |
| MCP server compromise | Each MCP runs in a subprocess; killed at session end; future: containerize MCP servers |
| Cross-agent privilege escalation | Each agent's settings.json deniedPaths blocks cross-agent state writes |
| State DB tampering | File permissions (`agents` user only); backups; integrity check possible via WAL |

### What's out of scope for the router

- **Anthropic-side jailbreaks** — the model itself refusing/leaking. Guardian's llm-security skill exists for this.
- **Compromised dev-team config repo** — if dev-team is compromised at the git level, an attacker can rewrite agent prompts. Mitigation: branch protection on `main`, signed commits, deploy from `main` only.
- **Compromised VPS** — full host compromise. Mitigation: SSH key-only, UFW, regular patching, Infisical encryption, off-host SQLite backup.

## §3.4 Failure modes catalog

| Failure | Symptom | Detection | Recovery |
|---|---|---|---|
| Anthropic API outage | Sessions stall / fail | SDK errors → Sentry; failed-session-burst alert | SDK retries; backoff; agent posts "API issues" reply if extended |
| Linear / GitHub / Slack outage | Reply streamer fails | Per-provider error rate metric | Buffer reply locally; flush when API returns |
| Infisical down | Secrets fetch fails | Pre-flight check fails; session refused | Router retries fetch; if persistent, refuse all sessions with `infisical_unavailable` |
| SQLite corruption | Write errors | Startup integrity check (`PRAGMA integrity_check`) | Restore from latest backup; replay from webhook redelivery + Slack queue |
| Disk full | Worktree writes fail | Disk-pressure alert | Force-prune worktrees; alert; potential VPS upgrade |
| Schedule entry malformed | Cron registration fails | Startup error → Sentry | Skip the entry; alert; continue with valid entries |
| Agent CLAUDE.md missing | SessionStart fails | Hook returns gate | Post "agent config missing" reply; alert |
| Bot credential expired | API calls fail | 401/403 errors | Rotation via Infisical; alert with rotation instructions |
| Webhook delivery duplicate | Caught by dedup | Idempotency table hit | Return 200; no work performed |

## §3.5 Future extensions

Out of scope for v1 but worth designing around:

- **Multi-VPS scale** — replace SQLite with Postgres; replace in-process queue with Redis or NATS; horizontal scaling of the router behind a load balancer
- **Containerized MCP servers** — each MCP in its own container for stronger isolation
- **Web UI** — a small dashboard for ops (cost per agent, active sessions, recent errors, schedule overview)
- **Approval gates** — a category of trigger that requires human approval before a session runs (e.g. Marketer wants to send a >10K-recipient email; router pauses, posts an approval-required button, resumes on click)
- **Trace export** — OpenTelemetry traces for full session lineage including SDK calls + tool calls
- **Per-tenant isolation** — when multi-project goes live, ensure cross-tenant data can't leak in shared state

## §3.6 Meta-agent (Harness)

Harness is the 7th agent — the only one whose write scope is the `dev-team/` repo itself (rather than a target project). It maintains the harness: authors new agents, modifies existing ones, writes new skills, debugs misbehaviors, evolves the router. See [AGENTS.md → The Top 6 + Harness](../AGENTS.md#the-top-6) for the full role description.

The router treats Harness as a normal agent for routing + session lifecycle. Three points where Harness's behavior is structurally distinct from the Top 6 — and the router enforces them.

### Inverted writeScope

Every Top-6 agent's `settings.json` has `dev-team/**` in `deniedPaths`. Harness has it in `allowedPaths`. The router's startup validation should:

- Scan every agent's `settings.json`
- Verify **only** `agents/harness/settings.json` has `dev-team/**` in its `writeScope.allowedPaths`
- If another agent has it in `allowedPaths`, refuse to start and log `config_drift: dev_team_writeScope_mismatch`

This is a defense-in-depth check — config-drift could otherwise let a corrupted (or maliciously-edited) settings.json grant another agent the keys to the harness.

### PR-only enforcement

Harness's SessionEnd hook is configured so `git_commit_if_changed` is forced to `create_pr: true` — no direct-to-`main` path exists. Triple-layer defense:

1. **`settings.json` deny list** — `Bash(git push origin main:*)`, `Bash(git push --force:*)`, `Bash(git push --no-verify:*)` all denied
2. **PreToolUse pattern block** — any push targeting `main`/`master`/`staging`/`production` is blocked at the tool-call layer
3. **SessionEnd hook** — the commit path is `git_commit_if_changed` with `create_pr: true` mandatory; no `merge` action available

If a single layer were modified, the others still catch the bypass. Changes to any of these three layers should themselves be flagged with extra scrutiny (router-engineer skill enforces this when authoring; reviewers should treat any PR weakening these layers as Risk High).

### Auto-applied PR labels

When Harness's SessionEnd creates a PR, the router auto-applies labels based on the diff (per `auto_apply_conditional_labels` in `settings.json`; `computeLabels` in `git_commit_if_changed.ts`). The diff is `git diff --name-only <base>...HEAD`, the same three-dot range GitHub shows as the PR's files:

| Condition | Label |
|---|---|
| Always | `agent:harness-bot` |
| Diff touches `agents/harness/**` | `meta-self-modify` |
| Diff touches `router/**`, `deploy/**` or `identities/*.yml`: what `deploy.yml` says waits for a manual deploy (identities have no reload path) | `router-change` |
| Diff touches two or more `agents/<name>/` directories (`agents/PROTOCOLS.md` and other top-level files count for no one) | `cross-agent` |
| Session activated `misbehavior-debugger` skill | `urgent` |

Until HAR-13 only the last row was implemented, and the three path rows were applied by nothing. If the base branch can't be diffed, the path rows are skipped with a warning rather than guessed. `router-change` used to say `router/src/**`. Since #61, `deploy.yml` is manual-only (`workflow_dispatch`), so the label no longer means "merging redeploys". It means **the change does nothing live until someone runs a deploy**. That covers router code, compose, and identity edits, which are read once at boot.

The `agent:harness-bot` owner label resolves to Harness through `ownerFromLabel` in `routing/classifier.ts`. That function accepts an `agent:<name>` label naming either the agent id or its `linear.agent_handle`. Before HAR-13 it knew only bare ids, so none of the handle-form owner labels the agents' hooks apply ever resolved.

These labels only reach a PR the **router** opens. A PR opened from a Claude Code web session goes through the GitHub MCP and gets no hook labels at all. Its provenance is the `Agent: <persona>` trailer (PROTOCOLS.md §7).

Labels signal to human reviewers what kind of scrutiny the PR deserves. `meta-self-modify` carries a two-reviewer convention; `router-change` requires the reviewer to also verify `router/ARCHITECTURE.md` was updated.

### PR spoofing defense

At PR-merge time (whether via GitHub UI or the GitHub MCP), the router validates that PRs labeled `agent:harness-bot` were actually opened by the Harness GitHub App identity (the `user.login` field in the PR webhook payload matches `harness-bot[bot]`). If not, the label is removed and a `#agents-alerts` notification fires — defends against a human accidentally (or maliciously) applying the label to a non-Harness PR.

### Session-log read access

The `misbehavior-debugger` skill needs to read `/var/log/agents/sessions/*.jsonl` (per-session deep-trace files). Two implementation options for v1:

- **Filesystem MCP** — `@modelcontextprotocol/server-filesystem` with read-only scope on `/var/log/agents/sessions/`. Simple, well-understood. Currently the default per `agents/harness/mcp.json`.
- **Router-internal endpoint** — Harness queries the router via an authenticated internal API for session-log content. More controlled (the router can filter sensitive content); more work to build.

Pick the simpler one (filesystem MCP) for v1; reconsider if sensitive content surfaces in session logs that should be filtered.

### Cost-cap discipline

Harness's spend counts as **infrastructure spend**, not per-feature spend (per [COST_ANALYSIS.md](../COST_ANALYSIS.md)). Heavy Harness usage (frequent agent modifications) shifts the cap ($100/mo for v1). The `cost_ledger` table separates by agent so per-agent attribution is clean.

### What the router does NOT do for Harness

- **Auto-merge Harness PRs** — humans always merge.
- **Apply CI gates** — Harness doesn't deploy itself; the merged PR triggers CI which does the deploy.
- **Skip cost-cap pre-flight** — Harness has the same pre-flight check as every other agent; no special bypass.
- **Allow Harness to invoke other agents directly** — Harness operates by opening PRs that humans approve, not by triggering other agents. (If a Harness change cascades to multiple agents, it's one coherent PR; not multiple agent invocations.)

---

## Appendix A — Naming + conventions

| Concept | Convention |
|---|---|
| Agent IDs | kebab-case: `strategist`, `builder-server`, `pr-brand-steward` (skill IDs same) |
| Session IDs | Integer surrogate key in SQLite; for external display use base36-encoded |
| Branch names | `agent/<agent>/<task-id>`; example `agent/builder-server/eng-1234` |
| Worktree paths | `/var/lib/agents/worktrees/<agent>/<task-id>/` |
| Log session files | `/var/log/agents/sessions/<session-id>.jsonl` |
| Linear labels | per the [Linear Labels Protocol](../agents/PROTOCOLS.md#5-linear-labels-protocol) |
| Slack channels | `#agents-alerts`, `#security`, `#growth`, etc. — per-project, configured in identities |

## Appendix B — Open questions

These need answers before or during router implementation:

1. **Conversation continuity timeout** — default 30 days; per-agent override in `settings.json`. Confirm default is right.
2. **One Anthropic key vs per-agent keys** — per-agent gives clean cost attribution in Anthropic dashboard at the cost of more keys. Lean per-agent.
3. **MCP `mcp.json` for agents we haven't written yet** — Strategist, Platform, Guardian don't have `mcp.json` files yet (Marketer + Builders do). To be authored before Phase 2.
4. **`scheduler/schedules.yml` initial content** — gather all the cron schedules referenced across agent SPECs into the file before Phase 2.
5. **Identity files (`identities/<agent>.yml`)** — not yet authored. To be authored before each agent's wave goes live.
6. **Worktree disk budget** — at 6 agents × 5 concurrent sessions each = 30 worktrees max. With ~100MB per worktree (small project), that's 3GB — fine. For larger target projects (1GB+ checkouts), revisit.
7. **Loop-prevention depth limit** — default 5 in `agent_chain`. May need tuning based on realistic chains we observe.
8. **SQLite backup destination** — local snapshots fine for now; `litestream` to a Hetzner Storage Box for off-host backup is a phase-1.5 task.
