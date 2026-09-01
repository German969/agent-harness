---
name: gap-analyzer
description: Proactive monthly survey of the agent fleet to identify likely improvements. Reads every agent's CLAUDE.md / settings.json / skills / mcp.json, looks for patterns repeated across agents that could be promoted, SPEC sections referenced but not implemented, behaviors humans have requested without follow-through, and cross-references against the misbehavior log. Output is a DIGEST for human triage — no auto-PRs. Humans pick what to ask Harness to implement.
---

# Skill — Gap Analyzer (proactive monthly survey)

## Activate when

- **Scheduled cron** — `harness-gap-analyzer-monthly` (1st of each month, 14:00 ET) per `scheduler/schedules.yml`
- `@harness-agent survey gaps` — on-demand invocation
- `@harness-agent what's missing in <agent>` — focused survey on a single agent

## Specialized knowledge

- **The complete fleet at this moment**: every agent's CLAUDE.md / settings.json / skills / mcp.json / identity (auto-loaded at SessionStart per `settings.json`).
- **The recent misbehavior log** at `dev-team-state/projects/<project>/harness/misbehavior-log.md` (entries from prior misbehavior-debugger sessions).
- **Human-asked behaviors** — scrape `#harness-engineering` messages from the past 30 days where humans said "we should add X" or "@agent should be able to Y" but no PR followed.
- **The gap-survey history** at `dev-team-state/global/harness/gap-survey-history.md` — prior surveys' findings; identifies long-standing gaps that keep resurfacing.
- **Pattern-detection heuristics** (codified in CLAUDE.md but worth listing here):
  - Repeated patterns across agents that could be promoted (e.g. 3 agents have similar `pr-feedback` skills that could share a base)
  - Spec sections in `*/SPEC.md` referenced as "the agent should X" but no skill exists for X
  - Skills referenced from CLAUDE.md skill tables but with no corresponding file in `skills/`
  - Settings.json hooks referenced in CLAUDE.md but missing from the actual hooks config
  - Linear labels mentioned in skills but not in the Protocol #5 registry
  - Cross-agent dependencies that aren't documented in a Protocol
  - Skills whose actions overlap (potential duplication)
  - Critical Behaviors mentioned in PR feedback but not codified in any CLAUDE.md
- **Architecture drift signals** — comparing `router/ARCHITECTURE.md` to recent router code changes (if any exist).

## Procedure (monthly cron)

1. **Read every agent's complete config set** (already loaded at SessionStart for this skill).
2. **Sweep for the 9 pattern types** above. Cap at 20 candidate findings to keep the digest tractable.
3. **Cross-reference against the gap-survey history** — drop findings already flagged in past surveys that haven't been acted on (don't re-noise the team) UNLESS the gap has escalated (now affects more agents than last time).
4. **Cross-reference against the misbehavior log** — surface gaps that correlate with recent misbehaviors (these are higher-priority).
5. **Cross-reference against `#harness-engineering` requests** — surface gaps where humans have already asked for the change but no PR exists yet.
6. **Score each finding** (Low / Medium / High priority) based on:
   - How many agents are affected
   - Whether it correlates with a misbehavior
   - Whether a human has already asked for the change
   - How much spec-vs-reality drift it represents
7. **Compose the digest** following the template below.
8. **Post the digest to `#harness-engineering`** with explicit phrasing: "This is a survey for human triage; reply to ask me to implement specific items."
9. **Update `gap-survey-history.md`** with the survey's findings + the date.
10. **No PR opened.** This skill is digest-only.

## Procedure (on-demand)

Same steps, scoped to either the full fleet (`survey gaps`) or a single agent (`what's missing in <agent>`). On-demand surveys also post to `#harness-engineering` and don't open PRs.

## The digest template

```markdown
# Harness Gap Survey — <YYYY-MM>

**Scope**: full fleet | <agent>
**Findings**: <N total — H high, M medium, L low>
**Prior survey**: [<date>](link) — <N> findings; <N> acted on, <N> deferred, <N> still standing

---

## 🔴 High priority — <N findings>

### 1. <Title — concrete, action-oriented>
- **Affects**: <agents>
- **Evidence**:
  - <link to spec / file / line>
  - <correlation with misbehavior log entry, if any>
  - <correlation with #harness-engineering request, if any>
- **Suggested skill to invoke**: `agent-modifier` / `skill-author` / `agent-architect` / `router-engineer`
- **Effort**: small / medium / large

### 2. ...

## 🟠 Medium priority — <N findings>

### N. ...

## 🟡 Low priority — <N findings>

### N. ...

## ⚪ Long-standing (3+ surveys, no action)

### N. ...

---

**To act on a finding**: reply with `@harness-agent implement #<N>` or `@harness-agent tell me more about #<N>`. The numbered list above is the canonical reference.
```

## Outputs

- Digest in `#harness-engineering` (the only externally-visible artifact)
- Updated `dev-team-state/global/harness/gap-survey-history.md` with the survey's findings + date
- Updated `dev-team-state/projects/<project>/harness/gap-survey-log.md` for project-specific findings (if running with a project scope)

## Label conventions

This skill doesn't open Linear tickets or PRs. If a human follows up with `@harness-agent implement #<N>`, that follow-up session invokes the appropriate skill (`agent-modifier` / `skill-author` / `agent-architect` / `router-engineer`), and *that* skill's PR uses its own labels per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol).

## Examples

> **Sample digest entry (high priority)**:
>
> ### 1. Three agents have near-duplicate `pr-feedback` skill content
> - **Affects**: builder-server, builder-client, guardian (their `pr-feedback` skills overlap ~60%)
> - **Evidence**:
>   - `agents/builder-server/skills/pr-feedback.md` — `Procedure` section
>   - `agents/builder-client/skills/pr-feedback.md` — `Procedure` section (UI-specific overlay on Builder-Server's)
>   - `agents/guardian/skills/qa.md` — partial overlap on review-comment categorization
>   - Misbehavior log entry 2026-05-14: Guardian and Builder-Server both responded to the same review comment with conflicting recommendations
> - **Suggested skill to invoke**: `skill-author` (promote shared logic into a new shared skill OR a Protocol)
> - **Effort**: medium

> **Sample digest entry (low priority)**:
>
> ### 12. Marketer's `creative-brief` skill references a `dev-team-state/projects/*/marketer/creative-briefs/` path that's not yet in conditional_load
> - **Affects**: marketer
> - **Evidence**:
>   - `agents/marketer/skills/creative-brief.md:L60` — references the path for pattern reuse
>   - `agents/marketer/settings.json` SessionStart conditional_load DOES include it (added during alignment pass 2026-06-17)
>   - Already addressed; finding is stale. Removing from active list.
> - **Effort**: n/a (already done)

## Escalation

- **A finding correlates with a critical misbehavior** (e.g. an agent published external content despite the publish-gate) → mark it 🔴 HIGH + DM the human reviewer directly in addition to posting the digest. Don't wait for triage.
- **A finding is genuinely too speculative** (no clear evidence, just a hunch) → drop it. The digest is signal, not speculation.
- **The same gap has appeared in 3+ surveys without action** → escalate verbally in the digest: "this gap has been noted in 3 prior surveys; if it's intentional non-work, please mark it WONT-FIX so I stop surfacing it."

## What this skill does NOT do

- **Open PRs autonomously.** Digest-only. Humans triage. Other skills act.
- **Implement findings without explicit human ask.** Even if the gap is obvious, you wait.
- **Speculate without evidence.** Every finding cites a specific file/line/log entry.
- **Survey the target project's code.** Scope is the harness only (`dev-team/`).
- **Score findings on subjective taste.** Priority comes from observable signals (affected-agents count, misbehavior correlation, human-request correlation, age of gap), not from opinion.
