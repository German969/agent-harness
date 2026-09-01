---
name: memo
description: Persist a decision or note to the Strategist's memory when a human explicitly asks to "log/record/save this to memory" (or "to your decisions"). A single, targeted state write to recent-decisions.md — nothing else. Runs on the default model (not Haiku) so the write actually happens.
---

# Skill — Memo (persist a decision to memory)

## Activate when

- A human explicitly asks you to **log / record / save / note / remember** something **to your memory** (or "to your decisions", "in recent-decisions"). The router routes this phrasing here instead of `conversational`.

This skill exists for one reason: to reliably **write** the entry. Do not treat it as Q&A — the deliverable is a persisted file change, not a chat message describing one.

## What you do

1. **Write the entry — this is your first and main action.** Append a short, dated entry to your memory file `dev-team-state/global/strategist/recent-decisions.md` using the `Edit` tool (or `Write` if the file doesn't exist yet). The file is loaded at SessionStart, so you already have its current contents and exact path.
2. **Format** each entry as:
   ```
   ## <YYYY-MM-DD> — <one-line title>

   <2–5 bullet points capturing the decision, the reasoning, and any follow-up.>
   ```
   Append it; never overwrite existing entries.
3. **Confirm from the tool result.** Only after the `Edit`/`Write` tool returns success do you tell the human it's saved — quote nothing you didn't observe. Your SessionEnd hook then commits and pushes `recent-decisions.md` automatically; you don't run git yourself.
4. **Reply briefly**: one or two lines confirming what you recorded and where. No essay.

## Non-negotiable facts (do not get these wrong)

- **`dev-team-state` is WRITABLE — it is your own memory.** The read-only mount is the target-project *code* repo; that constraint does **not** apply here. Never claim `dev-team-state` is read-only or that you lack a tool to write it — you have `Edit`/`Write` and write access.
- **The SessionEnd hook does NOT do the writing for you.** It only commits files that already exist on disk. If you don't call `Edit`/`Write` yourself, nothing is saved and nothing is committed. Never defer the write to "SessionEnd will record it."
- **Never fabricate an obstacle.** If you didn't call the tool, don't claim a permission/read-only error. If a write genuinely fails, quote the real error text and say so plainly.

## What this skill does NOT do

- Produce PRDs, analyses, research, or founding docs (those are `pm`/`ba`/`researcher`/`founding`).
- Write anywhere other than the Strategist's own memory (`global/strategist/**`, or a project's `projects/${PROJECT}/strategist/**` when the decision is clearly project-scoped).
- Run git commands — persistence to origin is the SessionEnd hook's job.

## Voice

Terse and factual. Confirm the record, cite the file path, stop. Follow the Slack `mrkdwn` rules from the main CLAUDE.md when replying to Slack.
