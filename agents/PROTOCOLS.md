# Inter-Agent Protocols

Some coordination patterns span two or more agents and deserve a single authoritative definition rather than being half-described in each agent's spec. This document holds those protocols. Each agent's SPEC references the relevant protocol rather than restating it.

Protocols defined here:

1. [API Contract Protocol](#1-api-contract-protocol) — how Builder-Server (producer) and Builder-Client (consumer) coordinate the API boundary.
2. [Sensitive-Paths Protocol](#2-sensitive-paths-protocol) — how Guardian's `sensitive-paths.yml` stays in sync with reality as Builders add new sensitive code.
3. [Product-Marketing Sync Protocol](#3-product-marketing-sync-protocol) — how Strategist and Marketer share continuous thinking (customer signals, positioning, narrative) beyond discrete handoffs.
4. [Product Screenshot Protocol](#4-product-screenshot-protocol) — how Marketer gets product screenshots for content (Builder-Client produces; Marketer consumes from a maintained library).
5. [Linear Labels Protocol](#5-linear-labels-protocol) — the canonical label registry, who adds each label and when, the triage backstop, conflict resolution.
6. [Token / Cost Resilience Protocol](#6-token--cost-resilience-protocol) — how the fleet handles the five distinct "out of tokens" scenarios; spend caps; the session-incomplete marker for resuming interrupted work.

---

## 1. API Contract Protocol

### Principle

**The API contract is the boundary between Builder-Server and Builder-Client.** Builder-Client integrates against the *contract*, never against backend implementation code. This keeps the two agents decoupled: the backend can refactor freely as long as the contract holds, and the frontend can integrate without reading a single line of server code.

The contract is:
- **Designed during planning** — not handed off after the backend is built. Builder-Server is involved from the start (contract-first is the default — see below).
- **A living shared agreement** — it *will* change during development, and the protocol makes those changes visible and acknowledged rather than silent (see "Contract evolution during development").
- **Versioned with a changelog** — both agents always know which version they're building against and how it has evolved.
- Co-owned, with clear roles: Builder-Server proposes the shape, Builder-Client holds a consumability veto, Platform is the tiebreaker.

### Contract form (by stack)

The contract's format depends on the stack chosen in Phase 0. In preference order:

| Stack pattern | Contract artifact | Generation |
|---|---|---|
| REST | OpenAPI 3.x spec (`openapi.yaml` / `openapi.json`) | **Generated from backend code** where possible (e.g. NestJS `@nestjs/swagger` decorators, FastAPI's built-in OpenAPI). Hand-maintained only if generation isn't available. |
| GraphQL | SDL (`schema.graphql`) | Generated from code-first resolvers, or maintained schema-first. Introspection is the runtime source; the committed SDL is the reviewable snapshot. |
| tRPC / typed RPC | Exported TypeScript types from a shared package | Inferred from the router definition. The types *are* the contract. |
| Tightly-coupled TS monorepo | A shared `packages/contracts` (or `packages/api-types`) package both server and client import | Hand-maintained or generated; either way it's the single import both sides use. |

**Rule of thumb: generate the contract from the code when the stack supports it.** A generated contract can't drift from the implementation. A hand-maintained one can, and will.

### Contract location

A known path configured in `.dev-team.yml`, e.g.:

```yaml
# <target-project>/.dev-team.yml
api_contract:
  kind: openapi          # openapi | graphql | trpc | shared-types
  path: contracts/openapi.yaml
  changelog: contracts/CHANGELOG.md       # how the contract has evolved
  generated: true        # true if produced from code; false if hand-maintained
  generate_command: "pnpm gen:openapi"   # how Builder-Server regenerates it
  client_codegen_command: "pnpm gen:api-client"  # how Builder-Client derives types from it
```

Both agents read this config at session start so they know where the contract lives, which version is current, and how to (re)generate / consume it.

**Versioning.** The contract carries a version (e.g. OpenAPI `info.version`, or a top-level marker for other kinds). Every change bumps the version and appends an entry to `contracts/CHANGELOG.md` with: version, date, what changed, classification (additive / breaking), who proposed it, and why. Tickets and PRs reference the contract version they were built against (the contract file's commit SHA is sufficient).

### What "precise" means — contract content requirements

For each operation, the contract must specify:

- **Identity** — method + path (REST), or operation name + type (GraphQL query/mutation/subscription).
- **Auth** — which roles/scopes/permissions are required.
- **Request** — path params, query params, and body schema. Fully typed. No `any`, no untyped `object`, no "see the code."
- **Response** — success schema(s), one per status code (REST) or the return type (GraphQL).
- **Errors** — every error shape the client must handle, with status codes and error-body schemas.
- **Examples** — at least one request example and one response example per operation.
- **Conventions** — pagination, filtering, sorting, idempotency keys, rate limits — documented once and referenced.
- **Stability markers** — `@deprecated` annotations, version, and explicit breaking-change flags.

A contract that says "returns the user object" without defining the user object's shape is **not precise** and Builder-Client will bounce it back.

### Contract design during planning

The contract is designed **during the planning phase, before implementation** — this is the default. Builder-Server is involved from the start, not handed a finished spec to implement later.

```
1. Strategist drafts the PRD. For any feature with an API boundary, the PRD
   is flagged `needs-contract`.

2. Strategist pings @server-agent with a CONTRACT DESIGN request (not an
   implementation request). Builder-Server's `contract-design` skill produces
   a PROPOSED contract — the API shape, fully specified, no implementation.

3. The proposed contract is reviewed in parallel:
   - @client-agent reviews for CONSUMABILITY — is this easy to integrate? Are
     the error cases sufficient? Is pagination/filtering sane for the UI?
   - @platform-agent (architect) reviews for CROSS-SERVICE CONSISTENCY — does
     this fit existing conventions? Any architectural concerns?

4. On agreement, the contract is committed to the known path as a DESIGN
   ARTIFACT (ahead of implementation), tagged v1, with a CHANGELOG entry.

5. Strategist creates the backend ticket (@server-agent) and frontend ticket
   (@client-agent), both referencing contract v1. Neither blocks the other.
```

**Roles during design:**
- **Strategist** owns *what* the API must accomplish (the PRD).
- **Builder-Server** owns the *proposed shape* — it'll implement it, it knows feasibility.
- **Builder-Client** holds a *consumability veto* — it'll consume it, it knows what's painful to integrate.
- **Platform (architect)** is the *tiebreaker* on disagreement and the guardian of cross-service consistency.

### Development flow — contract-first (default)

```
1. Planning produced an agreed contract v1 (see above). Backend and frontend
   tickets both reference it. Neither is blocked by the other.

2. Both agents work in PARALLEL against contract v1:
   - @server-agent implements endpoints to satisfy the contract.
   - @client-agent integrates against the contract, generating client types
     from it and mocking responses until the backend is live.

3. Integration verification: an e2e test (owned by Guardian's QA skill, or a
   Builder owning the feature's e2e) exercises the real endpoint through the
   real client path, confirming both sides meet at the contract.
```

### Development flow — sequential (fallback)

Use only when the API shape is genuinely undiscoverable until implementation — rare, and usually a sign the planning-phase design was rushed.

```
1. @server-agent implements and finalizes the contract during implementation.
2. On merge, @server-agent posts the contract diff to the frontend ticket,
   removing its `blocked-by` marker.
3. @client-agent integrates against the now-final contract.
```

### Contract evolution during development

**The contract will change mid-development.** Builder-Server discovers an endpoint can't be built as designed; Builder-Client finds a missing error case; Strategist updates the PRD. This is normal and expected. The protocol makes changes *visible and acknowledged*, never silent.

When any agent (or human) determines the contract must change:

1. **Propose** — the proposing party posts a **Contract Change Proposal (CCP)** on the feature's shared coordination surface (the Linear epic, or a dedicated contract PR). The CCP states:
   - **What** changes — the precise diff.
   - **Why** — the reason it's needed.
   - **Classification** — *additive* (non-breaking: new optional field, new endpoint, new optional param) or *breaking* (removed/renamed field, changed type, new required param, changed error shape).
   - **Who's affected** — server, client, or both.
   - **In-flight impact** — what already-written code needs rework.

2. **Review** — the affected agent(s) acknowledge or push back within the project's SLA. `@platform-agent` (architect) is the tiebreaker if Builder-Server and Builder-Client disagree.

3. **Apply** — on agreement, the contract artifact is updated, the version bumps (v1 → v2), and a `CHANGELOG.md` entry is added. The change ships as its **own small commit/PR** so it's reviewable in isolation — never buried inside a feature commit.

4. **Re-sync** — both agents are notified "contract is now v2, diff attached." Each re-plans the affected parts of its in-flight work:
   - *Additive change* → usually no rework; the new capability becomes available.
   - *Breaking change* → rework the affected code, re-test, note the rework in the PR.

5. **Record** — the changelog preserves how and why the contract evolved, for reviewers and future sessions.

**Producer responsibilities — Builder-Server**
1. **Participate in contract design during planning** (the `contract-design` skill) — propose the shape before anyone writes code.
2. **Code and contract never diverge.** If implementation forces a contract change, raise a CCP — don't silently change the API surface. A backend PR that alters the contract without a corresponding (agreed) contract update fails Phase 5 self-review.
3. **Prefer generation.** If the stack generates the contract from code, run the generate command and commit the regenerated artifact; the diff is part of the review.
4. **Self-review the contract** — every operation fully specified, examples present, error shapes complete, version bumped, changelog updated.

**Consumer responsibilities — Builder-Client**
1. **Review the contract for consumability during planning** — veto shapes that are painful to integrate *before* implementation starts, when it's cheap to change.
2. **Read the contract, not the code.** Integration context is the contract artifact. Never read backend implementation to infer the API.
3. **Generate client types from the contract** where tooling allows; hand-writing duplicate types is a smell.
4. **Bounce incomplete contracts** and **raise a CCP** when integration reveals a gap, rather than guessing.
5. **Re-plan on contract version bump** — if the contract moves to v2 under an in-flight frontend PR, re-plan the affected parts.

**Guardrails:**
- No silent contract changes. Altering the API surface without a CCP + contract update fails self-review (producer) and gets bounced (consumer).
- Mid-development breaking changes are cheap pre-launch but still require the CCP + acknowledgment — visibility, not silence.
- High contract churn (many CCPs on one feature) is a signal the planning-phase design was too thin. When that happens, Strategist/Platform should pause and re-design rather than churning ticket-by-ticket.

### Breaking-change protocol (post-launch deprecation)

The CCP mechanism above handles *visibility* of breaking changes during development. Once there are **live clients in production**, breaking changes need an additional **deprecation window** on top of the CCP:

1. The CCP is raised and agreed as usual (classification: breaking).
2. Builder-Server marks the old shape `@deprecated` in the contract rather than removing it — old and new coexist.
3. The coordination comment includes a migration plan and a removal target (e.g. "old shape removed in 2 weeks / next minor version").
4. Builder-Client confirms it has migrated all consumers to the new shape.
5. Only then does Builder-Server remove the deprecated shape in a follow-up PR (its own CCP).

**Pre-launch (greenfield, no live clients)** — skip the deprecation window. The CCP + acknowledgment is enough; the old shape can be removed immediately. This is the common case at the start of a new project.

Non-breaking (additive) changes — new optional field, new endpoint, new optional param — only need the CCP's announce + re-sync step. No deprecation dance.

### Integration verification

Whichever agent owns end-to-end tests (Guardian's QA skill, or a Builder owning e2e for the feature) writes an integration test that exercises the real endpoint through the real client code path. This is the proof that producer and consumer actually meet at the contract — not just that each independently believes they conform.

### Why this protocol exists

Without it, the failure mode is predictable and common:
- Builder-Client reads backend code to understand the API → couples to implementation details → breaks when the backend refactors.
- Or Builder-Client guesses the API shape → integration fails at runtime → debugging across two agents' work.

With it, the contract is the single, precise, versioned source of truth at the boundary. Each agent owns its side and meets the other only at the contract.

---

## 2. Sensitive-Paths Protocol

### Principle

Guardian's `sensitive-paths.yml` defines which paths trigger Deep-tier scan on PR open (see Guardian SPEC §4 and the locked decision in [AGENTS.md → Guardian auto-trigger](../AGENTS.md#guardian-auto-trigger--three-tier-path-scan)). The file must stay in sync with reality. As the codebase grows, new sensitive code gets committed at new paths — and if those paths aren't in the file, Guardian will miss-scan high-blast-radius changes.

The file is **owned by Guardian** but every code-writing agent (Builders, Platform) is a **potential contributor**. This protocol ensures additions are proposed visibly when they're noticed, with a backstop for what slips through.

This is the first instance of a broader pattern: *shared state files maintained by one agent but kept in sync by many.* Other instances (Builder-Client's `design-system.md`, Platform's `dependency-graph.md`, etc.) follow the same shape and may get their own protocol sections as the system grows.

### What counts as "sensitive"

A new path is sensitive if it matches any of these pattern families:

| Family | Example patterns |
|---|---|
| Auth / authz | `auth*`, `authentication`, `authorization`, `permissions`, `sessions`, `rbac` |
| Payments / billing | `payment*`, `billing`, `subscription`, `invoice`, `stripe`, `paddle`, `chargebee` |
| Secrets handling | `secret*`, `credentials`, `keys`, `tokens`, `vault` |
| User data / PII | `user*`, `profile`, `identity`, `pii`, code handling `email` / `phone` / `address` / `dob` |
| Migrations | `migration*`, `migrations/`, schema-change files |
| Infra / deploy | `Dockerfile*`, `.github/workflows/`, `*.env*`, IaC dirs (`terraform/`, `pulumi/`, etc.) |
| AI / prompts | `ai/`, `prompts/`, `evals/`, `langchain*`, model-routing code |
| Webhooks / external integrations | `webhooks/`, `oauth*`, payment-callback code |
| Audit logging | `audit*`, compliance log paths |

Projects can extend the family list in `dev-team-state/projects/<project>/guardian/sensitive-pattern-families.md` as their domain demands (e.g. a healthcare product adds `phi*`, `health-records/`).

### Producer responsibilities (Builders + Platform)

In every code-writing agent's **self-review phase** (Builder-Server §4 Phase 5, Builder-Client §4 Phase 5, Platform DevOps mode), the agent self-checks:

1. Did this PR add code at a **new path** (not previously tracked)?
2. Does the new path match any of the sensitive pattern families?
3. Is the path already covered (directly or by glob) in `agents/guardian/sensitive-paths.yml`?

If "yes" to the first two and "no" to the third, the agent posts a **sensitive-path candidate** comment on the PR:

```markdown
🔒 Sensitive-path candidate

This PR adds <type-of-sensitive> code at `<path>` which isn't covered
in Guardian's `sensitive-paths.yml`. Recommend Guardian add it so future
PRs touching this path get Deep-tier scan.

Proposed pattern: `<glob>`
Family: <family-name>

@guardian-agent please review.
```

The agent does **not** modify `dev-team/agents/guardian/sensitive-paths.yml` directly — that violates the blast-radius rule (no code-writing agent edits Guardian's configs). The proposal comment is the handoff.

### Consumer responsibilities (Guardian)

Guardian receives sensitive-path proposals in three ways:

1. **Direct mention** — a producer posts a sensitive-path candidate comment with `@guardian-agent please review`.
2. **Self-detection (PR review)** — Guardian, during its own PR review, notices a new path matching sensitive patterns that producers didn't flag. Guardian raises the proposal itself.
3. **Curator drift report** — the Knowledge Curator skill (Strategist) periodically scans the whole codebase for sensitive patterns not in the file and posts findings (see backstop below).

For each proposal, Guardian:
- **Evaluates** — is this actually sensitive in the way the patterns suggest, or a false positive? (e.g. `auth-marketing-page.tsx` matches the `auth*` pattern but isn't really sensitive — reject.)
- **Accepts**: opens a small PR against the `dev-team` config repo adding the pattern to `sensitive-paths.yml`. The PR is small, focused, reviewable; a human merges it.
- **Rejects**: comments with reasoning. The producer can push back if it has evidence, but the default is to defer to Guardian on this call.

### Knowledge Curator backstop (Strategist)

Strategist's `curator` skill includes `sensitive-paths.yml` in its weekly drift scan:

1. Walk the codebase for paths matching any sensitive pattern family.
2. Cross-reference against the current `sensitive-paths.yml`.
3. For paths matching patterns but not covered: open an issue (or proposal PR) listing them for Guardian to review.

This is the safety net for cases where producers didn't notice + Guardian's per-PR detection also missed (e.g. a path that crept in via a non-agent commit, or a path whose sensitivity only became clear later).

### The file as a living artifact

`sensitive-paths.yml` grows over time. Patterns get **added** as new sensitive areas emerge; they are **rarely removed** (sensitive code usually stays sensitive even after refactor). Each addition carries a brief comment explaining why it was added — for future readers and for audit purposes.

```yaml
# agents/guardian/sensitive-paths.yml
patterns:
  - glob: "server/services/auth/**"
    family: auth
    added: 2026-06-15
    reason: "Auth service module added in ENG-1234 (refactor from monolith)."
  - glob: "server/services/payments/**"
    family: payments
    added: 2026-07-02
    reason: "New payments service; handles Stripe integration."
  # ...
```

### Why this protocol exists

Without it, the failure mode is predictable: Builder-Server adds a payments service at a new path, Guardian reviews subsequent PRs touching that path at Light tier (because the path isn't in the file yet), and a critical auth bypass in payments-adjacent code ships with a shallow scan instead of a deep one. The protocol closes this gap with a lightweight propose-and-curate loop rather than relying on humans to remember.

---

## 3. Product-Marketing Sync Protocol

### Principle

Strategist (the team's **internal voice** — PRDs, status, research, triage) and Marketer (the team's **external voice** — campaigns, content, brand) need to share thinking **continuously**, not only at the discrete handoff moments documented in their specs (a campaign brief, a feature spec, a launch ticket).

Customer signals accumulate. Positioning insights compound. Brand-voice refinements emerge. Testimonials arrive. Roadmap and campaign plans evolve in parallel. If both agents only see each other through discrete tickets, the implicit knowledge each one builds stays trapped in its silo — and the team loses leverage. Strategist's Triage hears "customers love async export"; Marketer should know to lean into that in campaigns. Marketer's benchmarking shows competitors all charge for X; Strategist should know to consider it on the roadmap.

This protocol defines a **shared thought space** — a small set of files both agents read and write, with clear ownership rules, plus a lightweight weekly sync. It is the first instance of a broader pattern (Shared Thought Spaces) that other agent pairs can adopt as their coordination needs surface (Platform↔Strategist for cost-informed roadmap, Guardian↔Builder-Server for security baselines, etc.).

### The shared coordination surface

```
dev-team-state/projects/<project>/_shared/strategist-marketer/
├── customer-signal-log.md          Customer pain/desire signals from any source
├── roadmap-marketing-alignment.md  Upcoming features × planned campaigns
├── testimonial-pipeline.md         Testimonials across their lifecycle stages
├── positioning-insights.md         What we've learned about how we're positioned
├── narrative-themes.md             The high-level story we tell (and how it's evolving)
└── sync-log.md                     Append-only log of cross-agent updates (audit trail)
```

The `_shared/` prefix marks this as a multi-agent surface, distinct from each agent's private state.

### File ownership — primary vs. secondary

Each file has a **primary owner** who curates structure (headings, sections, taxonomies). The **secondary contributor** appends entries, comments, or adds inline observations — but doesn't restructure. This keeps each file coherent (one curator's hand) without locking the other agent out (both can contribute).

| File | Primary owner | Secondary contributor |
|---|---|---|
| `customer-signal-log.md` | **Strategist** (Triage skill) | Marketer adds social-mention signals, email-feedback signals, inbound-from-campaign signals |
| `roadmap-marketing-alignment.md` | **Strategist** (PM skill) | Marketer adds campaign-readiness status per upcoming feature, marketing-driven roadmap requests |
| `testimonial-pipeline.md` | **Marketer** | Strategist (Triage) adds positive customer feedback that should enter the pipeline; flags permission-collection needs |
| `positioning-insights.md` | **Marketer** (Benchmarking skill) | Strategist (BA / Researcher) adds customer-research insights about how customers describe us vs. alternatives |
| `narrative-themes.md` | **Marketer** (Brand Steward skill) | Strategist (PM) adds product-narrative grounding (the themes must reflect product reality) |
| `sync-log.md` | **No single primary** — both append entries | Both contribute equally |

The convention for secondary contributions: append in a clearly-labeled section (`### Appendix — @marketer (2026-11-14)`) or inline comment (`<!-- @strategist: this signal also showed up in ENG-1234 -->`). Never restructure another agent's primary file.

### File contents — minimum schema

Each file follows a lightweight schema so entries are scannable. The primary owner can extend the schema; the secondary contributor follows it.

**`customer-signal-log.md`** — append-only entries:
```markdown
### 2026-11-14 — async export adoption signal
- Source: Triage queue, customer email (ENG-1234)
- Signal: "I exported 50k rows in 30 seconds. Used to take all weekend."
- Theme: speed / unblocking
- Strength: 1 explicit + 3 similar mentions in last 30d
- Routing: Marketer (testimonial-pipeline candidate); PM (capability worth marketing harder)
```

**`roadmap-marketing-alignment.md`** — table of upcoming features × planned campaigns:
```markdown
| Feature | Status | Target ship | Marketing plan | Campaign lead |
|---|---|---|---|---|
| CSV export | feature-complete | 2026-11-14 | Launch campaign (planned) | @marketer-agent ENG-2300 |
| Multi-project dashboards | in-development | Q1 2027 | No campaign yet | TBD |
```

**`testimonial-pipeline.md`** — stages:
```markdown
## Received
- [2026-11-12] Email from <customer>, re: ENG-1234 — "you saved my Saturday"
  Permission: not requested
  Marketing interest: high (speed theme)

## Permission requested
- [2026-11-10] <customer> — request sent, awaiting response

## Approved
- [2026-10-22] <customer> — quote: "..."; approval form: <link>; cleared for: blog / email / social

## Used
- 2026-11-01: <quote> used in blog post "Async export"
- 2026-11-05: <quote> used in LinkedIn launch post
```

**`positioning-insights.md`** — observations + sources:
```markdown
### 2026-11-08 — Async export is our pricing-tier-agnostic differentiator
- Source: Benchmarking 2026-11-08 deep refresh
- Three direct competitors all paywall export behind their highest tier
- Our differentiator: available on Growth+, no row caps
- Used in: ENG-2300 campaign

### 2026-11-12 — Customers describe us as "the operator-first one"
- Source: Strategist BA — review of last 20 sales calls
- Implication: our voice should lean operator-language, not exec-language
- Cross-ref: brand-voice.md
```

**`narrative-themes.md`** — the high-level story:
```markdown
## Active themes (Q4 2026)

### "Stop rebuilding what should already exist"
- The pain we relieve: operators rebuilding reports/data in spreadsheets every week
- Used in: ENG-2300 (CSV export), planned for ENG-2400 (custom dashboards)
- Product grounding: real customer pain captured in customer-signal-log

### "No upsell for basics"
- Differentiator vs. competitors
- Used in: pricing-page revisions, ENG-2300
- Product grounding: pricing tier decisions in ADR-0019
```

**`sync-log.md`** — append-only audit trail of "I noticed your update":
```markdown
### 2026-11-14 — @marketer noted @strategist's signal
- File: customer-signal-log.md
- @strategist added "async export adoption" signal (2026-11-14)
- @marketer action: queued for testimonial pipeline; potential ENG-2300 quote candidate
- Sync session: weekly-2026-11-14
```

### The weekly sync

Both agents run a scheduled **cross-agent-sync** job each Friday afternoon. The job:

1. Reads what the *other* agent contributed to the shared surface this week (diff vs. last-sync-marker).
2. Updates own internal state if the other's contributions are relevant (e.g. Marketer adds a new approved testimonial → Strategist's PM skill knows it's available for the next PRD's customer-evidence section).
3. Appends a brief entry to `sync-log.md` confirming "noted X, took action Y" (or "noted X, no action needed").

This isn't a meeting — it's "be aware of each other," automated. The sync is short (one session, ~5 minutes of agent time), runs at the same cadence in both agents, and produces a visible audit trail.

### Contribution mechanics

**Strategist contributes when:**
- Triage surfaces a customer signal (pain, praise, request) → `customer-signal-log.md`
- Triage surfaces a positive testimonial-candidate → `testimonial-pipeline.md` Received stage
- PM updates the roadmap → `roadmap-marketing-alignment.md`
- BA / Researcher produces an insight about how customers describe us → `positioning-insights.md`
- PM identifies a product-narrative grounding for a campaign theme → `narrative-themes.md` (secondary)

**Marketer contributes when:**
- Inbound social mentions or email-replies show a pattern → `customer-signal-log.md` (secondary)
- A campaign is planned/executed → `roadmap-marketing-alignment.md` (secondary)
- A testimonial moves through stages (permission requested → approved → used) → `testimonial-pipeline.md` (primary)
- Benchmarking reveals a positioning insight → `positioning-insights.md`
- Brand Steward defines or evolves a narrative theme → `narrative-themes.md`

**Both contribute to:** `sync-log.md` (audit trail).

### Conflict resolution

- Within one's own primary file: free to restructure, prune, evolve.
- Within the other agent's primary file: append only; comment with `<!-- @agent-name -->`; never restructure.
- If both want to restructure something owned by the other: raise in `#agents-alerts` for human input. Don't fight in-band.
- The **Knowledge Curator** skill (Strategist) periodically sweeps the shared surface for stale entries (e.g. signals older than 6 months with no follow-up); proposes archival, doesn't auto-archive.

### Why this protocol exists

Without it: Strategist and Marketer talk at handoff moments only. The implicit, accumulated knowledge each one builds stays in its own state files (Strategist's `recent-decisions.md`, Marketer's `brand-voice.md`) and the other never sees it unless explicitly asked. Real coordination happens only at human-initiated transitions, not in the agents' ongoing work.

With it: customer signals from any source flow into a shared log both agents consume. Testimonials follow a visible lifecycle, never used without permission. Roadmap and campaign plans align *before* the launch ticket lands — Marketer is preparing for ENG-1234 when ENG-1234 ships, not learning it shipped. The team gets the leverage of two agents that actually share a brain on the things that matter to both.

---

## 4. Product Screenshot Protocol

### Principle

Marketer needs product screenshots for content — blog hero images, feature demos in emails, social posts, marketing-site captures, ad creatives. **Builder-Client is the producer**: it already has the Claude Preview MCP wired up for visual verification (Phase 4 of its dev cycle), knows the UI deeply, knows the project's design conventions, and knows which states matter. **Marketer is the consumer**: it requests screenshots by surface + state + breakpoint + purpose, and consumes from a maintained library.

This is the same clean producer/consumer shape as the API Contract Protocol — Builder-Client owns the visual production of the app's UI; Marketer consumes that production for content. Marketer never operates the dev server or takes screenshots itself.

### The screenshot library

Persistent location: `<target-project>-marketing/assets/screenshots/` (or as configured in `.dev-team.yml` under `marketing_assets.screenshots_path`).

Structure:

```
assets/screenshots/
├── library/                              Canonical, durable screenshots of major surfaces
│   ├── <surface-slug>/
│   │   ├── 2026-11-01--full--light--1440x900.png
│   │   ├── 2026-11-01--full--dark--1440x900.png
│   │   ├── 2026-11-01--empty--light--1440x900.png
│   │   ├── 2026-11-01--full--light--375x812.png    (mobile breakpoint)
│   │   └── _metadata.yml
│   ├── dashboard/
│   ├── projects-list/
│   ├── csv-export/
│   └── ...
├── campaign-assets/                      Campaign-specific captures (not for general library reuse)
│   └── 2026-11-14-csv-export-launch/
│       └── ...
└── README.md
```

**Naming convention**: `<date>--<state>--<mode>--<breakpoint>.png`
- `date` — ISO date the capture was taken
- `state` — `full` (with realistic demo data), `empty`, `loading`, `error`, plus feature-specific states (e.g. `export-in-progress`, `payment-success`)
- `mode` — `light` / `dark` (skip the suffix if the project has no dark mode)
- `breakpoint` — `1440x900`, `1024x768`, `768x1024`, `375x812`, etc.

**`_metadata.yml`** per surface:

```yaml
surface: dashboard
captured_by: "@client-agent"
last_capture: 2026-11-01
app_version: v2.3.1
data_setup: "demo-data-seeder v1.2 with seed 'marketing-friendly'"
notes: "Hero image candidate; resize to 1200x630 for blog OG"
breakpoints_available: [1440x900, 1024x768, 768x1024, 375x812]
modes_available: [light, dark]
states_available: [full, empty, loading, error]
```

### Producer responsibilities — Builder-Client

1. **Maintain the library** — when shipping UI changes that significantly alter a captured surface (new layout, new state, removed/added components), refresh that surface's screenshots in the same PR or as a follow-up. Old versions are **retained**, not deleted — historical content stays accurate even after the UI evolves.

2. **Use polished demo data, never real customer data.** The project's demo-data seeder (or fixtures) provides realistic-but-fake data that looks good in screenshots. **Real customer data is never in marketing screenshots.** This is non-negotiable — even if the demo seeder isn't set up yet, that's a blocker to resolve, not an excuse to use prod data.

3. **Capture multiple states** — `full`, `empty`, `loading`, `error` — so Marketer has options for the message. (A campaign about reliability may want the loading-state shot; a campaign about scale may want the populated-data shot.)

4. **Capture multiple breakpoints + modes** — so Marketer can match channel needs (1200×630 for blog OG, 1080×1080 for Instagram, etc.). Default breakpoint set is configured per project; baseline is `1440x900`, `768x1024`, `375x812` (web) and dark mode if the project supports it.

5. **Quality bar** — same as for product UI: no debug overlays, no `console.log` artifacts, no broken layouts, no real PII, no out-of-tokens text. Self-reviewed before adding to the library.

6. **On-demand requests** — when Marketer requests a specific screenshot (Linear ticket / `@client-agent screenshot <surface> <state>`), Builder-Client produces it. **SLA: ~2 hours for routine requests** (existing surface, no special data setup); ~24 hours for complex requests (new data setup, new state, new responsive testing). Result posts to the library (general reuse) or campaign-assets folder (campaign-specific) with a comment to the requester citing the path.

7. **Mobile-app screenshots** — The router host (Linux) cannot build iOS (macOS-only). For mobile native screenshots:
   - **Web mobile viewport** (responsive layout at mobile breakpoint, e.g. 375x812): YES, Builder-Client can capture via the dev server + Claude Preview MCP.
   - **Native iOS / Android screenshots**: NO autonomously. Builder-Client produces a creative brief instead, pointing at simulator-based capture (a human runs it) or device capture, with the exact states/data setup needed.

### Consumer responsibilities — Marketer

1. **Read the library first** — for any content needing a screenshot, check `library/<surface>/` for existing assets at the needed breakpoint + state. Reuse where possible; request only when the library doesn't have what's needed.

2. **Request specific screenshots** with all four parameters:
   ```markdown
   @client-agent screenshot request
   - Surface: dashboard
   - State: full (with ≥10 projects, mixed statuses)
   - Mode: light + dark
   - Breakpoint: 1440x900 (primary, for blog OG)
   - Purpose: hero image for ENG-2300 CSV export blog post
   - Deadline: 2026-11-12 EOD
   ```

3. **Match channel requirements** — know which breakpoint + format each channel needs (blog OG 1200×630, LinkedIn 1200×627, X 1600×900, Instagram 1080×1080 / 1080×1350, email banner 600×200, etc.). Library captures are at standard breakpoints; channel-specific resizing/cropping is part of content production — either Marketer does it programmatically (if the channel + tool supports it) or routes to a human via the `creative-brief` skill.

4. **Never use raw library assets in marketing channels** without verifying the data shown is current and on-brand. If the library asset is stale (e.g. shows a feature that was renamed), request a refresh instead of patching in content.

5. **Log screenshot usage** in the campaign's execution log so reviewers can trace which library assets ended up where.

### Privacy & legal

- **No real customer data** in any marketing screenshot. Period.
- For customer testimonials where the customer is depicted using the product (case studies with real customer data shown), that's a separate category requiring explicit written consent from the customer per the testimonial pipeline. Default screenshots never include real data.

### When the demo-data seeder isn't ready

Phase 0 / early-project case: Marketer needs screenshots before a demo-data seeder exists. Resolution:

1. The first screenshot request triggers Builder-Client to establish a minimal demo-data setup (a few projects, a few users, names that look reasonable). This is one-time work; the seeder is reusable afterward.
2. If Builder-Client can't ship a seeder quickly, Builder-Server may be looped in for data fixtures (it owns the data layer).
3. Until a seeder exists, marketing screenshots that need data are blocked — not faked with screenshot-only mockups, because those quickly drift from product reality.

### Storage choice

Default: screenshots are committed to the marketing repo (git, possibly LFS for large libraries). Pros: versioned with content, simple access. Cons: bloats repo if the library grows large.

Upgrade path: when the library exceeds ~500 MB or git operations slow, migrate to a blob storage bucket (S3 / R2 / Cloudinary) with the library structure preserved as URL paths. The transition is mechanical and doesn't change the protocol — only the `screenshots_path` config moves from a local path to a base URL.

### Why this protocol exists

Without it: Marketer has no defined source for screenshots, so it either makes them up (creating mockups that drift from product reality), uses stale dev-server captures it shouldn't have permission to take, or stalls content until a human takes a screenshot manually. Each fails differently — fake screenshots embarrass; stale ones mislead; manual ones bottleneck.

With it: Builder-Client owns visual production end-to-end (own UI + screenshots of own UI); Marketer consumes via a library it can audit and request against; demo-data discipline is enforced at the producer; everything ships with a clean, fast handoff.

---

## 5. Linear Labels Protocol

### Principle

Labels are how skills route, how triage classifies, and how humans understand state at a glance. Without explicit responsibility for **who adds each label and when**, labels drift — tickets are over-labeled, under-labeled, conflicting, or missing the labels their skill-activation triggers depend on. The agent system becomes unreliable.

This protocol defines:
- **The canonical label registry** (every label the agent system uses)
- **Who adds each label and when**
- **The triage backstop** for under-labeled tickets
- **Conflict resolution**
- **One-time setup** (which labels need to pre-exist in the Linear workspace before Phase 2)

Labels are project-scoped in Linear (each workspace has its own set), so the registry below is the **convention** the agent product enforces. Each new target project running through Phase 1 creates these labels in its Linear workspace.

### The canonical label registry

Labels are organized by purpose. Each label has a defined applier and timing.

#### Skill-activation labels (trigger a specific agent skill)

| Label | Activates | Applied by | Timing |
|---|---|---|---|
| `prd` / `spec` | Strategist `pm` skill | Human (via Linear), Strategist `triage` (on classification) | Ticket creation or triage |
| `analysis` | Strategist `ba` skill | Human, Strategist `triage` | Ticket creation or triage |
| `research` | Strategist `researcher` skill | Human, Strategist `triage` | Ticket creation |
| `phase-0` | Strategist `founding` skill | Human (rare; usually invoked via Slack `@mention`) | Project start |
| `triage` | Strategist `triage` skill | Linear auto-applies to unassigned tickets in the Triage view | Ticket creation |
| `architecture` | Platform `architect` skill (for an ADR request) | Any agent or human requesting an ADR | When the architectural question is raised |
| `architecture-design` | Platform `system-design` skill | Human (rare; usually invoked via `@mention` in Phase 3) | Project Phase 3 |
| `infra` | Platform `devops` skill | Any agent or human flagging an infra change | Ticket creation |
| `release` | Platform `release-manager` skill | Cron (scheduled releases), human (on-demand) | Release cadence |
| `campaign` | Marketer `campaign-lead` skill | Human, or Strategist when handing off a launch | Campaign brief |
| `content` | Marketer `content-writer` | Human, Marketer `campaign-lead` (when decomposing) | One-off or campaign breakdown |
| `social` | Marketer `social-community` | Cron, human, Marketer `campaign-lead` | Scheduled or campaign |
| `email` | Marketer `email-lifecycle` | Human, Marketer `campaign-lead` | Campaign or lifecycle setup |
| `growth` | Marketer `growth-analyst` | Human, Marketer (post-campaign) | Analytics request |
| `pr` / `brand` | Marketer `pr-brand-steward` | Human | PR-touching work |
| `ai` / `llm` | Builder-Server `ai-specialist` | Strategist `pm` (when creating impl ticket touching AI), human | PRD decomposition |
| `data` / `pipeline` | Builder-Server `data-engineer` | Strategist `pm`, human | PRD decomposition |
| `needs-design` | Strategist `design-prefill` + Builder-Client `claude-design-prefill` | Strategist `pm` when drafting a UI-touching PRD | At PRD creation |
| `needs-contract` | Builder-Server `contract-design` skill | Strategist `pm` when drafting a PRD with an API surface | At PRD creation |
| `a11y` | Builder-Client `a11y` skill | Human, Guardian (when raising findings) | Audit request |
| `mobile` | Builder-Client `mobile` skill (and area classification) | Strategist `pm`, human | At ticket creation |
| `perf` | Guardian `performance` skill | Human, Guardian (when raising findings), Strategist `triage` (for perf bugs) | Triage or finding |

#### Type / area labels (classification)

| Label | Description | Applied by |
|---|---|---|
| `bug` | Defect — something is broken | Strategist `triage` (always); humans on creation |
| `feature` | New capability | Strategist `pm` (impl tickets), Strategist `triage` |
| `chore` | Maintenance, refactor, dep bump | Creator |
| `documentation` | Doc-only change | Creator, Strategist `curator` (for drift fixes) |
| `backend` | Backend-area work | Strategist `pm`, Strategist `triage` |
| `frontend` | Frontend-area work | Strategist `pm`, Strategist `triage` |
| `mobile` | Mobile-area work *(also activates the Mobile skill)* | Strategist `pm`, Strategist `triage` |
| `infra` | Infra-area work *(also activates DevOps skill)* | Strategist `pm`, Platform, Strategist `triage` |
| `design` | Design-touching work | Strategist `pm`, Strategist `triage` |
| `security` | Security-touching | Guardian (when raising findings), Strategist `triage` |
| `compliance` | Compliance-touching (PII / GDPR / SOC2 / etc.) | Guardian, Strategist `triage` |

Multiple area labels are fine for cross-cutting work (e.g. `backend` + `frontend` for a contract-first feature).

#### Status / process labels

| Label | Description | Applied by | When |
|---|---|---|---|
| `blocker` | Sprint blocker | Any agent or human | When work is stuck |
| `needs-human-review` | Requires human attention before agent proceeds | Any agent | When the agent's confidence is low or decision exceeds its authority |
| `legal-review` | Requires legal review before merge/publish | Guardian `compliance`, Marketer `pr-brand-steward` | When content/code crosses a legal threshold |
| `complex-deploy` | Requires careful deploy planning | Platform `release-manager` | At release prep when deploy is non-routine |
| `breaking-change` | Contract or API breaking change | Builder-Server (during CCP); Platform `architect` (during ADR for an API shape change) | At PR / CCP time |

#### Severity labels (bugs)

| Label | Description | Applied by |
|---|---|---|
| `P0` | Down / data-loss / security exposure / immediate customer impact | Strategist `triage`; Guardian (escalates) |
| `P1` | Major degradation | Strategist `triage`; Guardian |
| `P2` | Minor degradation; users worked around it | Strategist `triage` |
| `P3` | Cosmetic / nice-to-fix | Strategist `triage` |

Every `bug` ticket must carry exactly one severity label after Triage.

#### Workflow labels

| Label | Description | Applied by | When |
|---|---|---|---|
| `mvp` | MVP epic feature ticket | Strategist `founding` skill | Phase 0.6 (creating MVP feature tickets) |
| `agent:strategist-bot` | Attributes a PR/ticket to a specific agent | **The agent applies it** — see the note below | At PR/ticket creation by an agent |
| `agent:server-bot` | (same — one per agent) | The agent | Agent-authored |
| `agent:client-bot` | | The agent | |
| `agent:platform-bot` | | The agent | |
| `agent:guardian-bot` | | The agent | |
| `agent:marketer-bot` | | The agent | |

#### Audit / preservation labels

| Label | Description | Applied by |
|---|---|---|
| `keep-forever` | State entries / docs / findings that should never be archived in routine cleanup | Strategist `curator`, humans |

### Layer 1 — Creator labels at creation

Whoever creates a ticket adds the labels it can confidently apply. This is the first line — the labels are most accurate when applied by the creator who has the most context about what the ticket is for.

**Agent creators**:
- **Strategist `pm`** (creating implementation tickets from a PRD): apply `prd` link via parent, type (`feature` / `bug`), area (`backend` / `frontend` / `mobile`), conditional activators (`needs-contract` if API boundary, `needs-design` if UI work), `ai` / `data` / `mobile` if the work routes to a specific Builder skill
- **Strategist `triage`**: apply `bug` (or other classification), severity (`P0`–`P3`), area, link to duplicates
- **Strategist `founding`** (MVP feature tickets): apply `mvp`, `feature`, milestone label, area hint
- **Platform `architect`** (ADR follow-up impl tickets): apply `architecture` for the ADR ticket itself + relevant area for follow-up impl tickets
- **Platform `devops`** (infra change tickets): apply `infra`
- **Platform `release-manager`**: apply `release`, `complex-deploy` if applicable
- **Builder agents** (follow-up tickets they raise from PR review): inherit area + type + the originating label
- **Guardian** (remediation tickets): apply `security` / `compliance` / `perf` / severity per finding
- **Marketer** (campaign-derived tickets): apply `campaign`, sub-tag (`content` / `social` / `email` / etc.)

**Human creators** (via Linear UI): apply what they remember. Triage backstops the rest.

The agent applies the `agent:<bot>` attribution label itself. NOT automatic: the router only ever READS an `agent:` label (`resolvePrOwner` in routing/classifier.ts, to decide which agent owns a PR's events) and has no code that applies one. The only automatic path is a SessionEnd `git_commit_if_changed` with `create_pr` + `pr_labels`, which applies labels to a PR it opens. An agent that wants the label on a TICKET must set it when it creates the ticket.

### Layer 2 — Strategist `triage` skill is the backstop

Every ticket landing in the Linear Triage view passes through Strategist's `triage` skill. In addition to its existing classify-and-route procedure, the `triage` skill **normalizes labels**:

1. **Required labels for any ticket**:
   - At least one type label (`bug` / `feature` / `chore` / `documentation`)
   - At least one area label if the ticket is code-related (`backend` / `frontend` / `mobile` / `infra` / `design`)
2. **Required for `bug` tickets**: exactly one severity label (`P0` – `P3`)
3. **Recommended**: an activation label matching the work shape (e.g. `prd` if it needs a PRD, `research` if it needs evaluation, etc.)

Triage adds missing labels with a brief comment explaining:
> "🏷️ Triage label normalization: added `feature` + `backend` + `needs-contract`. This ticket touches the API surface so Builder-Server's `contract-design` skill should propose a contract before implementation tickets are created."

Triage **never silently changes** existing labels. If a label looks wrong, it adds a comment proposing the change and tags the appropriate agent or human for confirmation.

### Layer 3 — Mid-flight labels

During work, any agent can add status labels:
- `blocker` when stuck (with a comment explaining)
- `needs-human-review` when confidence is low or the decision exceeds the agent's authority
- `legal-review` when content/code crosses a legal threshold
- `complex-deploy` when release prep reveals deploy risk
- `breaking-change` during a CCP or PR that breaks API consumers

These are always-allowed mutations per the tiered Linear scope. Agents add them when the condition fires; humans add them whenever they want.

### Conflict resolution

When labels conflict, **Triage resolves** (or escalates to a human if the conflict is substantive):

| Conflict | Resolution |
|---|---|
| Both `feature` and `bug` | Triage picks one based on the ticket's content; explains in a comment |
| Multiple severity labels | Triage picks the **highest** (most severe); comments |
| Multiple area labels | **Allowed** — cross-cutting work is real (e.g. `backend` + `frontend` for a contract-first feature) |
| Multiple activation labels | **Usually allowed** (e.g. `prd` + `needs-design` is correct for a UI-touching PRD). Investigate if two mutually-exclusive skills are tagged. |
| `mvp` and a sprint that's past the MVP | Triage flags for human review — the labels suggest the ticket is misfiled |

If Triage genuinely can't decide, it labels `needs-human-review` and waits.

### Project-specific label extensions

Projects can extend the registry via `.dev-team.yml`:

```yaml
# <target-project>/.dev-team.yml

linear_labels:
  custom:
    - name: pii-touch
      description: "Code that touches PII data — Guardian auto-deep-scan in compliance skill"
    - name: fintech-regulatory
      description: "Subject to financial-services regulation — extra compliance review"
    - name: customer-facing
      description: "Customer-visible UI or content — adds Brand Steward review automatically"
```

These get created in the Linear workspace alongside the standard registry during Phase 1 setup. Their meaning is project-specific; agents respect them via skill-specific logic configured per project (e.g. Guardian's compliance skill could be configured to do a deep-scan on every `pii-touch` ticket).

### One-time setup (Phase 1 of the bootstrap)

Before any agent tries to apply a label, the labels must **exist in the Linear workspace**. This is a one-time human task during Phase 1 of the bootstrap (see [PLAN.md](../PLAN.md) → Phase 1).

Setup procedure:
1. Authenticated as a Linear admin, navigate to the workspace's label settings.
2. Create every label in the canonical registry (about 35 labels).
3. Create any custom labels defined in the project's `.dev-team.yml`.
4. Group labels in Linear by category for readability (Linear supports label groups in some plans).
5. Document the workspace's label set in `<target-project>/founding/` (a small `LINEAR.md` is fine) so humans creating tickets manually know what's available.

A future improvement: a small `dev-team/scripts/setup-linear-labels.sh` that calls the Linear API to bulk-create labels from this protocol's registry + the project's custom list. Out of scope for v1.

### Why this protocol exists

Without it, the failure mode is predictable. A human creates a Linear ticket via the UI and forgets to add labels. Strategist's `pm` skill never activates because the `prd` label is missing. The ticket sits unrouted. Or worse: a Builder agent picks it up because it was @mentioned, but does the work without the context the missing labels would have provided (no `needs-contract` flag = no API contract gets designed first).

With it: every ticket has a defined "who labeled this and when" chain. Creators apply what they know. Triage backstops the gaps. The activation triggers work reliably because their labels are reliably present.

---

## 6. Token / Cost Resilience Protocol

### Principle

Agents can be "out of tokens" in five distinct ways. Most resolve automatically via Claude Code's built-in handling. Some require explicit human action. Some require an explicit *resumption* mechanism so interrupted work doesn't fall on the floor.

This protocol documents:
- **The five scenarios** and the responsibility chain for each
- **The cost-cap configuration model** (per agent, per project)
- **The `session-incomplete` marker** for resuming interrupted work
- **Alerting** (via Platform's `finops` skill)

### The five scenarios

| # | Scenario | What happens | Resumption |
|---|---|---|---|
| 1 | **Per-minute / per-hour rate limit (Anthropic 429)** | Claude Code SDK retries with exponential backoff using the `Retry-After` header | ✅ Automatic; no work lost |
| 2 | **Context window exhausted (200K–1M tokens)** | Claude Code auto-compacts older turns. If compaction can't keep up (rare), the next message errors | ✅ Mostly automatic via compaction. Short-session design (per the agent specs) makes this unlikely in practice. |
| 3 | **Per-response output cap (`max_tokens`)** | Response truncates with `stop_reason: max_tokens` | ✅ Claude Code sends a continuation message automatically |
| 4 | **Per-job `max_turns` cap (configured per agent)** | Session terminates mid-task. Committed work is preserved; in-flight uncommitted changes are lost. | ⚠️ **Requires the `session-incomplete` marker** (defined below) for clean resumption on the next webhook event |
| 5 | **Monthly spend cap (configured in `costCap`)** | The router's pre-launch check refuses to spawn a new session for that persona | ⚠️ **Requires human action** — raise the cap, wait for the period to roll over, or accept the agent is paused |

### Cost-cap configuration (in each agent's `settings.json`)

Every agent's `settings.json` carries a `costCap` block:

```json
"costCap": {
  "_comment": "The router's pre-launch check enforces the COST fields. Per-agent, NOT per-project — see the note below the field list.",
  "perJobCostUsd": 5.00,
  "perJobTokens": 500000,
  "monthlyCostUsd": 100.00,
  "monthlyTokensApprox": 8000000,
  "warnAtPercent": 80,
  "alertChannel": "#agents-alerts",
  "onCapReached": "refuse_session",
  "offHoursThrottling": null
}
```

Field meanings:

Every field below is accepted by `settingsSchema.ts`. Only the two **cost** fields are enforced; the rest parse and are then ignored. Marked accordingly so nobody plans around a control that doesn't run.

- **`perJobCostUsd`** — ✅ enforced. `sdkCall.ts` aborts the session once accumulated cost passes it.
- **`monthlyCostUsd`** — ✅ enforced. `checkCostCap` in `runtime/preflight.ts` refuses to spawn when month-to-date + `perJobCostUsd` would exceed it.
- **`perJobTokens` / `monthlyTokensApprox`** — ❌ **not enforced.** Neither name appears outside the schema. Token spend is *recorded* (`cost_ledger`) but never gates anything; the dollar caps are the only ceiling.
- **`warnAtPercent`** — ✅ enforced, by the ROUTER, not by Platform. `runtime/capWarnings.ts` posts to `alertChannel` on first crossing of `warnAtPercent` and of 100%, once per level per month. Platform's `finops` skill reports on utilization; it does not raise these alerts.
- **`alertChannel`** — ✅ Slack channel the two cap alerts above post to.
- **`onCapReached`** — ❌ **not enforced.** The schema accepts `refuse_session | throttle | alert_only`, but `runPreflight` refuses unconditionally on a cap hit whatever the value says. (`queue_until_period_roll`, which this doc previously described, was never even a valid value.)
- **`offHoursThrottling`** — ❌ **not enforced.** Typed `z.unknown()`; nothing reads it. See the off-hours section below.

Caps are **per-agent, fleet-wide** — NOT per-project. `cost_ledger` is keyed `(agent, year, month, day)` with no project column (`state/migrations/000-init.sql`), so one persona working across two projects spends against a single shared ledger. A per-project cap and a `cap-utilization.md` state file were the intent; neither exists. Splitting the ledger by project needs an additive migration plus a project key on the write path.

### Where caps live in the spending hierarchy

Per [AGENTS.md → Multi-project planning](../AGENTS.md#multi-project-planning):

- **Per-persona monthly cap** (this protocol) — hard stop when hit. Intended as per-project; implemented fleet-wide per agent (see above).
- **Global cap per persona** (cross-project — covered in AGENTS.md) — today this and the row above are the SAME number, because the ledger has no project dimension.
- **Per-job cap** (this protocol) — within a single session. Enforced on dollars only.

### The `session-incomplete` marker

When a session terminates mid-task (scenario #4 — hit `max_turns`, or any other mid-task termination signal), the next session needs to know **where to pick up**. Without this, the next webhook event triggers a fresh session that doesn't realize prior work was in flight.

#### Writing the marker (when terminating mid-task)

If the agent senses it's about to terminate (high turn count approaching `max_turns`, context near limit, explicit termination from the router), **before exiting**:

1. **Commit anything that can be safely committed.** Small WIP commits with clear messages (`[ENG-1234] WIP: error handling started, tests pending`) are fine — better than losing work.
2. **Update the relevant state file** (typically `dev-team-state/projects/<project>/<agent>/active-prs.md`) with an `INCOMPLETE NEEDS RESUME` marker:
   ```markdown
   ## ENG-1234 — CSV export
   - Status: implementing (Phase 3) — **INCOMPLETE NEEDS RESUME**
   - Branch: `agent/server-bot/eng-1234-csv-export`
   - Last commit: `abc123` ("add export endpoint base")
   - Last action: 2026-06-04 14:23 UTC — hit max_turns mid-implementation
   - Resume notes: tests not yet written; service file at `server/services/exports/exports.service.ts` needs error-handling per the plan
   - Next steps when resumed:
     1. Complete error-handling per the plan (sections 3.2 of PRD ENG-1234)
     2. Write the unit tests for happy + edge + error paths
     3. Run Phase 4 self-test
     4. Open PR with the plan in the description
   ```
3. **Post a brief Linear / PR comment**: "Session interrupted at <step>; next session will resume from <next-step>. State updated in `active-prs.md`."

#### Reading the marker (when starting a new session)

When the SessionStart hook loads `active-prs.md` and finds an `INCOMPLETE NEEDS RESUME` entry for a ticket being triggered:

1. **Read the Resume notes and Next steps carefully** — these are the resumer's roadmap, not optional context.
2. **Read the branch's existing commits** (`git log <branch>`) to understand what's already done.
3. **Read the PR if one exists** (it has the plan in the description, often updated mid-session).
4. **Continue from the documented next step** — don't re-plan from scratch.
5. **If resume notes are unclear or insufficient**, post a comment on the PR / Linear ticket asking a human to clarify what was in flight. Don't guess.
6. **When the session ends**, update the `active-prs.md` entry — remove the `INCOMPLETE NEEDS RESUME` marker if the task is now complete, or update Resume notes / Next steps if still incomplete.

#### What state files use this marker

Each agent's primary state file:
- Strategist: `dev-team-state/projects/<project>/strategist/active-prds.md` and `founding-discussion.md`
- Builder-Server: `dev-team-state/projects/<project>/builder-server/active-prs.md`
- Builder-Client: `dev-team-state/projects/<project>/builder-client/active-prs.md`
- Platform: `dev-team-state/projects/<project>/platform/active-decisions.md` (for in-flight ADRs)
- Guardian: `dev-team-state/projects/<project>/guardian/active-reviews.md`
- Marketer: `dev-team-state/projects/<project>/marketer/campaigns/<slug>/execution-log.md`

### Alerting (via Platform's `finops` skill)

Platform's `finops` skill monitors per-persona cap utilization and posts to `#agents-alerts` when:

- **Persona reaches 80% of monthly cap** — informational. "@strategist-agent is at 82% of monthly cap with 9 days remaining. Projected month-end: 105%. Suggest reviewing recent expensive sessions or raising the cap."
- **Persona reaches 100% of monthly cap** — actionable. "@strategist-agent has hit its monthly cap for `<project>`. The router is now refusing new sessions for this persona until the period rolls over on `<date>` OR a human raises the cap. To raise: edit `dev-team/agents/strategist/settings.json` → `costCap.monthlyCostUsd`."
- **Per-job cap hit (mid-session)** — urgent. "@server-agent session on ENG-1234 hit per-job cap of $5.00. Session terminated. INCOMPLETE NEEDS RESUME marker written to active-prs.md. Investigate: was this a runaway loop?"
- **Cost anomaly** — investigation. Per the `finops` skill's existing anomaly detection.

### Off-hours throttling (optional)

For non-critical agents (Marketer, Strategist's PjM scheduled jobs, Curator), `offHoursThrottling` can pause activity during off-hours to reduce spend:

```json
"offHoursThrottling": {
  "tz": "America/Los_Angeles",
  "pauseFrom": "20:00",
  "pauseTo": "08:00",
  "pauseWeekends": true,
  "exceptForLabels": ["P0", "P1", "incident"]
}
```

❌ **NOT IMPLEMENTED.** Neither pause windows nor `exceptForLabels` appear in `router/src`, and every agent's `offHoursThrottling` is `null`. Nothing pauses an agent by hour today, so nothing needs a P0/P1 carve-out either. Kept as the intended design — under it, P0/P1 incidents would always run and routine work would wait for morning. The cost controls that DO run are the pre-launch monthly-cap check and the per-job cost cap.

Don't apply off-hours throttling to:
- Guardian (PR review needs to happen as PRs open, not in batches)
- Platform's `incident-response` skill (incidents don't respect business hours)
- Builder-Server / Builder-Client during a release window

### Why this protocol exists

Without it, several failure modes:

- **No `costCap`** → an agent enters a runaway loop on a stuck task and burns hundreds of dollars before a human notices.
- **No `session-incomplete` marker** → a mid-task termination leaves the next session unaware of in-flight work. Either work is duplicated (next session re-plans from scratch and re-implements) or dropped (next event handles a different aspect and the original stays unfinished).
- **No alerting at 80%** → caps are hit abruptly; the agent pauses without warning; humans scramble.

With it:
- Caps catch runaways before significant spend.
- Mid-task terminations resume cleanly.
- Warnings come early enough to take action.
- Spend stays predictable and observable.

---

## 7. Harness Change Protocol

### Why this protocol

The Harness agent is the only one that mutates the `dev-team/` repo — agent prompts, settings, skills, the router, protocols, meta-docs. A bad Harness change cascades to every future session of every other agent. The protocol below captures the discipline that makes Harness's changes safe to review and merge.

It applies to every PR Harness opens. It also applies (by convention) to humans who edit `dev-team/` directly during bootstrap — same standards.

### The PR description template (canonical)

Every Harness PR follows this shape. It's enforced by the `harness` PR template referenced in `agents/harness/settings.json` SessionEnd hook:

```markdown
## Summary
<1-3 lines describing the change>

## Rationale
<the request or observation that triggered this change; link to Slack thread / Linear ticket / session_id if applicable>

## Changes
- <bullet per file modified>

## Cross-impact
<which agents are affected by this change? Any cascading consequences?>

## Test plan
- [ ] <how a human can verify the change works>
- [ ] <regression check>

## Risk
Risk level: Low / Medium / High
<one paragraph on what could go wrong + how to roll back>

## Agents affected
- [ ] strategist
- [ ] platform
- [ ] builder-server
- [ ] builder-client
- [ ] guardian
- [ ] marketer
- [ ] harness (self-modification — extra review needed)
- [ ] router code (deploy required)
```

The `Cross-impact` section is **non-negotiable**. The most common harness mistake is missing a cascading change — a new Linear label that needs to be added to Protocol #5 and routed in multiple identity files; a router-hook command change that requires updates to multiple agents' settings.json; a Critical Behavior added to one agent that should logically apply to others.

### Auto-applied PR labels

The router applies labels at PR-open time based on the diff (per `agents/harness/settings.json` SessionEnd hook):

| Condition | Label | Review implication |
|---|---|---|
| Always | `agent:harness-bot` | Identifies the PR's author |
| Diff touches `agents/harness/**` | `meta-self-modify` | Two-reviewer convention applies |
| Diff touches `router/src/**` | `router-change` | Reviewer also verifies `router/ARCHITECTURE.md` was updated; merge triggers router rebuild + redeploy |
| Diff touches files belonging to 2+ agents | `cross-agent` | Reviewer verifies the Cross-impact section is complete |
| Session activated `misbehavior-debugger` skill | `urgent` | Time-sensitive review; investigate the linked session_id |

### Self-modification discipline

When a PR carries `meta-self-modify`, three additional rules apply:

1. **Two-reviewer convention** — at least two humans approve before merge.
2. **Explicit Summary callout** — the PR description's Summary section must state "This PR modifies the Harness agent itself; please review with extra scrutiny."
3. **Never weaken safety silently** — if the change reduces a constraint (expanding writeScope, removing a denied path, weakening the PR-only enforcement), it must be the entire PR's purpose; rationale must be in the description; Risk marked High.

### Misbehavior-fix discipline

When a PR carries `urgent` (came from `misbehavior-debugger`):

1. **Rationale section must link the originating session_id** with a path to the deep-trace.
2. **Quote the failing log lines verbatim** — the misbehavior is concrete, not inferred.
3. **Test plan must include a regression check** — ideally an actionable test that reproduces the original misbehavior + verifies the fix prevents it.
4. **Append to the misbehavior log** at `dev-team-state/projects/<project>/harness/misbehavior-log.md` in the same session (Harness's SessionEnd does this automatically).

### Router-change discipline

When a PR carries `router-change`:

1. **Code and architecture never diverge** — every router source change must include the corresponding `router/ARCHITECTURE.md` update in the same PR.
2. **Deploy notes are mandatory** — the PR description's Test plan must include the exact deploy command (typically `docker compose up -d --build router` on the VPS) + manual smoke-test steps.
3. **State schema changes need migrations** — additions to SQLite tables go in `router/src/state/migrations/*.sql`, forward-only, applied at startup.

### What's out of scope for Harness (and this protocol)

Even when a human asks, Harness refuses:

- **Modifying Infisical secrets** — humans-only forever.
- **Touching the VPS directly** — SSH, Docker host commands, manual deploys. Out of scope.
- **Modifying target project repos** — Harness's scope is `dev-team/`; the Top 6 work on target projects.
- **Modifying the PR-only enforcement itself** — the three-layer defense (deny list, PreToolUse hook, SessionEnd hook) is the architectural guarantee. Changes to those layers require deliberate human + router-team collaboration outside Harness's normal flow.
- **Auto-merging its own PRs** — humans always merge.

### Why this protocol exists

Without it:
- A PR with a missing `Cross-impact` section ships a change that breaks an agent's routing two days later — humans don't notice until a misbehavior surfaces.
- A self-modification PR silently weakens a Critical Behavior; the next agent run produces a worse output; no one connects the dots.
- A router-change PR ships code that contradicts `router/ARCHITECTURE.md`; future humans inherit the drift and lose the architecture doc as a useful spec.
- A misbehavior-fix PR doesn't include a regression test; the misbehavior recurs in a different form.

With it:
- Every change Harness produces is reviewable end-to-end from the PR description alone.
- Cross-impact bugs surface at review time, not at runtime.
- Self-modifications get the scrutiny they need.
- The architecture doc stays the canonical truth for the router.
- The misbehavior log becomes a pattern library that prevents recurrences.


---

## 8. Fleet Memory Protocol

`dev-team-state` is a git repo checked out beside `dev-team`, mounted read-write into
every session, and pushed to origin by the SessionEnd `git_commit` hook. It is not a
scratch directory — it is the fleet's memory, and the only thing that survives a
session ending.

### The three tiers

| Path | Whose | Committed by |
|---|---|---|
| `shared/` | **everyone's** — process, harness behaviour, external tools, standards, decisions, corrections that cross agents | every agent, and human+Claude sessions through GitHub |
| `global/<agent>/` | one agent's own state, across every project | that agent only |
| `projects/<project>/<agent>/` | one agent's state for one project | that agent only |
| `projects/<project>/_shared/<a>-<b>/` | a documented handoff between two named agents | either of the two |

### Reading it

Every session is given the two index notes — `shared/README.md` and
`shared/process/README.md` — as SessionStart context. They are tables of contents, not
the content: follow a `[[wikilink]]` and `Read` the note you need.

**Check `shared/process/` before re-deriving how the harness, the process, or an
external tool behaves.** Those notes exist because that knowledge was expensive to
obtain and is not recoverable by reading the code — `harness-behavior.md` in particular
is a list of places where a config file appears to say one thing and the runtime does
another. Re-deriving it costs a session and often gets it wrong.

The notes are a **navigable summary; the files their `sources:` block cites are the
truth.** When the two disagree, the source wins and the note is stale — fix the note in
the same session rather than leaving the next reader to hit the same thing.

### Recording to it

Write when a correction **generalises past the thing in front of you**. Not every fix:
a note nobody would act on is cost without benefit.

Where it goes, by kind:

| What you learned | Where it belongs |
|---|---|
| A tactical code pattern a reviewer corrected | that Builder's `projects/<project>/<agent>/coding-practices.md` — the `pr-feedback` skill owns this |
| A correction about the process, the harness, or an external tool | `shared/process/` |
| A coding or design standard adopted deliberately (not learned from review) | `shared/standards/` |
| A decision with architecture consequences | an **ADR** in the target project — Platform owns those; the vault indexes them, it does not hold them |
| Your own working state for a task | `global/<agent>/` or `projects/<project>/<agent>/` |

Every note carries frontmatter: `type`, `updated` (ISO date), `tags`, and `sources` —
repo-relative paths that are the authority for its claims. A note with no `sources` is
an opinion.

### Append-mostly, and why it is a rule rather than a style

Two agents editing the same region of a `shared/` note is the one failure mode this
tier introduces. The state-init sidecar keeps the volume in step with origin by
**rebasing** local commits onto it; a genuine content conflict aborts that rebase, the
commit stays local, and **every later push retries the same rebase and fails
identically** — so the fleet's memory stops leaving the box until a human reconciles it.
An alert (`state_push_failed`) fires, but the repo stays stuck.

So: **add a new dated section rather than rewriting an existing one.** Correct an
existing claim in place only when it is wrong, and keep the edit to the lines that are
wrong. Do not reflow, reorder, or reformat a note you are only adding to.

### Do not

- **Create empty folders or stub notes.** A folder appears when there is something real
  to put in it; an index of empty stubs costs every session tokens and returns nothing.
- **Record what happened.** Record what would change a decision. Session logs are for
  narrative; this is not a log.
- **Write another agent's tier.** `global/<agent>/` and `projects/<p>/<agent>/` belong to
  that agent; each SessionEnd hook only commits its own paths, so a write outside them is
  silently dropped.

### Why this protocol exists

Without it, everything the fleet learns lives in a session transcript nobody reads
again. Two things that actually happened, both verifiable in this repo's history:

- `coding-practices.md` has never been written for either Builder. The rule that
  appends to it lives only in the `pr-feedback` skill file, and until the router began
  delivering skill files to sessions, no session had ever seen it. A place to record
  lessons existed; the instruction to use it did not arrive.
- `shared/` has been committable by all seven agents since the tier was added, and not
  one agent config mentioned it. The write path was open and nothing told anyone the
  vault was there — which is what this protocol and the index injection fix together.
