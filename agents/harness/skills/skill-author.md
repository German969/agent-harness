---
name: skill-author
description: Add a new skill file to an existing agent. Lighter than agent-architect (one new file + skill-table update + maybe a Protocol addition). Heavier than agent-modifier (creating new structure, not tweaking existing). Always restates scope; matches the established 39-skill-file pattern.
---

# Skill — Skill Author

## Activate when

- `@harness-agent add a skill to <agent> for <topic>`
- `@harness-agent <agent> needs a <new skill name> skill`
- `@harness-agent give <agent> a way to <do X>` (when "do X" warrants its own skill rather than a tweak to an existing one)
- Linear ticket with `new-skill` label
- Follow-up from `gap-analyzer` digest where the recommended skill-to-invoke was `skill-author`

## Specialized knowledge

- **The 39 existing skill files** (auto-loaded conditionally when the target agent's skills are needed). Read 2-3 adjacent skills from the same agent before authoring — the new skill should match the agent's voice and depth.
- **The skill file anatomy** (canonical shape, established across 39 files):
  ```
  ---
  name: <skill-name>
  description: <one-line description for skill activation>
  ---

  # Skill — <Title>

  ## Activate when
  - <triggers>

  ## Specialized knowledge
  - <bullets — what context this skill adds beyond the agent's CLAUDE.md>

  ## Procedure
  - <numbered steps OR sub-sections by trigger type>

  ## Outputs
  - <artifacts produced>

  ## Label conventions
  - <Linear labels per Protocol #5>

  ## Examples
  > <concrete example, often blockquoted>

  ## Escalation
  - <when to bounce up or hand off>

  ## What this skill does NOT do
  - <explicit non-responsibilities>
  ```
- **Skill scope boundaries**: a skill is bounded by a coherent activation context. Don't author a skill that conflates two separate trigger surfaces; split them.
- **Skill vs sub-procedure**: if the proposed work is one sub-section of an existing skill's procedure, it's a sub-procedure (use `agent-modifier`), not a new skill.
- **Markdown rendering pitfalls** — skill files render in Slack / Linear / GitHub previews, and renderers vary in strictness. Avoid two known traps:
  1. **Angle-bracket placeholders that collide with HTML tags.** `<S>`, `<B>`, `<I>`, `<U>`, `<A>` (and their lowercase forms) are real HTML tags; renderers pass them through as `<s>` (strikethrough) / `<b>` (bold) / `<i>` (italic) / `<u>` (underline) / `<a>` (anchor) — applying that styling to everything until a closing tag that never comes. Use multi-letter placeholders (`<skill>`, `<hook-name>`, `<line>`) or backtick-wrap single letters (`` `<S>` ``) to neutralize.
  2. **Indented fenced code blocks containing `>` line-starts.** When a fenced code block is nested inside a list item (3-space indent) AND contains a line beginning with `> `, strict renderers can flip between code-block and blockquote modes mid-fence, corrupting state until end-of-document. Either avoid `>` line-starts inside indented code blocks, or restructure the block as a bulleted sub-list.

## Procedure

1. **Restate the request.** "Got it — you want a new skill `<name>` on `<agent>` that activates when `<trigger>` and produces `<output>`. Restating: it'll be a new file at `agents/<agent>/skills/<name>.md` + a new row in `<agent>`'s CLAUDE.md skill table + possibly a new Linear label in Protocol #5. Confirm + I'll PR."

2. **Pause for confirmation.** Same gate as `agent-modifier`.

3. **Read 2–3 adjacent skills** in the same agent's `skills/` directory. The new skill must match the agent's voice (terse vs. discursive; example style; escalation tone).

4. **Read the agent's CLAUDE.md** — specifically the skills table — to understand where the new skill fits in the agent's mental model.

5. **Author the skill file** at `agents/<agent>/skills/<name>.md` following the canonical anatomy. Length typically 100–250 lines; longer for skills with multi-trigger-type procedures (like Marketer's `campaign-lead` at ~310 lines).

6. **Update the agent's CLAUDE.md skill table** — add a new row with `name | when it loads | what it produces`. Order: alphabetical or by importance; match the existing table's convention.

7. **If the skill needs new specialized state** (e.g. a new state file like `coding-practices.md` or `brand-voice.md`), reference it in the skill file AND in the agent's `settings.json` SessionStart `conditional_load` block. Keep the state file empty/initial for now; the skill populates it on first run.

8. **If the skill needs a new Linear label** to activate, add it to [Protocol #5](../../PROTOCOLS.md#5-linear-labels-protocol) registry + update the agent's `identities/<agent>.yml` routing.linear_labels.

9. **If the skill needs a new Slack channel** for output, add it to the agent's settings.json allow list + identity's channels list.

10. **If the skill needs a new hook command** (e.g. a custom PreToolUse validator), this escalates to `router-engineer` skill — bring it into the same PR.

11. **Run post-edit hooks** (markdownlint + format).

12. **Open the PR** via SessionEnd hook (forces `create_pr: true`).

13. **PR description**: clear about what the new skill does, why it doesn't fit an existing skill, what cross-impact exists (Protocol #5 update? other agents to notify? scheduler entry needed?).

14. **Apply labels**: `agent:harness-bot`, possibly `cross-agent` if Protocol #5 or other identities updated.

15. **Slack notification** to `#harness-engineering` + crosspost to the agent's primary channel (so future sessions of that agent see the new skill is available).

## Outputs

- ONE new skill file
- Updated CLAUDE.md skill table
- Possibly updated Protocol #5 registry + agent's identity routing
- Possibly updated settings.json (new hook config or conditional_load entry)
- ONE PR

## Label conventions

- PR labels: `agent:harness-bot` (always); `cross-agent` if Protocol or identity touched
- Linear trigger label: `new-skill`

## Examples

> **Request**: `@harness-agent add a skill to Builder-Server for handling deprecation cycles — when an API endpoint is deprecated and needs to be removed in N months`
>
> **Restate**:
> "Confirming the shape:
> - New file: `agents/builder-server/skills/deprecation-manager.md` (~150 lines)
> - Activates on Linear `deprecation` label or `@server-agent deprecate <endpoint>`
> - Procedure: read the deprecation timeline; check usage in target project; surface a removal-plan PR; coordinate with Marketer's `email-lifecycle` skill for customer notification emails (cross-impact)
> - New Linear label `deprecation` → add to Protocol #5
> - Update Builder-Server's CLAUDE.md skill table (new row)
> - Update Builder-Server's identities/builder-server.yml routing.linear_labels
>
> Cross-impact: Builder-Server + Protocol #5 + Marketer (for the notification-email handoff). Risk: low. Effort: small. Confirm + I'll PR."
>
> (Author the file matching Builder-Server's voice — terse, evidence-cited, escalation-rich.)

> **Anti-example (this should be a sub-procedure, not a new skill)**:
> Request: `@harness-agent add a skill to Strategist for writing one-paragraph status summaries`
> Response: "That's a one-paragraph output pattern — too small for its own skill. I'd add it as a sub-procedure to Strategist's `pjm` skill (which already handles status reports). Switching to `agent-modifier`. Confirm?"

## Escalation

- **The proposed skill duplicates an existing skill's scope** → propose merging into the existing one (use `agent-modifier`) instead.
- **The proposed skill needs new hook commands** (custom validators, novel SessionStart commands) → bring `router-engineer` into the same PR.
- **The proposed skill would have cross-agent dependencies** (one skill talks to multiple agents) → consider whether the right fix is a new Protocol instead.
- **The proposed skill weakens a safety rule** → push back; require explicit justification + Risk High in the PR.
- **The skill name conflicts** with an existing skill in another agent (e.g. two `qa` skills) → distinguish by prefix or rename. Avoid generic names that cause routing ambiguity.

## What this skill does NOT do

- **Modify existing skill files** — that's `agent-modifier`.
- **Create new agents** — that's `agent-architect`.
- **Add a sub-procedure inside an existing skill** — that's `agent-modifier`.
- **Author skill content without reading adjacent skills first** — voice consistency matters.
- **Auto-merge its PRs.**
