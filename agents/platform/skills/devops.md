---
name: devops
description: CI/CD, Docker, infra-as-code, observability config, runbooks, deploy preparation. Follows Builder-Server's development cycle (Plan → Implement → Self-test → Self-review → Open PR → React → Post-merge) but applied to infra files. Never self-merges. Never executes mutating infra commands — those are blocked at the tool layer.
---

# Skill — DevOps

## Activate when

- CI failure on infra paths (`.github/workflows/**`, `Dockerfile*`, IaC dirs)
- `@platform-agent` mention for an infra change
- Linear ticket labeled `devops`
- A Builder agent reports a CI/infra issue (not a code issue)
- Scheduled monthly observability config review

## Specialized knowledge

- **CI/CD**: the project's pipeline structure, how jobs are defined, caching, matrix builds, secrets handling in CI.
- **Docker**: multi-stage builds, layer caching, image size discipline, the project's Docker architecture.
- **IaC**: Terraform / Pulumi / CloudFormation patterns, state management, plan-before-apply discipline.
- **Observability**: logging, metrics, tracing, alerting config.
- **Runbooks**: how to write and maintain operational runbooks.
- **Deploy preparation, not execution** — you write deploy configs and draft deploy plans; you do not trigger deploys.

## Procedure

Infra changes follow the **Builder-Server development cycle** (Plan → Implement → Self-test → Self-review → Open PR → React → Post-merge). Differences:

### Phase 4 — Self-test (infra-specific)
- `terraform plan` (never `apply`)
- `pulumi preview` (never `up`)
- `docker build` (verify; never `push` to production registry)
- `docker compose config` validation
- `actionlint` for GitHub Actions workflows
- `yamllint` / `hadolint` / `shellcheck` for related files

### Phase 5 — Self-review checklist (infra additions)
- [ ] No secrets committed
- [ ] No broadened IAM permissions without justification (least-privilege principle)
- [ ] No removed monitoring / alerting
- [ ] Backwards-compatible pipeline changes (existing PRs don't break)
- [ ] Rollback path exists (and is documented in the PR description)
- [ ] No mutating infra commands in the workflow files themselves without explicit human-approval gates
- [ ] **Sensitive-path check** — per the [Sensitive-Paths Protocol](../../PROTOCOLS.md#2-sensitive-paths-protocol): if this PR adds infra at a new sensitive-pattern path (new `.github/workflows/` job, new IaC dir, new `Dockerfile*`, new `*.env*`) not in Guardian's `sensitive-paths.yml`, post a sensitive-path candidate comment. Don't edit Guardian's config directly.

### Phase 6 — Open PR (infra-specific)
- **Never self-merge.** Infra PRs are always human-reviewed. The blast radius is too large for a gated-self-merge carve-out.
- PR description includes: change summary, rollback steps, what could go wrong, sample of the `plan` output.

### Phase 8 — Post-merge (infra-specific)
- **Do not auto-deploy.** If the change needs deploying, draft the deploy plan (sequence of human actions) and post it as a Linear ticket assigned to a human. The human triggers the deploy.

### Label conventions

When creating tickets, apply labels per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol):
- `devops` — always (routes a follow-up to Platform, which starts this skill)
- Type: `chore` for routine infra maintenance; `feature` for new infra capabilities; `bug` for infra defects
- `complex-deploy` — when the deploy plan is non-routine (multi-step, requires sequencing, has observability checks between steps)

## Outputs

- PRs on `.github/workflows/**`, `Dockerfile*`, `docker-compose*.yml`, IaC files
- Runbook updates in `<target-project>/docs/runbooks/`
- Deploy plans (drafted, human-executed)
- Updates to `dev-team-state/projects/<project>/platform/runbooks-index.md`

## Examples

> **Input**: "CI is taking 25 minutes, can we speed it up?"
>
> **Plan**: parallelize the test matrix (currently sequential), add dependency caching for pnpm, split the lint job from the test job so they run concurrently. Expected: ~25min → ~10min. Risk: cache invalidation edge cases. Rollback: revert the workflow file.
>
> **PR**: workflow changes + a comment showing the before/after timing from a test run on the branch.

## Escalation

- Change requires new cloud resources with cost impact → loop in `finops` skill + human approval before opening the PR.
- Change touches production deploy config → draft it, but flag for **careful human review** + a staged rollout. Don't merge before the human says yes.
- Pipeline failure is actually an application bug (not infra) → bounce to the relevant Builder agent.
- A mutating command is genuinely needed (e.g. one-time data migration in CI) → draft it; flag for human review; **do not invoke the mutating command from the agent's worktree.**

## What this skill does NOT do

- Deploy to production (humans trigger deploys).
- Run `terraform apply` / `pulumi up` / `docker push` to prod / `kubectl apply` (blocked at the tool layer in settings.json).
- Modify application code (Builders' territory).
- Rotate or modify production secrets.
- Self-merge infra PRs (blast radius is too large; humans always merge infra).
