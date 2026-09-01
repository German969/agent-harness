# BRAND — Founding Doc

> **This is a TEMPLATE.** Copy it to `<target-project>/founding/BRAND.md` (or wherever `.dev-team.yml` → `founding.path` points), fill in every section for your specific project, and commit it to the target repo.
>
> The agents read your filled-out version at the start of every session. Marketer reads it on every content draft — for the *external* voice it speaks in. Strategist's PR/Brand Steward skill reads it on every voice-review pass. Builder-Client touches it for design-token alignment. If this doc is vague, the brand voice across every channel will be vague.
>
> **Authoring discipline**: specific > abstract; capture real preferences not aspirations; replace every `> Example` block; remove every `<!-- fill in below -->` marker.
>
> Examples in this template are from a hypothetical developer-tool SaaS (deploy/rollback platform) — they're illustrative, not your project content.

---

## One-sentence positioning

The shortest possible answer to "what are you and who's it for?" Format: "We are X for Y vs Z." Both Y (audience) and Z (alternatives) matter — positioning that doesn't acknowledge what we're *not* is weaker.

> **Example**: We're the deploy-and-rollback tool for production engineers who hate Friday outages, vs. the Datadog/PagerDuty world that tells you what broke but doesn't help you fix it fast.

<!-- fill in below -->


---

## Brand voice

Three attribute pairs that capture the voice. Each pair contrasts the attribute with what people often mistake for it. Include short examples of what each sounds like in action and what it sounds like wrong — agents learn voice from concrete examples far more than from adjectives.

Stick to **three** pairs. More than three becomes a list nobody can hold in their head.

> **Example**:
> 
> **Confident, not arrogant.**
> - ✅ "Rollbacks under 30 seconds. Yes, even for the database migration."
> - ❌ "The fastest rollback platform on earth. Period."
> 
> **Direct, not blunt.**
> - ✅ "This feature isn't in the free tier — here's why we drew that line."
> - ❌ "Pay if you want it."
> 
> **Technical, not exclusive.**
> - ✅ "PostgreSQL 14+ recommended for partition support. We have a 13 fallback if you can't upgrade yet."
> - ❌ "Obviously you're on Postgres 14, right?"

<!-- fill in below -->


---

## Tone variants

How voice shifts by context. Same core voice, different register. Include one short example per context — even one sentence is enough to anchor.

The categories below are a default starter set. Drop the ones that don't apply (e.g. no press function yet); add ones that do (e.g. partner communications).

> **Example**:
> 
> - **Marketing site**: confident, customer-pain-first, evidence-heavy. Lead with the outage story.
>   > *"Last Friday, a startup deployed at 4:51 PM. By 5:09 PM, they'd rolled back, lost 7 minutes, and went home on time."*
> 
> - **Docs**: direct, instructional, generous with examples. Assume the reader is competent and busy.
>   > *"Rollback works on Postgres 14+. Earlier versions: see the [13 fallback](link)."*
> 
> - **Support**: warm, take responsibility, never deflect.
>   > *"You're right, that error message is terrible. Here's what's actually happening, and we're shipping a clearer message this sprint."*
> 
> - **Press / launch posts**: confident, restrained, evidence-cited. Skip the hype.
>   > *"We shipped automatic rollback today. It works the same on Friday at 5pm as Tuesday at noon."*
> 
> - **Social**: punchy, builder-energy, occasionally funny. Never preachy. Never engagement-bait.
>   > *"Yes, the database comes back too."*

<!-- fill in below -->


---

## Vocabulary preferences

Words we use. Words we avoid. Domain language. Reading-level target. Be specific — generic "use professional language" is useless; "we never use 'leverage' as a verb" is actionable.

> **Example**:
> 
> **Use**: deploy, rollback, blast radius, recovery, observability, incident, runbook, on-call, post-mortem, SLO.
> 
> **Avoid**: synergy, leverage (as a verb), seamless, transform, journey, holistic, end-to-end (overused), enterprise-grade (meaningless), AI-powered (unless the AI is doing something specific worth naming).
> 
> **Domain language**: We assume the reader is a production engineer or close. We don't define "p99," "blue-green," "canary," "circuit breaker." We do define our own product terms (e.g. "freeze window") on first appearance.
> 
> **Reading level**: technical-fluent. Plain English, but no over-simplification. Target Flesch reading ease ~50 — not 80.

<!-- fill in below -->


---

## Customer language

How customers describe themselves and their problems. **Verbatim.** This is what we mirror in our content — we don't invent over it.

This section is collected, not composed. Pull quotes from sales calls, support tickets, social mentions, interview transcripts. Real words from real people beat anything we'd write.

> **Example**:
> - "Friday outage syndrome" — we keep hearing this
> - "I can ship anything except on Fridays"
> - "Rollback is just redeploy the old version, right? No it isn't."
> - "Three a.m. on-call shifts are not a personality"
> - Customers describe themselves as "SREs," "platform engineers," "infra people," or "the one who gets paged." Never "engineers" generically.

<!-- fill in below -->


---

## Visual identity

High-level direction. Specifics (Figma file, brand kit) live elsewhere — this section is the *judgment* we want agents and humans to apply when creating visual content.

> **Example**:
> - **Palette**: navy base (#0A1F3A), single accent yellow (#FFC93E for emphasis only), generous whitespace. No gradients. No purple.
> - **Typography**: Inter for everything. Mono (JetBrains Mono) for code, log lines, terminal output.
> - **Photography / illustration**: line illustrations of terminals and dashboards, never stock-photo handshakes. Real screenshots beat made-up dashboards.
> - **Logo**: wordmark only. Avatar uses the wordmark's "V." No icon-mark; the wordmark has to work alone.

<!-- fill in below -->


---

## What we never say

Claims requiring substantiation we don't have. Framings to avoid. Legally sensitive areas. The Marketer agent's PR/Brand Steward skill enforces this list before content goes to human review.

> **Example**:
> - "Zero downtime" — we say "<30s rollback" because that's what we can prove.
> - "Bulletproof" / "unbreakable" / any military metaphor.
> - "Eliminate human error" — we reduce it; we don't eliminate it. Engineers know the difference.
> - Comparing competitors by name in marketing without their product team's awareness (we'll compare in docs/sales when relevant, but not in blog posts).
> - Any claim about a specific customer's reliability numbers without explicit written approval.

<!-- fill in below -->


---

## Voice in action

Three short paragraphs (~80 words each) showing the voice across different contexts. This is the **most-read section of this doc** by other agents — they pattern-match against these when generating content. Give them real examples, not placeholders.

Pick three contexts that span the range your brand actually operates in (e.g. one warm/empathetic, one factual/announcement, one teaching). Replace the examples below with your own.

> **Example — blog opener**:
> Last Friday, a startup deployed at 4:51 PM. By 5:02 PM, the database connection pool was on fire and the on-call engineer was deciding which migration to roll back first. The rollback finished at 5:09 PM. Total impact: 7 minutes of degraded traffic, no data loss, no PagerDuty page above L2. That's not how Fridays usually go.

> **Example — support reply**:
> Hey — you're right, that error message is terrible. The deploy is failing because the target environment has a different secret schema than the source. We're showing you a generic 500 instead of "secret X missing in env Y." Fixing the message this sprint; in the meantime here's what to check (link). Sorry for the lost time.

> **Example — launch post**:
> We shipped automatic rollback today. Three rules: anyone can pull the lever, the database comes back too, and it works the same on Friday at 5pm as Tuesday at noon. Docs: link. Architecture post explaining the database part: link. Yes, we built this because someone deployed to ours on a Friday.

<!-- fill in below — write three voice-in-action paragraphs from your project -->


---

## Closing checklist before committing

- [ ] Every `> Example` block is replaced with project-specific content.
- [ ] No `<!-- fill in below -->` markers remain.
- [ ] "Voice in action" has three real paragraphs from your project, not placeholders.
- [ ] Customer language is verbatim from real customers (or marked clearly as anticipated voice for pre-launch projects).
- [ ] Brand voice contrasts are specific (three pairs with ✅/❌ examples), not adjective soup.
- [ ] Document is human-reviewed by whoever owns brand. Marketing input strongly recommended.

Refine this doc when you ship a piece of external content the team loves. Capture what made it work. The doc evolves; it's not static.
