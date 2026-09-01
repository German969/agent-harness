# COMPLIANCE — Founding Doc

> **This is a TEMPLATE.** Copy it to `<target-project>/founding/COMPLIANCE.md` (or wherever `.dev-team.yml` → `founding.path` points), fill in every section, and commit it to the target repo.
>
> **OPTIONAL.** Skip this template if your project hasn't committed to a compliance bar yet. Greenfield consumer-SaaS projects often defer this until launch or a customer demands it. Add this doc when:
> - You're targeting an industry with regulatory requirements (healthcare → HIPAA, payments → PCI-DSS, EU customers at scale → GDPR seriously)
> - You're entering SOC2 audit process
> - A specific customer's contract requires you to document compliance posture
> - You're handling sensitive PII beyond the basics (government IDs, health, financial accounts)
>
> When you do add it, the agents read your filled-out version at the start of every session. Guardian's compliance skill consumes it on every PR touching regulated paths. Builders consume it when handling PII or audited operations. Marketer consumes it before making claims about compliance posture in external content.
>
> **Authoring discipline**: be honest about what applies. Claiming a regime you don't actually comply with is worse than not claiming it. If you're in-progress, say so explicitly with a target date.
>
> Examples in this template are from a hypothetical B2B marketplace SaaS with EU + US customers and a SOC2 audit in progress — they're illustrative, not your project content.

---

## Applicability

Which compliance regimes apply, and which explicitly don't — with reasoning for each. The agents use this to decide whether a code path needs compliance review at all.

> **Example**:
> - **GDPR**: Applies. We have EU customers and process their data (names, email, IP, location, business documents they upload).
> - **CCPA / CPRA**: Applies. We have California consumer users.
> - **SOC2 Type II**: In progress; targeting completion Q3 2026. Operating as if we already have it for purposes of audit-trail and access-control discipline.
> - **HIPAA**: Does NOT apply. We don't process Protected Health Information; customers' uploaded business documents are explicitly *not* PHI per our acceptable-use policy.
> - **PCI-DSS**: Does NOT apply. We don't store card data; Stripe handles all card-data touchpoints. We're a Stripe Connect platform (SAQ A territory).
> - **DORA** (EU financial-services operational-resilience): does NOT apply — we don't serve regulated financial entities.

<!-- fill in below -->


---

## Data classification

What counts as PII, sensitive PII, confidential business data, public. Be concrete about the categories — agents reading this should know how to classify a new field they encounter in code.

> **Example**:
> - **PII**: name, email, phone, IP address, geolocation finer than country, device identifiers, login timestamps.
> - **Sensitive PII**: government IDs (we don't currently collect these — flagged for review if a feature proposes it). Financial-account numbers (same: not collected; flag on encounter).
> - **Confidential business data**: pricing data we hold on behalf of customers, internal customer communications, vendor sub-processor lists belonging to customers.
> - **Public**: anything in marketing content after legal review; customer logos with explicit written permission; aggregate statistics with k-anonymity ≥ 50.

<!-- fill in below -->


---

## Data residency

Where data can live. Cross-border transfer rules and the legal basis for them (e.g. SCCs, adequacy decisions, customer consent).

> **Example**:
> - **EU customer data**: stays in EU AWS regions (eu-west-1 primary, eu-central-1 backup). No cross-region transfers without Standard Contractual Clauses (SCCs) in place.
> - **US customer data**: in us-east-1.
> - **Non-EU/US customers**: case-by-case at contract time. Default: data lives in us-east-1 with the customer's documented consent.
> - **Backups**: same region as primary. No cross-region backup transfer except for disaster recovery (cold-storage, encrypted, never read unless DR scenario).
> - **Logs / telemetry**: PII-scrubbed before leaving the application region; aggregate metrics may transit to us-east-1 Datadog without restriction post-scrub.

<!-- fill in below -->


---

## Audit trail requirements

Which operations get logged, what each log entry must contain, retention period. Guardian's compliance skill consumes this list to check that audit logging is present on PRs touching these operations.

> **Example**:
> 
> **Logged operations** (must have an `audit_log` entry per occurrence):
> - All authentication events (login, MFA challenge success/failure, password change, token issue/revoke).
> - All admin actions (user impersonation, deletion, permission change, billing tier change).
> - All data export operations (with size, format, destination, requester).
> - All cross-customer data access attempts (should be impossible by design; logged to catch bugs).
> - Bulk operations affecting ≥10 records.
> 
> **Required fields per audit log entry**: timestamp (UTC, microsecond), actor user_id, actor IP, actor user-agent, action name (enum), target entity type + ID, result (success/failure), failure reason if applicable, request ID for correlation.
> 
> **Retention**: 13 months in primary store (>1 year covers compliance + 1-month buffer). Older entries archived to cold storage; available for 7 years total for SOC2.

<!-- fill in below -->


---

## Right-to-be-forgotten / data-export discipline

The process for fulfilling GDPR Article 15 (access / export) and Article 17 (deletion) requests, plus CCPA equivalents. State the SLAs and the responsible team or agent.

> **Example**:
> - **Data export (GDPR Art. 15)**: fulfillable within 30 days. Produces a structured ZIP with the customer's data in a documented schema (`docs/compliance/data-export-schema.md`). Self-service via Settings → Privacy → "Download my data."
> - **Deletion (GDPR Art. 17)**: hard-delete from production stores within 30 days. Soft-delete from backups for the backup retention window (90 days), then irrecoverable. Self-service via Settings → Privacy → "Delete my account" (with 30-day grace + confirmation email).
> - **Manual / written requests**: support@<project>.com accepts written requests. Routed to a human; not bot-fulfilled.
> - **Audit logs of these operations**: retained even after the user data they describe is deleted (the audit logs reference user IDs but not the deleted PII).

<!-- fill in below -->


---

## Sub-processor list

All third parties that touch customer data, with what they touch and under what agreement. This list is published on the marketing site (typical SOC2/GDPR expectation); agents should treat it as the canonical inventory.

When a new third-party SaaS is proposed (Marketer wants a new analytics tool, Builder wants a new email vendor), the question "is it on the sub-processor list?" gates the decision.

> **Example**:
> 
> | Sub-processor | Data they touch | Agreement | Renewal |
> |---|---|---|---|
> | AWS | All customer data (hosting) | DPA + SCCs | 2026-12 |
> | Stripe | Card data (not stored by us) | DPA | 2027-03 |
> | Resend | Email addresses, email content | DPA | 2026-06 |
> | Datadog | Metrics, logs (PII scrubbed before send) | DPA | 2026-09 |
> | PostHog | Product analytics events (pseudonymized user IDs) | DPA + EU hosting | 2027-01 |
> | Anthropic | LLM prompts + completions for AI features (no customer-data leaks per privacy policy) | DPA | 2026-11 |

<!-- fill in below -->


---

## Sensitive operation list

Operations Guardian's compliance skill watches for. Each occurrence is logged + reviewable. Distinct from the audit trail list above: audit logging covers a broad range of operations for forensic purposes; this list is the *narrow* set that triggers explicit compliance review.

> **Example**:
> - **User impersonation** (admin-only). Should be rare; every occurrence reviewed weekly.
> - **Bulk data export by an admin** (>1000 records in one operation).
> - **Permission elevation** (granting admin to a non-admin user).
> - **Cross-tenant data access** (should be impossible by design; logged to catch bugs; every occurrence is treated as a P1 incident until investigated).
> - **Manual data deletion** (not driven by a GDPR request).
> - **Schema migration touching PII tables** (Builder-Server runs through `data-engineer` skill; Guardian's compliance skill reviews before merge).

<!-- fill in below -->


---

## Closing checklist before committing

- [ ] Every `> Example` block is replaced with project-specific content.
- [ ] No `<!-- fill in below -->` markers remain.
- [ ] Applicability is honest — not aspirational. If you're "in progress" on SOC2, say so with a date, don't claim completion.
- [ ] Sub-processor list matches reality. Anything missing is a compliance gap waiting to be found in audit.
- [ ] Document has been reviewed by legal counsel (internal or external).
- [ ] If this is your first compliance doc, schedule a follow-up review in 90 days — first-pass compliance docs almost always need revision once the agents start enforcing them in PR reviews.

This doc is regulatory-grade. Treat changes as deliberate — non-trivial edits warrant a legal review before merge.
