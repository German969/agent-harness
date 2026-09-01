---
name: misbehavior-debugger
description: Investigate an agent misbehavior reported by a human, root-cause it from the session deep-trace, and PR the corrective change. The most-valuable Harness skill — it's the feedback loop that makes the fleet smarter over time. Output is always anchored in the session log (no speculation); root cause is named in the PR description; corrective change can be in CLAUDE.md, settings, skills, MCP config, or router code.
---

# Skill — Misbehavior Debugger

## Activate when

- `@harness-agent <agent> did <X> wrong on session <id>` — primary trigger
- `@harness-agent <agent> misbehaved — see session <id>`
- `@harness-agent why did <agent> <X>` (often Q&A first, then this skill if a fix is needed)
- Linear ticket with `agent-misbehavior` label
- Follow-up from another agent's `pr-feedback` skill flagging a problematic Harness PR (rare; this is the inverse — Harness fixing other agents — but symmetric)

## Specialized knowledge

- **The session deep-trace file** at `/var/log/agents/sessions/<session-id>.jsonl` — every line emitted in that session's context (logs, Claude SDK request+response, tool calls, hook results, cost ledger entries). Loaded conditionally via the `session-logs` MCP per `mcp.json`.
- **The session row** in the router's SQLite `sessions` table — the meta record (agent, skill, thread_key, status, turns, cost, error_kind).
- **The agent's current config** that produced the misbehavior — CLAUDE.md + settings.json + the skill that was active.
- **The misbehavior log** at `dev-team-state/projects/<project>/harness/misbehavior-log.md` — prior misbehaviors + their fixes; pattern-spot recurring failure modes.
- **Root-cause categories** (the framework):
  - **Prompt-level**: the CLAUDE.md or skill file didn't constrain the behavior the human expected
  - **Setting-level**: a hook didn't fire, a permission allowed too much, a cost cap fired wrong
  - **Routing-level**: the wrong agent or wrong skill activated
  - **MCP-level**: a tool the agent expected wasn't available, or returned a wrong value
  - **Router-level**: the runtime substrate behaved wrong (rare; high-impact)
  - **Model-level**: the model itself failed to follow the prompt despite clear instructions — rare; this is the only category where the fix is "make the prompt more emphatic" rather than fix a config bug
- **The fix-altitude question**: did the agent do *exactly what it was told* (prompt bug) or did it *not do what it was told* (model-level)? The former is the common case; the latter is rare and requires different framing.

## Procedure

1. **Identify the session_id** from the human's message. If unclear, ask. The session_id is the join key for everything.

2. **Load the session deep-trace** — `/var/log/agents/sessions/<session-id>.jsonl`. Read it linearly. Don't skim; the misbehavior is often in a single 3-line span.

3. **Load the session row** from the router's SQLite — meta info (which agent, which skill, when, status, error_kind if any).

4. **Reproduce the human's complaint in your head**:
   - What did the user expect?
   - What did the agent do?
   - Where do those diverge? (timestamp + log lines)

5. **Categorize the root cause** per the 6 categories above:
   - Quote the specific log line(s) that demonstrate the failure
   - Identify which file produced the offending behavior (`CLAUDE.md:<line>` / `skills/<skill>.md` / `settings.json` hook `<hook-name>` / etc.)
   - State plainly: "the prompt did NOT instruct against this" (prompt bug) or "the prompt instructed against this but the model didn't follow" (model-level)

6. **Check the misbehavior log** for prior similar failures. Is this a recurring pattern? If yes, prior fixes might inform this one.

7. **Design the corrective change**:
   - **Prompt bug** → add a Critical Behavior to CLAUDE.md OR a specialized-knowledge bullet to the skill file
   - **Setting bug** → add or fix a hook entry in settings.json
   - **Routing bug** → fix the identity routing in `identities/<agent>.yml` or the classifier in router/src/routing/
   - **MCP bug** → fix or swap the MCP entry in `mcp.json`
   - **Router bug** → escalate to `router-engineer` skill; bring it into the same PR
   - **Model-level** → strengthen the prompt + add the failure case to the agent's skill examples ("don't do X" with the example)

8. **Append to the misbehavior log** at `dev-team-state/projects/<project>/harness/misbehavior-log.md` using these fields per entry:

   - `## <YYYY-MM-DD> — <agent> — <one-line summary>` (header)
   - **Session**: backtick-wrapped session-id + a link to the trace at `/var/log/agents/sessions/<session-id>.jsonl`
   - **Reported by**: human handle + Slack thread link
   - **Expected**: what the user wanted
   - **Actual**: what the agent did
   - **Root cause**: category (Prompt-level / Setting-level / Routing-level / MCP-level / Router-level / Model-level) + the specific file:line that produced the behavior
   - **Quote from log**: the offending log lines (use a fenced code block — NOT a blockquote — to preserve formatting)
   - **Fix**: link to the PR + one-line summary

9. **Open the corrective PR**. PR description (extra-detailed for misbehavior fixes):
   - **Rationale** section: link to the original session, quote the failing behavior, name the root-cause category
   - **Changes**: the specific edits
   - **Cross-impact**: does this change affect other agents (e.g. is the same misbehavior pattern likely to appear in agents with similar configs)?
   - **Test plan**: ideally an actionable test that REPRODUCES the original misbehavior and verifies the fix prevents it
   - **Risk**: typically Medium (changes to constrain behavior; may have false-positives on legitimate behavior); High if the fix touches a Critical Behavior

10. **Apply labels**: `agent:harness-bot`, `urgent` (auto-applied per SessionEnd hook for this skill), possibly `meta-self-modify` (if fixing a Harness misbehavior — rare but possible), often `cross-agent` if the fix pattern applies to multiple agents.

11. **Slack notification** to `#harness-engineering` + crosspost to the affected agent's primary channel.

## Outputs

- Updated misbehavior log entry
- ONE PR with the corrective change
- Slack notification linking the original session + the corrective PR

## Label conventions

- PR labels: `agent:harness-bot` + `urgent` (auto-applied for this skill); + `cross-agent` if multiple agents affected
- Linear trigger label: `agent-misbehavior`

## Examples

> **Request**: `@harness-agent @marketer-agent tried to publish a draft email to the live segment on session msg_01abc — fix it`
>
> **Investigation**:
> 1. Load `/var/log/agents/sessions/msg_01abc.jsonl`.
> 2. Find the offending tool call: `mcp__email__send_now` attempted at line 142. The call was DENIED by the PreToolUse hook (correct!). But the agent's reply to the user said "I've scheduled the email for tomorrow" — implying success.
> 3. Root cause: **Prompt-level**. Marketer's CLAUDE.md Critical Behavior #1 says "draft never publish" — present and clear. The PreToolUse hook correctly blocked the send. BUT: the agent's REPLY to the user falsely claimed success when the hook had blocked. The prompt doesn't tell the agent what to do when a tool call is denied by a hook.
> 4. Append to misbehavior log.
> 5. Fix: add a sub-section to Marketer's CLAUDE.md ("If a PreToolUse hook blocks a tool call, the reply MUST acknowledge the block — never claim success on a denied action") + an example showing the right phrasing.
> 6. Cross-impact: this pattern (agent claiming success on hook-denied actions) could affect any agent with PreToolUse hooks. Recommend a Protocol-level rule or a shared CLAUDE.md section across agents. → broader cross-agent ticket follow-up.
> 7. PR labels: `agent:harness-bot`, `urgent`, `cross-agent`.

> **Request**: `@harness-agent @server-agent opened a PR with a failing test on session msg_02xyz — it shouldn't have`
>
> **Investigation**:
> 1. Load session trace.
> 2. Find: `pnpm test` ran at line 87 → exit code 1; the agent's next action at line 92 was to open the PR anyway.
> 3. Root cause: **Setting-level**. Builder-Server's `backend` skill Phase 4 (self-test) doesn't have a hook that BLOCKS PR-opening on failed tests. The skill says "self-test before opening PR" but the actual check is in the agent's procedure, not enforced.
> 4. Fix options:
>    - (a) Strengthen the prompt (model-level enforcement) — likely insufficient; this misbehavior shows the prompt was already there
>    - (b) Add a PreToolUse hook that blocks `mcp__github__create_pull_request` if the last `pnpm test` output had a non-zero exit code — this requires router-engineer support for a stateful "last-test-result" check
>    - (c) Add a sub-step to the skill's procedure that EXPLICITLY says "if tests fail, do NOT proceed; either fix the test or open as draft PR" — at least makes the failure mode more salient
> 5. Recommendation: (c) first (cheap), then evaluate if (b) is worth the router complexity.
> 6. PR with the (c) change. Mention (b) as a follow-up option in the PR description.

## Escalation

- **The session_id provided doesn't exist** in the trace directory → push back: ask the human to verify the session_id (typo? wrong agent?). Don't fabricate an investigation.
- **The misbehavior was actually correct behavior** that the human disagrees with → push back; explain why the agent's behavior was correct per its config. If the human still wants a change, it's a `agent-modifier` (intentional behavior change), not a misbehavior fix.
- **The root cause is model-level** → frame it that way honestly. "The prompt clearly says don't do X; the model did it anyway. Strengthening the prompt may help but isn't guaranteed. Recommend adding an explicit example + considering a PreToolUse hook as a backstop."
- **The misbehavior reveals a pattern affecting 2+ agents** → file a `cross-agent` ticket for the broader fix; open the immediate PR for the reporting case + flag the broader issue in the PR description.
- **The misbehavior is severe** (security violation, publish-gate bypass, etc.) → escalate IMMEDIATELY to `#agents-alerts` + DM the human reviewer before opening the PR. Don't wait for the normal flow.

## What this skill does NOT do

- **Speculate about causes** — every claim cites a session-log line.
- **Auto-merge the corrective PR** — humans review and merge.
- **Treat correct-but-disliked behavior as a misbehavior** — push back if the agent did exactly what its config says.
- **Fix the misbehavior in the agent's STATE** (e.g. removing the offending log entry) — fix the CONFIG so it doesn't recur. State is history.
- **Skip the misbehavior-log append** — even fixed misbehaviors stay in the log for pattern-spotting.
