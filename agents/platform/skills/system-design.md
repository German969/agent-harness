---
name: system-design
description: Author the initial system architecture for a new project. One-time, multi-session, interactive. Reads founding docs, surveys 2-3 candidate architectures with trade-offs, recommends one biased toward simplicity, then produces SYSTEM.md + foundational ADRs. Hands off to Builder-Server for repo scaffolding. Subsequent architecture work goes through the `architect` skill.
---

# Skill — System Design (initial architecture)

## ⚠️ The simplicity principle — the most important thing in this skill

**Choose the simplest thing that could work. Complexity has to earn its place.**

The most common architectural failure is picking a pattern designed for a system 10× larger or 5 years later. A 5-engineer team doesn't need patterns designed for 50. A pre-launch product doesn't need patterns designed for 10M users. **Defer distribution. Defer events-everywhere. Defer abstraction.**

What this means in practice:
- **Modular monolith** is the right answer ~70% of the time for new SaaS products.
- **Microservices** is rarely right at project start; the service seams haven't been discovered yet.
- **Event sourcing / CQRS** earn their place when audit/replay/eventual-consistency wins outweigh the complexity tax — usually only in specific bounded contexts, not the whole system.
- **Hexagonal architecture** earns its place when domain isolation from infra genuinely matters AND the team will maintain the boundary discipline.
- **Layered (n-tier)** is the simplest default; if it works, ship it.

Every pattern you recommend must have a paragraph: "we gain X, we give up Y, what would change our minds is Z." No pattern without that paragraph.

---

## Activate when

- **First-time invocation in Phase 3** of the bootstrap (after Phase 0 founding docs land, before any code exists). SessionStart detects: founding docs present + no `<target-project>/docs/architecture/SYSTEM.md`.
- Explicit human invocation: `@platform-agent design the system architecture` / `@platform-agent kick off architecture design`.
- Linear ticket labeled `system-design`. *Today this routes to Platform but starts `architect`; `@platform-agent design` is what selects this skill (HAR-22).*
- Explicit re-invocation for a major redesign (rare; expensive): `@platform-agent redesign architecture`.

**Do not activate** if founding docs are missing — refuse and recommend `@strategist-agent kick off Phase 0` first. Architecture without product context is unanchored.

**Do not activate** if a SYSTEM.md already exists for this project — refuse and route to the `architect` skill (§5.1) for incremental ADR work instead.

---

## Specialized knowledge — architectural patterns

You know the major patterns, when each is appropriate, and the trade-offs. Use this knowledge to survey candidates and recommend the right fit for THIS project.

### Patterns and when they fit

| Pattern | Good fit when | Avoid when |
|---|---|---|
| **Layered (n-tier)** | Most CRUD products; team < 10; simple data flow | Heavy domain logic that warrants stronger encapsulation |
| **Modular monolith** | Default for most new SaaS; service-shaped boundaries without service-deploy overhead; ~70% of projects | Independent scaling per module is a real near-term need |
| **Microservices** | Team > 30 OR distinct scaling profiles per service OR independent deploy cadence is a real need | Pre-product-market-fit; team < 20; service seams undiscovered |
| **Event-driven** | Audit/replay matters; multiple consumers of the same event; eventual consistency is OK | Strong consistency needed everywhere; small team that will struggle to debug async |
| **CQRS** | Read vs write workloads are wildly different; query optimization for reads matters | Reads and writes look similar; team will conflate models |
| **Event sourcing** | Audit/replay is a product requirement; building financial / regulatory systems | Performance-critical reads; team unfamiliar with the pattern |
| **Hexagonal / ports-and-adapters** | Domain logic is the heart of the product; need to swap infra; team will maintain boundary discipline | CRUD-shaped product; team won't enforce the boundary (it'll degrade to layered) |
| **Pipes & filters** | Stream / data processing; sequential transformations | Branching / non-linear flows |
| **Plugin / kernel** | Extensibility is product-level (third parties extend behavior) | Internal-only features can just be code |
| **Serverless (FaaS)** | Spiky workloads; cold-start acceptable; vendor lock-in tolerable | Steady high-throughput; latency-sensitive; cost-optimization at scale |

### Cross-cutting questions to answer

Every architecture must explicitly answer:

1. **Repo strategy** — monorepo / multi-repo / hybrid? Why?
2. **Deploy unit** — single binary / per-service / functions?
3. **Data ownership** — single shared DB / DB-per-service / mix?
4. **Communication pattern** — HTTP request/response / events / both? Where each?
5. **State management** — stateless services / sticky sessions / distributed state?
6. **Multi-tenancy** — by row / by schema / by DB / not multi-tenant?
7. **Auth pattern** — session-based / JWT / OAuth / sidecar?
8. **Observability** — logs/metrics/traces backend; structured how
9. **API style** — REST / GraphQL / tRPC / gRPC; where each
10. **Frontend architecture** — SPA / SSR / hybrid / islands / static?
11. **Mobile architecture** (if applicable) — RN bridges / native / offline-first?
12. **AI architecture** (if applicable) — where prompts live, where evals live, model routing

### Anti-patterns to resist actively

- "Microservices because everyone else does" — almost always wrong at project start
- Event-driven when CRUD works — debugging async > debugging sync, especially for small teams
- Multi-repo when one would work — the coordination tax compounds
- Premature caching / sharding / distribution — solve the actual bottleneck when it appears
- "Future-proofing" that's really speculation — flexibility costs; design for the next year, not the next decade
- Abstraction layers to avoid hypothetical changes — wait for the change to inform the abstraction
- Choosing patterns by team fashion — pick by product needs

---

## Procedure (multi-session — sessions end and resume between phases)

This skill is **interactive and multi-session**, like Strategist's `founding`. End each session after posting your output. The user's reply re-invokes for the next phase.

### Phase 1 — Read and analyze the foundation

1. Read `<target-project>/founding/PRODUCT.md`. Note:
   - Customer profile (who, scale, expected growth)
   - Core principles (any with architectural implications?)
   - Success metrics (any with performance/scale needs?)
   - Strategic constraints (regulatory, residency, budget — architectural drivers?)
2. Read `<target-project>/founding/STACK.md`. Note:
   - Languages and frameworks already chosen
   - Data stores already chosen
   - Hosting/infra direction
3. Read `<target-project>/founding/COMPLIANCE.md` if present. Note any bars affecting architecture (data residency, audit trail patterns).
4. Capture observations in `dev-team-state/projects/<project>/platform/system-design-discussion.md`.

### Phase 2 — Survey 2–3 candidate architectures

**Don't recommend yet.** Present 2–3 plausible architectures that fit the founding docs. For each:

- One-paragraph description of the shape
- What we'd gain
- What we'd give up
- What would change our minds ("switch off this if" condition)

**Bias toward simplicity in the candidate set itself.** A reasonable candidate set for most new SaaS products:

- **Candidate A** — Modular monolith (often the right answer)
- **Candidate B** — Modular monolith + one dedicated service (when there's one obvious natural seam)
- **Candidate C** — Something more complex (only if founding docs genuinely demand it)

Post the survey in Slack with format:

```
## Architecture survey — 3 candidates for <project>

I've read the founding docs. Three architectures that could fit, with trade-offs:

### A. <name>
<one-paragraph shape>
- Gain: <bullets>
- Give up: <bullets>
- Switch off this if: <condition>

### B. <name>
<one-paragraph shape>
- Gain: <bullets>
- Give up: <bullets>
- Switch off this if: <condition>

### C. <name>
<one-paragraph shape>
- Gain: <bullets>
- Give up: <bullets>
- Switch off this if: <condition>

**My initial lean**: <one>, because <reasoning grounded in founding docs>.

What I want to discuss before I write the recommendation: <one or two specific questions>.
```

**End the session.** Wait for the human.

### Phase 3 — Multi-turn discussion

On re-invocation:
- Engage conversationally
- Push back on premature complexity (see example below)
- Concede when the human has context you don't (regulatory deadline, team experience, planned hires)
- Capture decisions in `system-design-discussion.md`
- Iterate until aligned

**Pushback discipline** — when a human leans toward complexity that the product doesn't justify, push back explicitly:

> "Microservices solve coordination problems for teams that have those problems. With 5 engineers, your coordination problem is in your favor — everyone fits in one head. Modular monolith with strong package boundaries gets you the same logical separation without the deploy/observability/debug tax. **What's driving you toward microservices specifically?** If it's 'we'll need to scale independently' — what's the evidence? If it's 'we'll hire 30 engineers next year' — let's plan to migrate when you actually have 15."

When the human signals "okay, recommend one," move to Phase 4.

### Phase 4 — Recommend and design

1. Pick one architecture (or hybrid). State your confidence.
2. Author `<target-project>/docs/architecture/SYSTEM.md`:

```markdown
# System Architecture — <project>

## Overview
<one-paragraph summary of the chosen architecture>

## Components
<component list with one-line responsibility each>

<ASCII diagram or Mermaid showing how components relate>

## Data flow
<how requests / events / data move through the system; key sequences>

## Boundaries
- **Inside the system**: <list>
- **External**: <vendors, partners, customer-facing surfaces>
- **Trust boundaries**: <where auth/authz lives>

## Patterns chosen and why

### <Pattern 1>
- **Used in**: <where>
- **Why this fits**: <reasoning grounded in PRODUCT.md and STACK.md>
- **Switch off this if**: <condition>

### <Pattern 2>
...

## Cross-cutting concerns
- **Auth**: <approach>
- **Multi-tenancy**: <approach>
- **Observability**: <approach>
- **Configuration**: <approach>
- **Error handling**: <approach>

## Non-goals (what this architecture explicitly is NOT)
- Not <X> because <Y>
- Not <X> because <Y>

## Scaling story
What changes when we hit:
- **10× users** — <what changes>
- **100× users** — <what changes>
- **10× team** — <what changes>

What we'd refactor, what we'd split out, what we'd promote from monolith to service.

## References
- Founding docs: PRODUCT.md, STACK.md
- Foundational ADRs: ADR-0001 through ADR-000N
```

3. Author the foundational ADRs (typically 3–7 ADRs):
   - ADR-0001 — Repo strategy (mono vs multi)
   - ADR-0002 — Deploy unit (monolith vs services vs functions)
   - ADR-0003 — Data store + ownership model
   - ADR-0004 — Communication pattern (HTTP / events / both)
   - ADR-0005 — Multi-tenancy model
   - ADR-000X — Any other foundational decision

Each follows the standard template (Status / Context / Decision / Consequences / Alternatives considered).

4. Post in Slack:
   ```
   SYSTEM.md drafted at <link>. Initial ADRs:
   • ADR-0001 — <title>
   • ADR-0002 — <title>
   ...
   
   Specific places I'd like you to review:
   • <bullet pointing to a section>
   • <bullet>
   
   Reply with edits or "looks good." Once you sign off, I'll hand off to @server-agent for repo scaffolding.
   ```
5. **End the session.** Iterate on feedback. When the human signs off, move to Phase 5.

### Phase 5 — Hand off to Builder-Server for repo scaffolding

1. Open a Linear ticket assigned to `@server-agent`:
   - **Title**: "Scaffold target project repo following SYSTEM.md"
   - **Description**: link to SYSTEM.md, link to each foundational ADR, expected directory structure summary, base CI/CD skeleton expectations
2. Builder-Server reads SYSTEM.md + ADRs, creates the actual directory structure, base config files, initial CI/CD skeleton.
3. Post in `#agents-alerts`: "SYSTEM.md now exists for `<project>`. Other agents' SessionStart hooks will load it from this point forward."
4. Commit `dev-team-state/projects/<project>/platform/system-design-discussion.md` to the state repo as the historical record.

**Phase 5 ends here.** Subsequent architecture decisions go through the `architect` skill for incremental ADRs.

---

## Outputs

- `<target-project>/docs/architecture/SYSTEM.md` — the living architecture overview (every agent loads this at SessionStart)
- `<target-project>/docs/adrs/ADR-0001` through `ADR-000N` — foundational decisions
- `dev-team-state/projects/<project>/platform/system-design-discussion.md` — historical record
- Linear ticket assigned to Builder-Server for repo scaffolding

## Examples

> **Phase 2 survey output** (for a B2B SaaS, 5 engineers, pre-launch, AI-touching product):
>
> "**A. Modular monolith** — single deployable; logical services as packages; one Postgres. Gain: simplest deploy; debug-the-whole-thing in one IDE; refactor freely as seams emerge. Give up: independent scaling per module (premature for our scale anyway). Switch off this if: we have a real near-term need for one module to scale independently — most likely candidate is AI inference workloads.
> 
> **B. Modular monolith + dedicated AI service** — same as A but extract the LLM-touching code into its own deploy unit. Gain: AI workloads have wildly different cost/latency profiles; isolating them lets you scale + cost-optimize separately; if AI vendor lock-in becomes a concern, you have one place to swap. Give up: one service boundary to maintain; one more thing to deploy and observe. Switch off this if: AI is a small share of work and won't grow disproportionately.
> 
> **C. Full microservices** — independent deploys per major capability. Gain: maximum independence. Give up: distributed-systems complexity tax (saga / idempotency / eventual-consistency); deploy overhead; observability complexity. **Strongly don't recommend at your stage** — team of 5; the coordination tax microservices solve is for teams of 30+.
> 
> **My initial lean**: B if AI is core to the product (and PRODUCT.md says it is — 'AI-first underwriting' appears in the hypothesis); A otherwise. 
> 
> **What I want to discuss**: how central is AI to v1, and how soon do you expect AI workloads to dominate inference volume? If AI is a v1.5 thing, I'd start with A and extract the AI service when the load actually justifies it."

## Escalation

- Human disagrees with simplicity bias → engage; don't insist. Surface trade-offs explicitly. If they pick complexity over your recommendation, capture in SYSTEM.md with acknowledgment ("we chose X over the simpler Y because <human's reasoning>"). Don't sulk in the docs.
- Foundational decision spans regulatory territory you can't assess → flag for human + legal review before finalizing.
- Architecture would require infrastructure no one on the team has used → invoke Strategist's `researcher` skill for focused evaluation before deciding. Don't recommend tech the team can't operate.
- Discussion stalls (3+ days no reply) → ping once, then archive as "architecture design paused" and notify on next invocation.

## Cross-agent

- **Reads**: Strategist's Phase 0 outputs (founding docs).
- **Hands off to Builder-Server**: Phase 5 — repo scaffolding ticket with SYSTEM.md + ADRs linked.
- **Notifies other agents**: post in `#agents-alerts` that SYSTEM.md exists. From this point forward, every agent's SessionStart hook loads SYSTEM.md as house-style context (alongside the founding docs).
- **Subsequent architecture work**: goes through the `architect` skill (§5.1) as incremental ADRs.

## What this skill does NOT do

- **Scaffold the actual repo** — Builder-Server does that, following SYSTEM.md.
- **Write code** — no agent does that for Platform.
- **Make per-feature decisions** — those go through PM (Strategist) → architect (Platform) as per-feature ADRs.
- **Re-design existing systems casually** — separate, rare, expensive `@platform-agent redesign architecture` invocation. Major product pivots only.
- **Pick between equally-good options by coin flip** — escalate to human if genuinely 50/50 and high-stakes.
