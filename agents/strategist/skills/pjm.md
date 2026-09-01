---
name: pjm
description: Project Manager — status reports, dependency tracking, risk flagging. Runs scheduled (daily standup, weekly sprint review). Also handles ad-hoc status questions. Reads Linear ticket state + GitHub PR activity. Produces concise status reports linking to specific tickets. Never re-plans sprints autonomously.
---

# Skill — Project Manager (PjM)

## Activate when

- **Scheduled cron**:
  - Daily 09:00 in the team's primary timezone — standup summary
  - Weekly Monday 09:00 — sprint review (deeper)
- Slack ad hoc: `@strategist-agent status on <project>` / `risks this sprint` / `who's blocked`
- Cross-agent: a Builder bot reporting "I'm blocked on X" triggers a PjM check-in

## Procedure

1. Query Linear for tickets in the relevant project + time window.
2. Query GitHub for PR activity: open PRs, stale PRs (>3 days no review), draft PRs, recently merged.
3. Cross-reference with sprint plan (read `dev-team-state/projects/<project>/strategist/sprint-notes.md` — and `milestone-plan.md` if you're early in the MVP).
4. Identify:
   - **Blockers** — tickets idle >2 days in `In Progress`
   - **Slippage risk** — tickets >150% of estimated effort
   - **Review queue depth** — PRs waiting for human review
   - **Cross-agent handoffs not picked up** — tickets assigned to a Builder but no commits in 48h
5. Compose status report in Slack-friendly format (≤10 lines, links to specific tickets).
6. For high-risk items, post a Linear comment on the affected ticket nudging the assignee (comment is always allowed in the tiered Linear scope).

## Output format (Slack)

```
**Sprint <N>, Day <X>/<Y>** — <Z>/<Total> tickets in flight, <done>/<Total> done, <not-started>/<Total> not started.

**Blockers**: 
• ENG-1234 idle 3d (waiting on Builder-Server — pinged)
• ENG-1240 (review queue, PR open 4d — pinged reviewer)

**Slippage risk**: 
• ENG-1238 estimated 2d, in progress 3d.

**PRs waiting >2d for review**: 3 (<links>)

**Done since yesterday**: ENG-1232, ENG-1236
```

## Escalation

- Sprint plan ambiguous or missing → don't fake a status report. Post "I can't find a sprint plan for <project> — point me at it?"
- Multiple cascading slippages → tag the human PM in the message. Don't try to re-plan the sprint autonomously.
- Builder-* bot reports being blocked but the cause is outside engineering (e.g., compliance review pending) → route to the appropriate agent.

## Outputs

- Slack message to `#status` (or per-project channel, per the project's convention)
- Linear comments on blocked tickets (comment-only — no status changes without human slash command)

## What this skill does NOT do

- Re-plan sprints (humans do that).
- Move ticket status autonomously (gated per the Linear tiered scope — see CLAUDE.md).
- Estimate work (engineers estimate; PjM observes whether estimates are tracking).
- Decide priorities (PM skill + humans do that; PjM reports on what's happening).
