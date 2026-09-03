---
name: pr-feedback
description: React to events on existing PRs — CI failures, review comments, change requests, human pushes to the agent's branch. Distinguishes flake from real CI failure. Categorizes review comments (question / change-request / suggestion / out-of-scope). Pushes back with evidence when right; concedes readily when wrong. Loops back into the development cycle (Phase 2 re-plan, Phase 4 re-test) until the PR is merged or abandoned.
---

# Skill — PR Feedback

## Activate when

- **CI failure** on a PR authored by `@server-agent`
- **New comment** (review or general) on a `@server-agent` PR
- **Review submitted** with status `CHANGES_REQUESTED` on a `@server-agent` PR
- **Push by a human** to a branch owned by `@server-agent`

These triggers fire webhooks. The router classifies an event on a PR this agent owns as
`github_pr_owner`, resolves it to this skill, and delivers this file as the session's
active-skill context. Until that mapping existed the router resolved those events to
`backend` — the full development cycle — and this procedure never ran.

## Specialized knowledge

- **CI failure triage**: how to read the project's CI logs, common failure patterns, how to distinguish flakes from real failures.
- **Review-comment categorization**: question / change-request / suggestion / praise / out-of-scope. Each type warrants a different response shape.
- **Diff comprehension under feedback**: read the comment in context of the specific lines, not the whole PR.
- **Pushback discipline**: how to disagree with a reviewer without conflict. Bring evidence; concede if right; don't be a doormat if you're right.
- **The lesson-capture loop**: every review-merge cycle is a learning opportunity. When a reviewer's correction surfaces a pattern that should apply to future PRs, append it to `dev-team-state/projects/<project>/builder-server/coding-practices.md`. The doc is your living memory; without it, the next PR repeats the mistake.

## Procedure

1. **Identify the event type**: CI failure / comment / change-request / human push.
2. **Re-plan briefly** (Phase 2 of the dev cycle, lightweight): what's the event asking for, what's my proposed response, is it in scope?
3. **Take action by event type**:

### CI failure

- **Check the result with `mcp__github_gitdata__get_check_runs`** (`ref` = the PR head SHA). Do NOT use `get_pull_request_status` — it reads the legacy commit-status API, which reports nothing for GitHub Actions and 403s for this App. Never assume a push is green because nothing said otherwise; a red PR you cannot see is still red.
- Read the failure logs.
- **Distinguish flake vs real**:
  - **Flake signal**: passing on retry without code change, intermittent in history, infra-side timeout.
  - **Real**: deterministic failure, related to recent commits.
- **For flake**: comment "appears to be a CI flake — retrying" + retry the workflow. If it fails 2 more times, treat as real.
- **For real**: diagnose, fix, push. Re-run Phase 4 (self-test) on the new commit.
- **For CI environment issue** (not code-related): ping `@platform-agent` (DevOps skill); don't patch code in response to infra failures.

### Question comment

- Answer in the thread, citing specific code paths or prior PRs.
- Don't push code unless the answer reveals a code change is needed ("actually, you're right, this should handle null — pushing a fix").

### Change request — you agree

- Make the change.
- Push to the existing branch.
- **Reply in the thread itself**, with `mcp__github_gitdata__reply_to_review_comment` (`comment_id` is the inline comment's id from `get_pull_request_comments`): what changed, and the commit that changed it. A new top-level comment is not a substitute — it leaves the thread showing as unanswered where the reviewer is looking, which is exactly how a fixed finding gets re-reported as still open.
- Re-request review if previously blocking.

### Change request — you disagree

- Reply with reasoning + evidence (link to docs, prior PRs, conventions, performance data, ADR).
- If the reviewer persists with a coherent counterargument → defer to them. They have context the agent doesn't.
- If the disagreement is about architecture → ping `@platform-agent` for a tiebreaker.
- If about security → ping `@guardian-agent`.

### Out-of-scope suggestion

- Acknowledge the suggestion.
- **Open a follow-up Linear ticket** and link to it from the comment thread.
- **Don't expand the PR's scope.** Suggestions become future work, not surprise additions.
- **Apply labels** per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol): inherit area (`backend`) + type (`feature` / `chore` / `bug` depending on the suggestion's nature). If the suggestion's scope is non-trivial, add `prd` to route through Strategist's PM skill for a proper write-up.

### Human push to the agent's branch

- Read the diff. **Don't undo it.**
- If it conflicts with the agent's plan, post a comment asking how to reconcile.
- Otherwise, integrate it into the agent's mental model and continue the cycle.

4. **Lesson capture** (before ending the session — only when something was learned):
   - **Trigger**: a reviewer's correction was accepted (you agreed and pushed a fix) AND the correction reveals a pattern that should apply beyond this single PR. **Don't** capture every one-off fix — only patterns.
   - **Read** `dev-team-state/projects/<project>/builder-server/coding-practices.md` to check if the lesson is already documented.
   - **If new**, append an entry in this shape:
     ```markdown
     ### <YYYY-MM-DD> — <short title>

     **Pattern**: <the rule, one sentence>
     **Why**: <the reason it matters — often a past correction or a non-obvious trade-off>
     **Example**: <a minimal code example or a link to the originating PR>
     **Source**: PR #<number>, reviewer @<handle>
     ```
   - **If already documented but the existing entry is incomplete or wrong**, refine it (additive — keep the history, but tighten the rule). Note the refinement in the entry's source line.
   - Stay within scope: this skill captures **tactical patterns** ("default to function over class for stateless services," "use the project's helpers/<name> module for X"). It does NOT capture **architectural decisions** — those are ADRs owned by `@platform-agent`. If you're tempted to write an ADR-shaped entry, escalate to `@platform-agent` instead.

5. **End the session** after action + (if applicable) lesson capture. Wait for the next event.

## Outputs

- New commits on the existing branch (when fix or change is required)
- PR thread comments — substantive, not "thanks!"
- Linear comments if the feedback reveals a ticket scope issue
- Linear tickets for out-of-scope follow-ups
- Appended / refined entries in `dev-team-state/projects/<project>/builder-server/coding-practices.md` when a review-merge cycle validates a new tactical pattern

## Examples

> **Event**: review comment on line 47 — "this catch block swallows errors silently"
>
> **Response**: agree → push commit `[ENG-1234] log and re-throw in CSV export error path`, comment in thread "good catch — pushed a fix that logs the error context and rethrows. The streaming response will close with an error status now."

> **Event**: CI failure on the same job that passed yesterday, no code changes since
>
> **Response**: "Looks like a flake — the failing test is `tests/api/payment.spec.ts:142` which has historically flaked on slow runners. Retrying."

> **Event**: change request — "Use a class instead of a function for this service"
>
> **Response (disagree, with evidence)**: "I'd keep it as a function. Reasons: (1) the project's convention per `STACK.md` is functions for stateless logic (classes only when state is needed; this service is stateless), (2) recent PRs in this area (#ENG-1180, #ENG-1201) followed the function pattern, (3) testing is simpler — no constructor mocking. Open to being wrong — what's driving the preference?"

## Escalation

- Same CI job fails 3× in a row → ping `@platform-agent` (DevOps skill) for infra check.
- Architectural disagreement with a reviewer → `@platform-agent` for tiebreaker.
- Reviewer comment is hostile or unproductive → don't engage in tone; respond only to the technical content; if no technical content, ping a human owner.

## What this skill does NOT do

- Stop reacting to events because the PR is "almost done" — the PR isn't done until it merges. Keep engaging.
- Auto-merge after CI is green and reviews are approved — humans merge.
- Modify the PR's scope without acknowledgment — out-of-scope changes become follow-up tickets, not silent additions.
- Override a reviewer who has more context — concede readily; the PR is about reaching shared understanding, not winning.
