# Platform

Platform is the fleet's architect and operator: it owns architecture decisions, CI/CD and
infra, releases, cost, and incident response. It reviews and proposes; it never executes
against production.

This is the first `agents/*/README.md` in the fleet. It exists because Platform's config
and Platform's behaviour have drifted apart in ways that are invisible from either the
SPEC or the settings alone — you have to read both, plus `router/src`, to see it. What
follows is what is actually wired, verified against the code rather than the spec.

## What's in this directory

| File | What it is |
|---|---|
| `CLAUDE.md` | The system prompt. What Platform loads into every session. |
| `SPEC.md` | The design document. Describes the target, not always the present. |
| `settings.json` | Model, caps, permissions, write scope, hooks. |
| `mcp.json` | MCP server declarations. A `_` prefix means declared-but-off. |
| `skills/` | Seven skills, one file each. |

Identity and routing live outside this directory, in `identities/platform.yml`. Scheduled
jobs live in `scheduler/schedules.yml`.

## What actually runs

- **Model** — `claude-sonnet-5`, `max_turns: 40`. `conversational` alone is overridden to
  Haiku; every artifact skill stays on Sonnet deliberately, because architecture is
  judgment under trade-offs.
- **Caps** — $6.00 per job, $80.00/month. Both enforced. The token caps beside them in
  `settings.json` are not — see `agents/PROTOCOLS.md` for which `costCap` fields are real.
- **Live MCP servers** — `linear`, `github`, `slack`. Platform has a real GitHub App
  (`app_id: 123456`) installed on the target project, and real Slack ids.
- **Skill resolution** — one skill per session. The selectors `design`, `adr`, `cost`,
  `release`, `incident` map to `system-design`, `architect`, `finops`, `release-manager`,
  `incident-response`. Any other work trigger lands on `architect`; a bare mention lands
  on `conversational`. SPEC §11 has the full picture.

## Blockers that make Platform's own documented skills unreachable

Two are worth a reader's attention.

**All four cost and monitoring MCPs are `_`-prefixed, so FinOps has no data source and
incident response no telemetry.** `mcp.json` declares `_billing`, `_anthropic_usage`,
`_monitoring` and `_observability`; `settings.json` grants `mcp__billing__read_*`,
`mcp__anthropic_usage__read_*`, `mcp__monitoring__read_*` and
`mcp__observability__query_*`. But a `_` prefix means disabled — `activeServers()` skips
the key on its first line, before the skill filter and before schema validation, and
`collectInProcessMcp()` does the same. Those tools do not exist in a session. `finops`
and `incident-response` are written against data they cannot reach.

The declarations themselves are correct and deliberate: they record what the skills need
and what is blocking it, which is why `validate:fleet` accepts the allow entries. The
work left is picking vendors and wiring the servers, not editing the config. This is the
same fault the vault already records for both Builders and Linear — see
`dev-team-state/shared/process/external-tools.md`.

**`arch-review-paths.yml` was specified in two places and exists in neither.** SPEC §5.1
put it in `agents/platform/`; SPEC §6's project-scoped tree put it in
`dev-team-state/projects/<project>/platform/`. `CLAUDE.md` and `skills/architect.md`
named it with no path at all.

Settled here in favour of §6: path significance is project-specific — what counts as an
architecturally significant path in one codebase is noise in another — and the file sits
naturally beside `dependency-graph.md` and `active-refactors.md`, which Platform already
writes as project state. All four references now agree.

Still not created, deliberately. `identities/platform.yml` sets
`github_auto_triggers: []`, so no PR ever opens Platform, and nothing reads the file.
Creating it now would be a stub with no consumer. It becomes real work the same day the
PR trigger is wired.

## Smaller drift

- `skills/conversational.md` exists on disk, but SPEC §5 stops at 5.6 and never
  describes it. The skill is real and routed to; the SPEC predates it.
- `settings.json` → `writeScope.allowedPaths` documents intent only. Nothing in
  `router/src` reads it. Its own `_comment` says so, and names what does enforce:
  `permissions.deny` and `PreToolUse` hooks.
- The four `platform-*` entries in `scheduler/schedules.yml` are all `enabled: false`,
  which is the fleet-wide default. `finops` and `release-manager` have no automatic
  trigger until someone enables them.
