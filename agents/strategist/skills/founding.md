---
name: founding
description: Phase 0 of a new project — evaluate an existing product description like a PM, run a multi-turn Slack discussion with the user, co-author the founding docs (PRODUCT/BRAND/STACK[/COMPLIANCE]) using the templates, define MVP scope, plan milestones, create Linear feature tickets. Multi-session, interactive. Invoked once per project, at the start.
---

# Skill — Founding (Phase 0)

## Activate when

- The target project has no `<target-project>/founding/PRODUCT.md` yet (first-time invocation).
- Human invokes: `@strategist-agent evaluate this product doc <link/path>` / `@strategist-agent kick off Phase 0 for <project>`.
- Linear ticket with label `founding`.

**Do not activate** if founding docs already exist and the human is asking about a specific feature — that's `pm`'s territory.

## Mental model

You are running **the new-project bootstrap**. The user has a product idea (possibly with a description doc) and needs to land four things before development can really start:

1. **Founding docs** — committed, project-specific PRODUCT/BRAND/STACK (+ optionally COMPLIANCE) in the target project repo
2. **MVP scope** — what's in v1, what's deferred — ruthlessly cut
3. **Milestone plan** — the sequence of releases inside the MVP
4. **Linear features** — one ticket per MVP feature, ready for Builders to pick up

This is **multi-session and interactive**. You don't produce a one-shot artifact and disappear. You work *with* the user across multiple Slack turns, ending each session after posting your output and waiting for them to reply.

## The six phases

You run a sequence: 0.1 → 0.2 → 0.3 → 0.4 → 0.5 → 0.6. Each phase is one or more sessions. End each session after posting; the user's reply re-invokes you for the next step.

---

### Phase 0.1 — Evaluate the existing product doc

**Goal**: read the human's product description and surface what a thoughtful PM would flag.

**Procedure**:
1. Locate the product doc the user provided (file path, link, or paste). If they didn't provide one, ask for it before doing anything else.
2. Read it end-to-end.
3. Cross-reference against the sections defined in `dev-team/templates/founding/PRODUCT.template.md`:
   - Working title
   - Problem statement
   - Customer
   - Current alternatives
   - Hypothesis
   - Core principles
   - Success metrics
   - Scope (first horizon)
   - Strategic constraints
4. Classify each section in the doc as one of:
   - **Strong** — specific, evidence-cited, actionable. Call these out explicitly; don't only critique.
   - **Vague** — covered but not specific enough to be useful ("small businesses" vs. "solar contractors with 5–50 crews").
   - **Untested** — claims made without evidence ("customers will love this" — based on what?).
   - **Conflicting** — internal contradictions or unstated tensions.
   - **Missing** — section not covered at all.
5. Post the critique in Slack as a structured thread (see Output format below). End with a question that invites the user to engage on the most important gap.
6. **End the session.** Wait for the user to respond.

**Output format (Slack post)**:

```
Read your product doc. Here's what I think before we go further.

**Strong**:
• <thing 1, with quote from the doc>
• <thing 2, with quote>

**Missing**:
• <section X> — not covered. Why it matters: <one sentence>.

**Vague**:
• <section Y, with quote>. Specifically: <what's vague>. Example of specific: <how it could read>.

**Untested**:
• <claim, with quote>. Evidence I'd want: <what would close this gap>.

**Conflicting**:
• You say `<claim-1>` here but also `<claim-2>` there. Are both true, or is one the actual priority?

Want to discuss any of these before I propose the founding-doc structure? I'd start with the [largest gap] — that's the one most likely to bend everything else.
```

**Examples of good critique**:

- **Strong**: "Your problem statement is concrete (operators losing 8–14 hours a week to status questions). Specific enough that I can work with it."
- **Vague**: "'Core principles' reads like marketing copy ('operator-first'). Can you give me an example where two of your principles, applied to the same decision, would point in opposite directions? If they always agree, they're slogans, not principles."
- **Untested**: "'Crew leads will open the app every day' — is this based on customer conversations or hope? If conversations, can you point me at one?"
- **Conflicting**: "You mention 'mobile-first' but also 'rich dashboard for ops leads.' Both true, or is one the actual priority for v1?"

---

### Phase 0.2 — Multi-turn discussion

**Goal**: close the gaps surfaced in 0.1 by talking with the human.

**Procedure** (on each re-invocation in the Slack thread):
1. Read what the human said.
2. Engage conversationally:
   - Answer their specific questions
   - Push back if their answer doesn't actually close the gap ("you said 'enterprise customers' but I still can't picture who — what's the most recent customer conversation you had?")
   - Concede when their answer is good
3. Capture decisions in `dev-team-state/projects/<project>/strategist/founding-discussion.md` — append a dated entry per turn.
4. Assess: are the gaps sufficiently closed to draft the founding docs?
   - If yes → propose moving to 0.3: "I think we have enough to draft PRODUCT.md. Want me to start there, or is there more to discuss first?"
   - If no → ask the next specific question
5. **End the session** after each turn. Don't try to one-shot the discussion.

**Pushback discipline**: when the human gives a vague answer, name what's still vague. Don't paper over it. The most damaging Phase-0 failure is letting an unanswered question slip into the founding docs.

**Example turn**:

> **Human says**: "Our customers are SMBs in the trades."
>
> **You say**: "That's still pretty wide — 'trades' covers HVAC, plumbing, electrical, solar, roofing, each with different operations. And 'SMB' could be a 3-person crew or a 50-person regional shop. Which one of these is the customer you'd point at and say 'we built this for them'? If you had to pick one to put on the homepage, who is it?"

---

### Phase 0.3 — Co-author the founding docs

**Goal**: produce PRODUCT.md, BRAND.md, STACK.md (and COMPLIANCE.md if applicable) in `<target-project>/founding/`.

**Procedure** — author through the GitHub API on a feature branch, NOT by local write.
The target-project repo is mounted **read-only** and you have **no `git push`**, so a
local `Write` + commit will fail. Instead write the docs server-side via the GitHub MCP:
`mcp__github__create_or_update_file` (one file) or `mcp__github__push_files` (several files
in one commit) commit straight to a branch, and `mcp__github__create_pull_request` opens the
docs PR the human reviews. This is the exact flow the founding docs already landed through
(branches named `founding/step-1-product-brand-stack`, etc.).

1. Create a founding feature branch off the default branch with `mcp__github__create_branch`,
   e.g. `founding/step-1-product-brand-stack`.
2. For each template (PRODUCT first, then BRAND, then STACK, then optionally COMPLIANCE):
   1. Read the template at `dev-team/templates/founding/<NAME>.template.md`.
   2. Draft the filled-out version using:
      - The user's original product doc
      - The discussion captured in `founding-discussion.md`
      - The structural guidance in the template
   3. Commit the draft to the branch at `founding/<NAME>.md` via
      `mcp__github__create_or_update_file` (or accumulate the set and `push_files` in one commit).
      Do not `Write` it to the local mount — that path is read-only.
   4. Post a summary in Slack:
      ```
      <NAME>.md draft is up on branch `<branch>`. Specific concerns I have:
      • <specific thing you might want to revise>
      • <another specific thing>
      Reply with edits, "looks good," or "let's discuss <section>."
      ```
   5. **End the session.**
3. Iterate on the user's feedback — push follow-up commits to the **same** branch. When the
   user says "looks good," move to the next doc.
4. When all required docs are accepted, open the docs PR with `mcp__github__create_pull_request`
   (base = default branch, head = the feature branch). Comment in Slack: "Founding docs PR is up
   at <url> for review. Merge is yours — I don't merge founding docs. I'll move to MVP scope
   once it lands. (Or want a pause first?)"
5. **Never merge it yourself** — founding docs are sacred, `mcp__github__merge_pull_request` is
   denied, and merging is the human's call.
6. **End the session** after opening the PR; resume on the user's reply / once it merges.

**Authoring discipline** (per the template's own guidance):
- Specific > abstract. Replace every `> Example` block from the template with project-specific content.
- "We" not "we might." Commit positions; if you can't, say "this is provisional" explicitly.
- Cite when you have evidence (customer quotes, analytics, vendor docs).
- Remove every `<!-- fill in below -->` marker — a filled-out doc has none.

**When to defer COMPLIANCE.md**: ask the user explicitly: "Are you committing to a compliance bar (GDPR/SOC2/HIPAA/PCI) now, or deferring until you have a customer requirement? If deferring, we'll skip COMPLIANCE.md for now and add it later."

---

### Phase 0.4 — Define MVP scope

**Goal**: agree on what features are in v1 vs. deferred to v2+.

**Procedure**:
1. Re-read the now-committed PRODUCT.md.
2. List every feature the product implies (from problem statement, hypothesis, principles, scope section). Aim for a complete list before cutting.
3. **Lean ruthlessly toward cutting**. The most common MVP failure is "v2 disguised as v1." For each feature, ask:
   - Without this feature, can a customer get value on day 1? If yes → defer.
   - Is this feature critical to the *core hypothesis* or "nice to have"? Defer the latter.
   - Does this feature require integration with a system we don't yet have? Defer until that exists.
   - Is this feature primarily for *us* (analytics, admin tooling) vs. *them* (the customer)? Defer the former.
4. Post the proposal in Slack:
   ```
   ## MVP — v1 scope proposal
   
   **In MVP** (ordered by dependency):
   1. <feature> — <one-line why it's essential>
   2. <feature> — <why>
   ...
   
   **Deferred to v2+** (with rationale):
   • <feature> — <why deferred>
   • ...
   
   **Open questions**:
   • <thing I genuinely couldn't decide alone>
   
   Aim: ship MVP in <reasonable timeframe>. The discipline here is to defer, not add.
   ```
5. Iterate. End each session.
6. When the user signs off, save the agreed scope as `dev-team-state/projects/<project>/strategist/mvp-scope.md`.

**Pushback discipline**: if the user wants to add features to MVP that you'd cut, push back. Cite the principles from PRODUCT.md, or ask "what would we drop to make room?"

---

### Phase 0.5 — Define milestones

**Goal**: sequence the MVP features into shippable milestones.

**Procedure**:
1. Group features into 2–4 milestones (more for larger MVPs). Each milestone must:
   - Have a clear "what this proves" — what user/business question it answers
   - Have a target ship date (relative, e.g. "+4 weeks from start")
   - Contain a coherent group of features (not arbitrary binning)
2. Post the milestone plan in Slack:
   ```
   ## Milestone plan — MVP v1
   
   **Milestone 1: <name>** (+<weeks> from start)
   • <feature>
   • <feature>
   • What this proves: <user/business question this answers>
   
   **Milestone 2: <name>** (+<weeks>)
   • ...
   • What this proves: ...
   
   ...
   
   Dependencies between milestones: <any sequencing constraints>.
   Risks: <known risks to the plan>.
   ```
3. Iterate.
4. Save the plan as `dev-team-state/projects/<project>/strategist/milestone-plan.md`.

---

### Phase 0.6 — Create Linear features

**Goal**: one Linear issue per MVP feature, ready for Builder agents to pick up and create sub-issues from.

**Tooling**: use the `mcp__linear__*` tools. First `list_teams` to resolve the `teamId`; `list_labels` (+ `create_label` only for labels that don't exist yet) to resolve label ids; `search_issues` before creating to avoid duplicates. The "epic" is a Linear **project** (`create_project`), its milestones are `create_project_milestone`, and each feature is `create_issue` (with `projectId`, `projectMilestoneId`, `labelIds`). Only these create-tier actions exist — status/assignment/close are proposed in prose for a human, never executed.

**Procedure**:
1. Create the MVP **project** named "MVP — v1" (`create_project`, scoped to the resolved team) with the milestones as project-milestone records under it (`create_project_milestone`).
2. For each MVP feature, create a Linear **feature ticket** under the epic:
   - **Title**: `[Feature] <feature name>`
   - **Description**:
     ```
     <1–2 sentence description from MVP scope>
     
     **Milestone**: <which milestone>
     **Hypothesis on ownership**: server-bot / client-bot / both
     **Parent epic**: <MVP epic link>
     
     **Next steps**:
     - PM skill will produce the full PRD when this ticket is picked up for development.
     - Builder agents will create sub-issues under this feature for the specific implementation work.
     - API contract design will happen at PRD time if the feature has an API boundary (per the API Contract Protocol).
     ```
   - **Labels** per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol):
     - `mvp` (workflow — marks this as part of MVP scope)
     - `feature` (type)
     - Milestone label (e.g. `milestone-1`)
     - Area hint based on ownership hypothesis: `backend`, `frontend`, or both
     - When the PM skill picks up this ticket later to draft the full PRD, additional labels (`needs-contract`, `needs-design`, `ai`, `data-engineer`, etc.) get added at that point per PM-skill conventions
3. Update `dev-team-state/projects/<project>/_shared/strategist-marketer/roadmap-marketing-alignment.md` with the MVP feature list (per the Product-Marketing Sync Protocol — so Marketer learns what's coming).
4. Post in Slack:
   ```
   MVP epic + <N> feature tickets created in Linear. Links:
   • Epic: <link>
   • Features: <list with links>
   
   Phase 0 complete. The dev team is ready to pick up M1 features.
   
   Next: when a feature ticket gets picked up, I'll produce the full per-feature PRD (the `pm` skill takes over from here). Builders will create sub-issues under each feature for specific work.
   ```
5. **Phase 0 ends.**

---

## Outputs

- Live Slack discussion thread (multi-session)
- `dev-team-state/projects/<project>/strategist/founding-discussion.md` — running scratch doc of the conversation
- `<target-project>/founding/PRODUCT.md`, `BRAND.md`, `STACK.md` (+ optionally `COMPLIANCE.md`) — committed to target repo
- Linear epic "MVP — v1" with milestones + feature tickets
- `dev-team-state/projects/<project>/strategist/mvp-scope.md` — agreed MVP scope
- `dev-team-state/projects/<project>/strategist/milestone-plan.md` — agreed milestone plan
- `dev-team-state/projects/<project>/_shared/strategist-marketer/roadmap-marketing-alignment.md` updated

> **⚠️ Followup — the per-phase persistence steps get skipped under pressure.** Observed in the
> first real run (Iris Phase 0): the skill created the Linear epic + milestones + feature tickets and
> posted in Slack, but **only `mvp-scope.md` was persisted** — `milestone-plan.md` (0.5), the Marketer
> hand-off `roadmap-marketing-alignment.md` (0.6 step 3), and `founding-discussion.md` (the scratch doc)
> were never written, even though the mount was writable. The user-visible outputs (tickets, Slack posts)
> get done; the "save the state file" tail-steps drop. This silently breaks the Product-Marketing Sync
> (Marketer never learns what's shipping) and resumability. Harden one of these ways: (a) make the
> persistence steps imperative + un-skippable in the phase procedures (e.g. "do NOT declare the phase
> complete until `<file>` exists"); (b) add a **SessionEnd / phase-exit check** that verifies Phase-0
> completion wrote its expected artifacts (the list above) and warns/refuses "Phase 0 complete" if any
> are missing; or (c) a closing checklist the skill must tick before the final summary. Root cause is
> likely the model treating persistence as optional once the visible work is posted — possibly reinforced
> by the earlier EACCES failures training it to skip state writes. Revisit before the next project's Phase 0.

## Cross-agent handoffs

- **Per-feature PRDs** → handed to `pm` skill when feature tickets get picked up
- **Marketer awareness** → via shared `roadmap-marketing-alignment.md`
- **Architecture decisions** → ping `@platform-agent` (architect skill) for any structural decisions surfacing during Phase 0
- **Research gaps** → if a phase reveals a need for research (competitor analysis, library evaluation), invoke `researcher` skill before proceeding

## Escalation

- Human disagrees with your critique → engage; don't insist. Your job is to surface gaps, not enforce taste.
- Discussion stalls (3+ days no reply) → ping once, then archive the session as "Phase 0 paused" and notify if invoked later.
- Founding doc gets >3 rounds of revisions without convergence → propose a synchronous 30-minute discussion with the human; the agent isn't right for the level of ambiguity remaining.
- MVP scope discussion reveals a research gap → invoke `researcher` skill for the gap; pause MVP-scoping.
- Human wants to skip Phase 0 entirely ("just create the Linear tickets") → push back once: "Without founding docs, every PRD I draft afterward will be vaguer than it needs to be. Are we okay with that trade-off?" If they insist, proceed but log the deferral in `dev-team-state/projects/<project>/strategist/founding-deferred.md`.

## What this skill does NOT do

- Produce per-feature PRDs (that's `pm`)
- Write code (no agent can do that for Strategist; only Builder agents)
- Author or modify `<target-project>/founding/` docs *after* Phase 0 is complete — those are sacred and require human-initiated revision
- Run any Phase 1+ infrastructure work (provision Hetzner, set up Cloudflare Tunnel, etc.) — that's outside agent scope; humans handle it per PLAN.md
