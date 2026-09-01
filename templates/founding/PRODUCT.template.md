# PRODUCT — Founding Doc

> **This is a TEMPLATE.** Copy it to `<target-project>/founding/PRODUCT.md` (or wherever `.dev-team.yml` → `founding.path` points), fill in every section for your specific project, and commit it to the target repo.
>
> The agents read your filled-out version at the start of every session. Strategist's PM skill consumes it on every PRD draft. Marketer's Campaign Lead consumes it on every campaign brief. Builders consume it when interpreting requests. If this doc is vague, every agent decision downstream is vaguer.
>
> **Authoring discipline**: specific > abstract; "we" not "we might"; replace every `> Example` block with your project's actual content; remove every `<!-- fill in below -->` marker.
>
> Examples in this template are from a hypothetical residential-solar contractor SaaS — they're illustrative, not your project content.

---

## Working title

The name we use for the project right now. Names evolve; that's fine. Pick one that's unambiguous in conversation today.

> **Example**: `Volt` — internal codename for the residential-solar workflow product. (Real name TBD after the next round of validation interviews.)

<!-- fill in below -->


---

## Problem statement

One paragraph. What's broken in the world that no current product addresses well? Lead with the customer pain, not the technology. Specificity here pays off every time an agent later asks "is this in scope?" or "who is this for?"

> **Example**: Residential solar contractors run their install operations on spreadsheets, group chats, and tribal knowledge. A typical 12-crew operation loses 8–14 hours a week to status questions ("did the inspector show up?", "is the permit back?"), and 1–2 jobs per month slip past their committed install date because nobody has the full picture. Bigger contractors buy a $30K/year ERP that solves *part* of this, but it's so heavy that crew leads don't actually use it — so the spreadsheets come back. Nobody has built an operations product that crew leads will open every day.

<!-- fill in below -->


---

## Customer

Who experiences this problem? Be specific enough that you could find one and ask them. Include segment, size, role, and current behavior. "Small businesses" is not a customer; "solar contractors with 5–50 field crews managing residential installs across multiple jurisdictions" is.

Where it matters, distinguish primary user (the person we design for first) from secondary users (who also touch the product) and from buyer (who signs the check) — these are often different people.

> **Example**:
> 
> **Segment**: Residential solar contractors in the US, $5M–$50M revenue, 5–50 install crews.
> 
> **Primary user — operations lead**: often the founder or a senior PM, responsible for keeping installs on schedule across multiple counties with different permit cycles. Lives in spreadsheets today; checks them ~20 times a day.
> 
> **Secondary user — crew lead**: needs the day's schedule and yesterday's status in <30 seconds on a phone in a truck. Today gets this via group chats and morning standup calls.
> 
> **Buyer**: usually the same operations lead, sometimes the founder/owner if revenue >$20M. Decision cycle 2–4 weeks; price elasticity low at our entry tier ($299/mo), high above $2K/mo.

<!-- fill in below -->


---

## Current alternatives

What customers do today + why it's inadequate. Be specific about each alternative; don't lump them. The agents use this to push back when a feature request is "really just another version of what already fails."

> **Example**:
> - **Spreadsheets** (most common, ~70% of customers we've interviewed): zero phone usability; no real-time collaboration; status drifts within hours; impossible to roll up across crews.
> - **General-purpose PM tools** (Monday, Asana, ClickUp): not built for the install lifecycle (permit → install → inspection → PTO); customizable but every contractor builds the same custom workflow badly.
> - **Heavy solar ERPs** (Salesforce-based, Aurora-adjacent): expensive ($30K+/yr), powerful, but so configurable they're abandoned by crew leads within weeks. Operations leads keep using them; crew leads silently revert to texts.
> - **WhatsApp + spreadsheets** (international markets, growing in US): zero structure; loses context after 24h.

<!-- fill in below -->


---

## Hypothesis

The proposed solution at concept level — what we're building, not how. Two or three sentences. Avoid implementation details; those belong in `STACK.md` and PRDs.

> **Example**: A mobile-first operations product that crew leads will actually open every day because it shows them their day in 5 seconds, and operations leads love because the data accuracy stays high *because* crew leads use it. The product owns the install lifecycle (permit → install → inspection → PTO) end-to-end with workflow templates customers can't break — only customize within.

<!-- fill in below -->


---

## Core principles

Three to five principles that guide every product decision. State them as commitments, not aspirations. Each should be specific enough that you can imagine using it to settle an argument.

A useful test: would two principles, applied to the same decision, point in opposite directions? If yes, you've captured real trade-offs the team has made. If every principle agrees on every decision, they're not principles, they're slogans.

> **Example**:
> 1. **Crew-lead-first, not exec-first.** Every feature is designed for the person holding the phone in the truck. Exec-facing features come later (rollups, dashboards) and consume crew-lead data — never the other way around.
> 2. **The product owns the workflow; the user owns the data.** Customers can't break or reshape the install lifecycle. They customize *within* the steps (forms, requirements) but not the structure.
> 3. **Status is observed, not entered.** Every status change has a real-world source (photo upload, signature, permit API webhook) — never a manual radio button. If we can't observe it, we don't claim it.
> 4. **Mobile is the product. Desktop is a window into the data.** Anything that doesn't work on a 375px screen with one hand is not shipped.
> 5. **No upsell for basics.** Things every customer needs (export, search, filters) are in every tier. We charge for scale and integrations, not for letting customers use their own data.

<!-- fill in below -->


---

## Success metrics

What we measure to know we won or lost. Quantitative, observable, attributable. "Customers love us" is not a metric. "Crew leads open the app on ≥4 days of the work week within 30 days of activation" is.

Pick the *minimum* set that would let you say "we did it" or "we didn't." Three to five metrics is usually right; more becomes noise.

> **Example**:
> - **Activation** (within 30 days of paid signup): ≥70% of paid customers have ≥1 crew lead opening the app on ≥4 days of the work week.
> - **Retention** (90-day): ≥85% of paid customers still active. (Definition of "active": ≥1 crew lead opens the app weekly.)
> - **Data accuracy** (proxy for value delivered): <10% of jobs have status drift >24h from real-world state (measured by sampled customer audits + photo-upload timestamps).
> - **Net revenue retention** (annual): >110% (expansion from added crews + tier upgrades).

<!-- fill in below -->


---

## Scope — first horizon

What we're explicitly NOT doing in the first year (or chosen release horizon). This is often more important than what we *are* doing — it prevents scope sprawl and tells the agents what to push back on when a request drifts.

State the horizon ("first 12 months," "to GA," "until Series A") so future readers know whether the constraint still binds.

> **Example** (first 12 months):
> - **Not** customer-facing portals — only the internal-user product.
> - **Not** financial integrations (QuickBooks, Stripe Connect, etc.) — assume customers run their existing ledger.
> - **Not** crew payroll/HR features — adjacent but a different product.
> - **Not** customer acquisition tools (lead capture, marketing automation) — different ICP.
> - **Not** commercial / utility-scale solar — only residential, single-family ≤20kW.

<!-- fill in below -->


---

## Strategic constraints

Non-negotiables that shape every decision: regulatory, ethical, brand, capital. These are the boundaries the agents should never propose crossing without a human override.

> **Example**:
> - **Customer data sovereignty**: customer data is in their own database (multi-tenant by row, not multi-tenant by db); we never aggregate across customers without explicit opt-in.
> - **Mobile carrier-agnostic**: we must work on bad reception. Offline-first; sync when reachable.
> - **No model lock-in for AI features**: any AI feature must work with at least two models (currently OpenAI + Anthropic). Costs may differ but functionality cannot.
> - **Bootstrap budget**: monthly burn cap is $50K through Q4 (no enterprise sales hires, no paid acquisition >$2K/mo).
> - **One-person-can-onboard**: a single customer success person can onboard a new account in <2h. No multi-week implementations.

<!-- fill in below -->


---

## Closing checklist before committing

- [ ] Every `> Example` block is replaced with project-specific content.
- [ ] No `<!-- fill in below -->` markers remain.
- [ ] Each section reads like it's about *this* project — not "could be any SaaS."
- [ ] Success metrics are observable (someone could measure them tomorrow with the right instrumentation).
- [ ] Scope explicitly states what's *out*, not just what's in.
- [ ] Document is human-reviewed. (Tag the reviewer here if useful.)

This doc evolves quarterly. Treat changes as deliberate (with a brief commit message noting *why*), not casual edits.
