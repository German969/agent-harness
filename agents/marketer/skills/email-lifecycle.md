---
name: email-lifecycle
description: Email & lifecycle marketing — newsletters, lifecycle sequences (onboarding, re-engagement, churn prevention, winback), product announcements. Draft-only in the email platform (Customer.io / Mailchimp / Brevo / Resend / Loops). Never sends, never schedules-to-send. New lifecycle email types get Guardian compliance review before human approval.
---

# Skill — Email & Lifecycle Marketing

## Activate when

- Campaign Lead invocation (launch email)
- Lifecycle event triggers (configured in the email platform — e.g. trial-day-3, churned-30d, milestone-reached)
- Scheduled newsletter cadence
- Linear `email` label
- Direct: `@marketer-agent draft a launch email for <feature>`

## Specialized knowledge

- **Email anatomy** — subject line, preview text, body structure (hook → value → CTA), unsubscribe footer compliance.
- **Lifecycle pattern library** (loaded from `dev-team-state/projects/<project>/marketer/email/lifecycle-patterns.md`):
  - **Onboarding** — educate, activate (first-action-completed); don't dump everything in one email
  - **Re-engagement** — remind, incentivize (light); single-CTA
  - **Churn prevention** — acknowledge, address the objection; not "please come back"
  - **Winback** — offer change; new feature or new value angle
  - **Launch announcement** — pain → product → CTA; concise
  - **Newsletter** — curated, not exhaustive; lead with the one thing worth reading
- **Segmentation discipline** — write for **one segment per email**, not a soup. Use segment definitions from `dev-team-state/projects/<project>/marketer/email/segment-definitions.md`.
- **Deliverability hygiene** — avoid spam triggers in subject (excess caps, $$$, ALL CAPS, multiple exclamation marks), balance text/image ratio, ensure list health.
- **CAN-SPAM / GDPR / regional regulations** — cross-references with `@guardian-agent`'s compliance skill for new email types.
- **The email platform's API behavior** — must support draft-creation without auto-send. Each platform (Customer.io / Mailchimp / Brevo / Resend / Loops) has slightly different draft semantics — read the project's specific MCP docs at session start.
- **Customer testimonial discipline** — same universal Marketer rule as `content-writer`: launch emails and customer-story newsletters can only quote customers from `dev-team-state/projects/<project>/marketer/testimonials/approved.md` with `approved: yes` status. After using a quote, log to the Used stage in `_shared/strategist-marketer/testimonial-pipeline.md` per the [Product-Marketing Sync Protocol](../../PROTOCOLS.md#3-product-marketing-sync-protocol). The `testimonial_permission_check` validator hook will block writes containing unapproved quotes — but the discipline is yours, not the hook's.

## Procedure

1. **Identify the email type + segment.** If unclear, bounce to a human marketer.
2. **Pull relevant context**:
   - Launch emails: read the product PRD / feature behavior (from code + Strategist + Builders if needed). Never invent feature capabilities.
   - Lifecycle emails: read user-state context (which lifecycle stage, what behavior triggered)
3. **Draft the email** with structure:
   - **Subject line** — propose 2–3 options (it's its own craft)
   - **Preview text** — complements the subject, doesn't repeat
   - **Body**: hook (1 line), value (2–3 short paragraphs), CTA (one button, one link)
   - **Footer** — unsubscribe + physical address (CAN-SPAM); GDPR opt-out if applicable
4. **Save as draft** (never scheduled-to-send) in the email platform. Use the platform's draft API only — see `settings.json` for the allowed verbs.
5. **For new lifecycle email types**: invoke `@guardian-agent` (compliance skill) for a review pass before going to human approval.
6. **Slack notification** with: draft link + segment + estimated send size + subject line options for human pick.

## Outputs

- Email drafts in the email platform (Customer.io / Mailchimp / Brevo / Resend / Loops)
- 2–3 subject-line options per draft
- Updated `dev-team-state/projects/<project>/marketer/email/lifecycle-patterns.md` when new patterns emerge from retros
- Slack notification with: draft link, segment, estimated send size, subject options

## Label conventions

When creating tickets per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol):
- Type: `content`
- Area: `email` + sub-area (`launch`/`lifecycle`/`newsletter`)
- For new lifecycle types needing Guardian review: also `compliance-review`

## Examples

> **Output (launch email for CSV export)**:
> *Subject options*:
> 1. "Your data, your way"
> 2. "CSV export is here"
> 3. "Stop rebuilding reports in spreadsheets"
>
> *Preview text*: "47,000 rows in 60 seconds. No row caps."
>
> *Body*:
> *"For three years, you've been telling us: 'I want my data out, in CSV, on demand, without a row limit.'*
>
> *We listened. CSV export is live for growth-tier and above — synchronous for files under 5,000 rows, async-with-email for everything bigger. No caps, no upsell.*
>
> *[CTA button: Export your first file]*
>
> *Docs walkthrough → [link]"*
>
> *Footer*: standard CAN-SPAM + GDPR.
>
> *Segment*: growth-tier and above, active in last 90 days. Estimated send size: ~1,200 recipients.
>
> Saved as draft in Customer.io as `csv-export-launch-2026-11-12`. Slack notification posted to `#marketing` with the three subject options for human to pick.

## Escalation

- New lifecycle email type with regulatory implications (e.g. churn-prevention email containing pricing offers, or a re-engagement email for users who haven't opted in to marketing emails) → loop in `@guardian-agent` (compliance) **before** going to human approval.
- Segment definition unclear → bounce to a human marketer to confirm before drafting.
- Send size unexpectedly large (>10K recipients) → flag for explicit human approval at the size. Don't draft + queue large blasts without a human-checked segment.
- Email touches sensitive data handling (e.g. an export confirmation email, a security-incident notice) → loop in `@guardian-agent` (compliance + security skills).
- Lifecycle event trigger fires unexpectedly often (suggesting a tracking bug or runaway loop) → don't keep generating drafts; alert `@server-agent` (data-engineer skill) about the trigger health.

## What this skill does NOT do

- **Send any email.** No `send`, no `send_now`, no `schedule_send`. Drafts only.
- **Set a draft to active / scheduled.** Activating a lifecycle email is human-driven.
- **Invent product features.** Same rule as `content-writer` — read the codebase, ask Strategist/Builders.
- **Make compliance determinations.** Loop in `@guardian-agent` for any new regulated email type.
- **Generate the visual assets** (banner, header image) — that's `creative-brief` + a human executor.
- **Decide segments at the strategic level** — `campaign-lead` or human marketer decides.
