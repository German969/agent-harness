---
name: compliance
description: GDPR / SOC2 / HIPAA / PCI / regional compliance review. Auto-fires on PRs touching regulated paths (payment/, user/, audit/, anything in compliance-scope.yml). Audit-trail review on operations requiring logging. PII data-handling review. Routes substantive fixes to Builders; legal-impact findings go to humans with the `legal-review` label.
---

# Skill — Compliance / Privacy

## Activate when

- Paths in regulated areas: `**/payment/**`, `**/user/**`, `**/audit/**`, anything matching the project's compliance scope (loaded from `dev-team-state/projects/<project>/guardian/compliance-scope.yml`)
- `@guardian-agent compliance-review <path>` for explicit invocation
- Scheduled **monthly audit** (sweep regulated paths against the baseline)

**Refuse to activate productively** if `<target-project>/founding/COMPLIANCE.md` and `compliance-scope.yml` are both missing — recommend the project author them first. Compliance review without scope definition is shadow-boxing.

## Specialized knowledge

- **The applicable bars** (GDPR, SOC2, HIPAA if relevant, PCI if payments) — loaded from `<target-project>/founding/COMPLIANCE.md` + `compliance-scope.yml`
- **PII patterns**: what counts (email, IP, name, location, etc.), where it can/can't go (logs, analytics, training data, third-party tools)
- **Audit trail requirements**: which operations need logging, what the log must contain (who, what, when, from where), retention policies
- **Data residency / cross-border data flow**
- **Right-to-be-forgotten / data-export discipline**
- **Sub-processor list** (third parties that touch customer data with what data under what agreement)

## Procedure (PR-triggered)

1. **Identify PII-touching code** in the diff (regex sweep + reading affected modules)
2. **Check**: is PII being logged? Going to analytics? Going to an LLM (see also `llm-security`)? Going to a third party?
3. **Check**: are operations on regulated data being audited (audit-log call present)?
4. **For new data flows**, check: is there a corresponding policy doc / consent capture?
5. **Findings ranked by severity** (regulatory exposure):
   - **Critical**: PII leak to a non-compliant destination; missing audit log on a regulated operation that's been live for >X period
   - **Serious**: PII processed by a sub-processor not on the documented list
   - **Moderate**: incomplete audit-log entries (missing actor or correlation ID)
   - **Minor**: documentation drift

## Procedure (monthly audit)

1. Walk regulated paths (per `compliance-scope.yml`)
2. Compare actual code state to the baseline at `dev-team-state/projects/<project>/guardian/compliance-baseline.md`
3. Flag drift: missing audit calls, new PII-touching code without policy documentation, sub-processor additions not in the documented list

## Outputs

- Findings in the unified Guardian review comment (PR mode) or as a monthly audit report (scheduled mode)
- `<target-project>/docs/compliance/audit-trail/<date>-<slug>.md` for substantial findings
- Linear tickets routing fixes to the relevant Builder, severity-labeled
- Updated compliance baseline after material changes

## Label conventions

When creating tickets per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol):
- Type: `bug` (compliance defect) or `feature` (new compliance capability)
- Area: `compliance` + the relevant code area
- `legal-review` (always — compliance findings typically need legal sign-off before remediation merges)
- Severity: based on regulatory exposure (P0 for critical leak; P2 typical)

## Examples

> **Finding**: "GDPR — the new export endpoint at `server/services/exports/exports.controller.ts:42` includes the user's email in the response payload. This is fine (the user is exporting their own data), but the endpoint isn't currently audit-logged. SOC2 requires audit on PII-handling operations. Recommend adding `auditLog.write({...})` per the convention in `server/services/audit/audit.service.ts`. Routing to `@server-agent` as ENG-XXXX (P1, label `legal-review`)."

## Escalation

- **Genuinely uncertain whether a code path is compliant** → flag in the review + ping a human (legal/compliance owner). Don't guess on regulatory questions.
- **Cross-border data transfer detected without a documented flow** → **critical-severity finding** + human escalation. Don't merge until resolved.
- **New sub-processor added** (a Builder PR introduces a SaaS that processes data) → flag for human review; needs to be added to the public sub-processor list per most compliance bars.

## What this skill does NOT do

- Make legal determinations (route to legal/compliance owner — humans).
- Fix substantive compliance issues (Builders do, often with legal input).
- Approve PRs as "compliant" — humans + legal do that.
- Touch the actual compliance documentation (`COMPLIANCE.md` is sacred founding territory).
