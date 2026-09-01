# STACK — Founding Doc

> **This is a TEMPLATE.** Copy it to `<target-project>/founding/STACK.md` (or wherever `.dev-team.yml` → `founding.path` points), fill in every section for your specific project, and commit it to the target repo.
>
> The agents read your filled-out version at the start of every session. Builder-Server and Builder-Client consume it to know how to write code that fits the project's conventions. Platform consumes it for architecture and CI/CD work. Guardian consumes it for test coverage thresholds and quality standards. If this doc is vague, agent-written code will fight the codebase.
>
> **Authoring discipline**: name actual technologies and versions, not categories. "Postgres 17" beats "a relational database." Include negative space — what we *don't* use is as important as what we do.
>
> Examples in this template are from a hypothetical two-sided marketplace SaaS — they're illustrative, not your project content.

---

## Architecture pattern

The big-picture shape of the codebase and deployment. Three orthogonal choices to capture: repo structure (mono vs multi), service shape (monolith vs services vs hybrid), deployment model.

> **Example**: Single git monorepo (pnpm workspaces). Modular monolith on the server side — service-internal boundaries enforced by package boundaries, deployed as one application binary today. Three frontends: marketplace web (Next.js), seller dashboard (Next.js, separate app, same repo), mobile (React Native). Single Postgres database, single Redis. Service boundaries become deploy boundaries only when load forces it.

<!-- fill in below -->


---

## Backend stack

Language, framework, ORM/data layer, validation layer, background jobs, notifications, logging/tracing, key libraries. Name versions for anything load-bearing.

> **Example**:
> - Language: TypeScript 5.4
> - Runtime: Node 22
> - Framework: NestJS 11 (modular, OpenAPI-friendly, decorator-driven)
> - ORM: Prisma 6.x for the typed Postgres layer; raw SQL via Prisma's `$queryRaw` where Prisma's query builder is the wrong tool
> - Validation: Zod 4 — every API input parses through a Zod schema before it touches business logic
> - Background jobs: pg-boss (PostgreSQL-backed queue — no Redis-as-queue, Redis is cache only)
> - Notifications: Resend for transactional email; Twilio for SMS
> - Logging: Pino + structured JSON; ingested by Datadog
> - Tracing: OpenTelemetry → Datadog
> - Key libraries: date-fns (no Moment), got (no axios), uuid v7 (sortable), p-limit

<!-- fill in below -->


---

## Frontend stack — web

Framework, styling system, state management, data-fetching, routing, auth, internationalization, key libraries.

> **Example**:
> - Framework: Next.js 16 (App Router)
> - Styling: Tailwind CSS 4 with project design tokens (see `client/src/styles/tokens.css`); no inline styles for visual properties; no styled-components
> - State management: Zustand for cross-component state; React Query for server state. No Redux.
> - Forms: React Hook Form + Zod (same Zod schemas the backend uses, imported from a shared `packages/contracts` workspace)
> - Routing: file-based per Next App Router; protected routes via `middleware.ts`
> - Auth: NextAuth.js (custom credentials provider; sessions in Postgres)
> - Internationalization: next-intl, dynamic locale loading
> - Key libraries: @tanstack/react-query, lucide-react (icons), cmdk (command menu)

<!-- fill in below -->


---

## Mobile stack

React Native vs native vs none. Key libraries. Explicitly write "N/A — web only" if mobile isn't in scope.

> **Example**:
> - Framework: React Native 0.78, Expo SDK 53 (managed workflow)
> - Navigation: Expo Router (file-based)
> - State: Zustand + React Query (same as web; Zustand stores in a shared `packages/state` workspace where reasonable)
> - Styling: NativeWind (Tailwind for RN)
> - Storage: MMKV for fast key-value; SQLite via Expo SQLite for offline data
> - Build: EAS Build (Expo) for both platforms; native modules avoided unless required
> - Distribution: TestFlight (iOS), Internal Testing (Android Play Console) for staging; App Store + Play Store for prod

<!-- fill in below -->


---

## Data stores

Primary DB, cache, queue, search, time-series, blob. Only list the ones you actually use — over-listing creates confusion about which is canonical for what.

> **Example**:
> - Primary DB: PostgreSQL 17 (managed by Supabase or RDS — TBD per env)
> - Cache: Redis 7 (managed; ElastiCache or Upstash)
> - Search: Postgres `tsvector` for v1; promote to Typesense if Postgres FTS becomes inadequate
> - Time-series: not used in v1
> - Blob: S3-compatible (Cloudflare R2 — pricing wins over S3 for our volume)
> - Queue: pg-boss table inside the primary DB (no separate broker)

<!-- fill in below -->


---

## Hosting / infra

Cloud provider, container platform, CDN, IaC tool, secrets management, observability stack.

> **Example**:
> - Cloud: AWS (us-east-1 primary, eu-west-1 secondary for data-residency customers)
> - Compute: ECS Fargate (containers; no servers to patch)
> - CDN: Cloudflare in front of everything (cache + DDoS + WAF)
> - DNS: Cloudflare DNS
> - IaC: Terraform (state in S3, locked via DynamoDB)
> - Secrets: AWS Secrets Manager; rotated quarterly minimum
> - Observability: Datadog (APM + logs + metrics + RUM)

<!-- fill in below -->


---

## CI / CD

Provider, pipeline shape, deploy targets, base branch, branch protection rules. The agents (especially Platform's DevOps skill) consume this directly.

> **Example**:
> - Provider: GitHub Actions
> - Pipeline shape: PR → lint + type-check + unit + integration tests + (selective) e2e → preview deploy (Vercel for web, EAS for mobile) → on merge to `staging`, deploy to staging; promotion to `main` is manual after staging soak
> - Deploy targets: ECS Fargate (server), Vercel (web), EAS / TestFlight / Play (mobile)
> - **Base branch for PRs**: `staging` (NOT `main`)
> - Branch protection: required reviews on `main` (2 reviewers) and `staging` (1 reviewer); no direct pushes; all checks must pass

<!-- fill in below -->


---

## Conventions

File / class / branch / commit naming. Error-handling style. Testing strategy and coverage thresholds. PR template structure. These are the rules Builder agents follow on every commit and PR.

> **Example**:
> 
> - **File naming**: kebab-case for files (`user-profile.tsx`), PascalCase for React components (`UserProfile`), camelCase for functions. NestJS modules follow `<feature>.module.ts`, `<feature>.controller.ts`, `<feature>.service.ts`.
> - **Branch naming**: `<jira-ticket-id>-<short-slug>`, e.g. `MKT-1234-add-csv-export`. Agent-authored branches use `agent/<agent-name>/<ticket-id>-<slug>`, e.g. `agent/server-bot/MKT-1234-csv-export`.
> - **Commit messages**: `[<TICKET-ID>] <imperative summary>`, e.g. `[MKT-1234] add CSV export endpoint`. Body when justified.
> - **PR titles**: same format as commits.
> - **Error handling**: never swallow errors silently. Log + re-throw or log + return a typed error. No naked `catch (e) {}`.
> - **Testing strategy**: unit (Jest, every service file), integration (Jest + Pactum for API), e2e (Playwright, critical user flows only).
> - **Coverage thresholds**: 80% line, 100% on new code in the changed surfaces. Guardian's QA skill enforces.
> - **PR template**: `.github/pull_request_template.md` enforces Summary / Test Plan / Risk / Rollback sections. PRs without these get bounced.

<!-- fill in below -->


---

## Domain naming map

UI ↔ backend term mapping when they intentionally differ. Empty if UI and backend match exactly — just write "Names match across UI and backend; no mapping needed."

> **Example**:
> 
> | Backend entity | UI label |
> |---|---|
> | `Account` | "Vendor" (seller-side) / "Customer" (buyer-side) |
> | `Order` | "Order" (buyer-side) / "Sale" (vendor-side) |
> | `Listing` | "Product" |
> 
> Naming-aware places that consume this map: Strategist PM skill (PRD language), Marketer Content Writer (external-facing names), all Builders (code uses backend names; UI text uses UI labels).

<!-- fill in below -->


---

## Non-negotiable rules

Rules the agents enforce on every PR. Specific enough to be checkable. Loaded into Builder agents' self-review checklists.

> **Example**:
> - No `any` types in TypeScript without an inline explanation comment.
> - No hardcoded values when a token / config / constant exists.
> - No direct DB queries from controllers; everything goes through a service.
> - No PR merges without Guardian-green (QA + Security + Compliance scans pass).
> - No `--no-verify` to bypass commit hooks. Ever.
> - No `console.log` left in code. Use the logger.
> - No `git push --force` on shared branches (only on agent-owned `agent/*` branches).
> - No skipping tests to make CI pass.

<!-- fill in below -->


---

## Out of scope (yet)

Tech-stack decisions we explicitly aren't making in the first horizon. Same purpose as PRODUCT.md's scope section — prevents drift and tells agents what to push back on.

> **Example**:
> - Microservices split — single deployable until load proves otherwise.
> - GraphQL — REST only for v1.
> - Native mobile apps — React Native covers both iOS and Android.
> - Multi-region writes — single-region writes, multi-region reads only.
> - Custom data warehouse — analytics goes to PostHog + Snowflake (managed) v1.
> - Self-hosted everything — managed services across the board until cost forces a re-evaluation.

<!-- fill in below -->


---

## Closing checklist before committing

- [ ] Every `> Example` block is replaced with project-specific content.
- [ ] No `<!-- fill in below -->` markers remain.
- [ ] Every section names *actual technologies and versions*, not categories.
- [ ] Conventions are specific enough that an agent's self-review can mechanically check them.
- [ ] "Out of scope" lists at least 3 explicit deferrals — prevents the agents from drifting into open-ended technology choices.
- [ ] Document is human-reviewed by a senior engineer who's lived with the stack.

This doc is the most reference-y of the founding docs and the most likely to drift as the codebase evolves. Knowledge Curator (Strategist) periodically checks it against the actual codebase. When you change the stack materially (new framework, new data store, dropped tool), update this file in the same PR.
