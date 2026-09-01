---
name: frontend
description: Default skill for web frontend work. Implements UI following the project's stack (loaded from STACK.md), the system overview (SYSTEM.md), and the design system (design-system.md). Design-token discipline is the default — never hardcoded values when tokens exist. Runs the full development cycle from CLAUDE.md, with visual verification in Phase 4 via Claude Preview MCP.
---

# Skill — Frontend (default)

## Activate when

- Any Linear ticket assigned to Builder-Client without a more specific tag (default)
- `@client-agent` mention in PR / issue comments without a specialized tag
- A Phase-0-created feature ticket gets picked up for development with a `frontend` area label
- Triage bug ticket (frontend-area) with reproduction + severity

**Refuse to activate** if `STACK.md` or `SYSTEM.md` is missing — recommend Phase 0 / Phase 3. **Flag** if `design-system.md` is missing — fall back to BRAND.md but encourage humans to populate the design system before substantial UI work compounds inconsistency.

## Specialized knowledge

This skill provides the project-specific knowledge layered on the development cycle (defined in CLAUDE.md §"The development cycle"):

- **The stack**: framework (React with Gatsby / Next.js / Vite / etc.), styling system (Tailwind / styled-components / CSS modules / etc.), state management (Redux / Zustand / RTK / React Query / Jotai / etc.), routing (React Router / Next pages / etc.), data layer (GraphQL via Apollo/urql/relay, or REST with chosen fetching library). Specifics from `<target-project>/founding/STACK.md`.
- **Design-token discipline** — what tokens exist, what their semantic names mean (`bg-surface` vs `bg-primary` vs raw color values). From `design-system.md`.
- **UI kit inventory** — which components exist, their prop conventions, what *not* to re-implement.
- **Component file conventions** — where components live, how they're tested, how stories/docs are written (if Storybook in use).
- **State management patterns** — when to put state in a component vs context vs global store; when to use a query library vs roll your own.
- **GraphQL conventions** — query naming, fragment use, optimistic updates, error handling.
- **Performance basics** — code-splitting points, image optimization, avoiding render thrash.
- **API contract consumption** — reads the contract (OpenAPI / GraphQL SDL / shared types), generates client types from it, integrates against it. Never reverse-engineers the API from backend code. See the [API Contract Protocol](../../PROTOCOLS.md#1-api-contract-protocol) for consumer responsibilities and the `client_codegen_command` from `.dev-team.yml`.

## Procedure

This skill **does not have its own procedure** — it follows the development cycle defined in CLAUDE.md §"The development cycle" (Phases 1–8). What this skill *adds* is project-specific knowledge applied during Phase 3 (Implement) and Phase 4 (Self-test + visual verification).

**During Phase 2 (Plan)**:
- Read `coding-practices.md` (auto-loaded at session start) for tactical patterns the project has accumulated — state management, file structure, composition patterns, anti-patterns. The plan should be consistent with those patterns; if it isn't, flag the deviation in the plan.
- Read `design-system.md` for visual / token / UI-kit decisions. Different file, different scope — both load at session start.
- Apply the **simplest-design** rule (CLAUDE.md Critical Behavior #2). Prefer composing existing UI-kit components over wrapping them; prefer three similar JSX blocks over a premature `<DataDisplay variant="X">`; prefer adding state where it's used over hoisting it to a context just in case. If the plan grew a wrapper or a provider with no current consumer, pause and ask whether it's needed *for this story*.

## Label conventions

When creating follow-up tickets (e.g. from PR-review out-of-scope suggestions), apply labels per the [Linear Labels Protocol](../../PROTOCOLS.md#5-linear-labels-protocol):
- Type (`feature` / `bug` / `chore`)
- Area: `frontend`
- `needs-design` if the follow-up needs a design before implementation
- `a11y` if the follow-up is purely accessibility

## Outputs

- PRs targeting the project's default base branch
- Component files, page files, hooks, GraphQL queries
- Test files (component tests, possibly e2e)
- **Visual verification screenshots** in the PR description (per breakpoint, light + dark)
- Updates to `dev-team-state/projects/<project>/builder-client/design-system.md` when new tokens or components are introduced
- API contract bounce-back comments when contracts are incomplete (per the API Contract Protocol)

## Examples

> **Input** (Linear ticket): "Add a dashboard widget showing the user's last 7 days of activity"
>
> **Plan output** (Phase 2):
> - New `<ActivityWidget>` component using existing `<Card>` from UI kit
> - Fetches via existing `useUserActivity` hook (extend with `last7Days` param)
> - Bar chart using project's chosen viz lib
> - Empty / error / loading states
> - Token usage: `bg-surface`, `text-foreground`, `text-caption`
> - AC-mapped tests: renders with activity, renders empty state, renders error state, fetches with correct params
> - Visual verification: screenshots at 1440 / 768 / 375 in light + dark
>
> **PR output** (Phase 6): branch `agent/client-bot/eng-1234-activity-widget`, 3 commits (component + tests + hook update). PR description with screenshots at every breakpoint, test plan, a11y notes.

## Escalation

- Stuck on a test failure after 3 attempts → draft PR + escalate (per Phase 4 rules).
- Need a UI kit component that doesn't exist → propose adding it; if the team would rather inline, defer to that decision.
- GraphQL/REST schema change required → ping `@server-agent` first; do not write client code against an unmerged schema. If contract-first mode allows parallel work, integrate against the agreed contract with mocks until backend is live.
- Visual mismatch with handoff bundle → post screenshots showing both versions, ask for direction.

## What this skill does NOT do

- Modify backend code (Builder-Server owns the server-side).
- Modify infra files (Platform owns `.github/workflows/`, Dockerfiles, IaC).
- Deploy anything.
- Merge PRs.
- Author or modify founding docs, SYSTEM.md, ADRs.
- Bypass safety: no `--no-verify`, no skipped tests, no force-push to shared branches.
- Hardcode visual values when tokens exist.
