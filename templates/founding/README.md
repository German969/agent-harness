# Founding Templates

This directory holds **project-agnostic blueprints** for the foundational docs every Cyrus-managed agent reads at session start. The templates themselves don't describe a specific project — they describe the *shape* a project's founding docs should have so the agents can load them consistently.

## What's here vs. what's in your project

```
dev-team/templates/founding/        ← TEMPLATES, project-agnostic
                                      part of the agent product
                                      edit only to evolve the blueprint

<target-project>/founding/          ← FILLED-OUT founding docs, project-specific
                                      authored in Phase 0 of the bootstrap
                                      read by every agent at session start
```

The right-hand path is configured per project in `.dev-team.yml` under `founding.path`. The default is `founding/`, relative to the target project root.

## The four templates

| Template | Required | Covers |
|---|---|---|
| `PRODUCT.template.md` | Yes | What we're building, for whom, why, how we measure success |
| `BRAND.template.md` | Yes | Voice, tone, vocabulary, visual identity |
| `STACK.template.md` | Yes | Tech choices, architecture, conventions |
| `COMPLIANCE.template.md` | Optional | GDPR / SOC2 / HIPAA / PCI / regional. Skip if not applicable yet — add later when you commit to a compliance bar. |

## Phase 0 workflow

For a new target project:

1. Copy each template into the target project's `founding/` directory, dropping the `.template` suffix:
   ```
   cp dev-team/templates/founding/PRODUCT.template.md   <target-project>/founding/PRODUCT.md
   cp dev-team/templates/founding/BRAND.template.md     <target-project>/founding/BRAND.md
   cp dev-team/templates/founding/STACK.template.md     <target-project>/founding/STACK.md
   # COMPLIANCE.md only if you're committing to a compliance bar
   ```
2. Fill out each section in the target's copy — replace every `> Example` block and `<!-- fill in below -->` marker with your project's actual content.
3. Human-review the docs. They are the most-read context the agents will ever consume; time spent here pays off every agent session afterward.
4. Commit the filled-out docs to the target project repo.
5. Configure `.dev-team.yml` in the target repo if your `founding/` lives at a non-default path.

After Phase 0 lands, Phase 1+ of the bootstrap (see `dev-team/PLAN.md`) can proceed.

## Authoring discipline

When filling out the templates:

- **Specific > abstract.** "Solar contractors with 5–50 field crews" beats "small businesses." "We never use 'leverage' as a verb" beats "we have a clear voice."
- **Replace every example.** The `> Example` blocks in each template are illustrative only — they're from hypothetical SaaS products to show what good answers look like. Your filled-out doc should not contain them.
- **Remove every `<!-- fill in below -->` marker.** A filled-out founding doc has no fill-in markers left.
- **"We" not "we might."** The founding docs commit to a position. If you're not committed, say so explicitly ("this is provisional; revisit by Q2") rather than hedging every sentence.
- **Cite when you have evidence.** Customer quotes, analytics, vendor docs — link them.

A Knowledge Curator skill (Strategist) periodically scans the filled-out founding for stale text or unanswered placeholders.

## Why this separation matters

An earlier iteration of the plan put project-specific founding docs *inside* the agent product repo (`dev-team/founding/`). That conflated two things:

- The **agent product** (this repo, `dev-team`) — project-agnostic. The agents work on any target project they're added to.
- The **target project** — has its own identity, conventions, brand. The founding docs are part of *the project's* identity, not the agent product's.

Templates → product. Filled-out docs → project. The agents read the latter, configured per `.dev-team.yml`.

## Evolving the templates

If you discover a recurring gap when filling out founding docs across multiple projects (a section that's always insufficient, a section that's always skipped, a missing template entirely), update the template here. The Knowledge Curator skill in Strategist will catch staleness in *filled-out* founding; humans catch insufficiency in the *templates*.
