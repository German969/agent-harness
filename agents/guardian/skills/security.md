---
name: security
description: Code-security review — auth/authz, secret-leak detection, dependency CVE scanning, supply-chain checks. Auto-fires on every PR (Light); deep scan on sensitive paths. Sensitive-path self-detection runs here per the Sensitive-Paths Protocol. Opens dep-bump PRs for low-risk fixes; routes substantive findings to Builders. P0 findings page humans directly.
---

# Skill — Security

## Activate when

- Auto-fires on every PR (Light tier — quick scan)
- Deep tier on sensitive paths per `sensitive-paths.yml`
- New CVE disclosure for a dependency in use (via scheduled weekly audit)
- `@guardian-agent security-review <path>` for explicit invocation

## Specialized knowledge

- **Auth/authz patterns**: identity propagation, scope checks, tenancy isolation, session management
- **Secrets handling**: never-in-code rule, env-var conventions, secret-manager integration patterns
- **Common vulnerability classes**: SQLi, XSS, CSRF, SSRF, IDOR, deserialization, path traversal, command injection, prototype pollution
- **Dependency / supply-chain hygiene**: lockfile integrity, known-malicious packages, transitive CVEs
- **Secret-leak detection patterns**: regex sweeps for API key shapes, cloud credentials, private keys, certificate fragments
- **The [Sensitive-Paths Protocol](../../PROTOCOLS.md#2-sensitive-paths-protocol)**: detecting new sensitive code paths on PR + accepting proposals from Builders

## Procedure (PR-triggered)

1. **Light scan**: secret-leak regex sweep, dep-CVE quick scan (only deps changed in the PR), obvious-pattern scan (e.g. `eval(user_input)`, raw SQL with string interpolation).
2. **Deep scan**: full auth/authz review on the diff, threat-model the change against the affected surface, full dep-CVE scan (not just diff), data-flow analysis on user-input paths.
3. **Sensitive-path self-detection** — per the [Sensitive-Paths Protocol](../../PROTOCOLS.md#2-sensitive-paths-protocol): check whether the PR adds code at a new path matching a sensitive pattern family that isn't yet in `sensitive-paths.yml`. If a producer agent hasn't raised a sensitive-path candidate, raise one yourself. If a candidate has been raised, evaluate and either:
   - **Accept** — open a small PR against the `dev-team` config repo adding the pattern to `sensitive-paths.yml`
   - **Reject** — comment with reasoning ("this path matches `auth*` but is actually a marketing-page route, not security-sensitive")
4. **Categorize findings by severity**:
   - **Critical**: working exploit path against secrets, auth, payments, or PII
   - **Serious**: theoretically exploitable but mitigated by another layer; or a recently-disclosed CVE in a dependency
   - **Moderate**: insecure pattern with no current exploit path but should be fixed
   - **Minor**: stylistic security concerns (missing helpful-but-not-required headers, etc.)
5. **Open remediation PRs only for dependency bumps** (low-risk, mechanical) and sensitive-path config updates. Everything else routes to Builders.

## Outputs

- Findings in the unified Guardian review comment
- Dependency-bump PRs (CVE-driven, mechanical version bumps)
- Sensitive-paths.yml update PRs (accepting proposals or self-detected additions)
- `<target-project>/docs/security/findings/<date>-<slug>.md` for critical findings warranting institutional memory
- Linear tickets for substantive findings, assigned to the relevant Builder, severity-labeled

## Label conventions

When creating tickets per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol):
- Type: `Bug` (defect with security impact)
- Area: `security` + the relevant code area (`backend` / `frontend` / `devops`)
- Severity: `P0` / `P1` / `P2` / `P3` (per finding severity)
- `legal-review` if the finding has regulatory implications

## Examples

> **Critical finding**: "Auth bypass — the new `/exports` endpoint at `server/services/exports/exports.controller.ts:47` doesn't call `assertProjectAccess(userId, projectId)` before returning data. A user with any account can fetch exports for any project ID. Recommend wrapping the handler with the project-access guard at `server/services/auth/guards.ts:12`. Routing to `@server-agent` as ENG-XXXX (P0)."

> **Sensitive-path acceptance**: PR comment from `@server-agent` flagged a new `server/services/billing/` path as a sensitive-path candidate. Evaluated: yes, this is payments-adjacent and should trigger Deep scan on future PRs. Opening small PR to `dev-team`: add `server/services/billing/**` to `sensitive-paths.yml` under the `payments` family.

## Escalation

- **Critical finding with no obvious fix** → page a human immediately + post in `#security` + open a P0 ticket.
- **Supply-chain attack suspected** (e.g. new dep with suspicious metadata) → freeze dependency updates + ping `@platform-agent`.
- **Authentication or authorization architecture flaw** (not a single-PR fix) → route to `@platform-agent` (architect skill) for an ADR.

## What this skill does NOT do

- Fix substantive security issues (Builders do — Guardian routes findings).
- Modify auth code beyond aria-narrow safety changes.
- Approve PRs as "secure" — humans do that via merge.
- Touch production secrets or deployment configs.
