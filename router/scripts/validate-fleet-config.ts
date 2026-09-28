#!/usr/bin/env tsx
//
// Fleet config gate. Agent config is not covered by ci.yml — its paths filter is
// `router/**` — and it reaches production through the git-pull sidecar rather than
// a deploy, so until now NOTHING checked it before it ran.
//
// That is not theoretical. Two defects shipped straight through the gap:
//   - `agent-architect.md` prescribed `model: claude-sonnet-4-7`, which is not a
//     model. An agent onboarded with it would bill at the most expensive rate in
//     the table against its cost cap and be refused at a fraction of its budget.
//   - Both Builders' `<workspace>` hook was set `push: true` against a handler with
//     no push support, so the truncation-durability commit was never pushed.
//
// Checks, in the order a person would ask them:
//   1. Every agent directory loads — settings.json and mcp.json pass their schemas.
//   2. Every hook command has a registered handler (the hook schema is open-shaped
//      on purpose, so a typo validates fine and then silently does nothing),
//      `permissions.ask` is empty — nothing reads it, so an entry there is a tool
//      that is available while the config says it is gated — and every MCP tool in
//      `permissions.allow` names a server the agent's mcp.json declares.
//   3. Every model, including per-skill overrides, is priced by the rate table.
//   4. Identity files parse, and agents and identities correspond 1:1 — an identity
//      with no agent directory routes events to a config that cannot load, and an
//      agent with no identity can never be routed to at all.
//   5. Every skill the router can resolve for an agent has a file. The session is
//      now given its skill's markdown as context, so a mapping that points at a
//      file that is not there delivers no procedure — silently, exactly like the
//      dead hooks and the stub formatter before it.
//   6. BOTH of Guardian's glob registries exist and every entry is well-formed. It is
//      the tier table AGENTS.md, PROTOCOLS.md §2 and Strategist's curator all point
//      at, and a malformed entry reads as coverage that is not there.
//   7. Every agent is told the fleet vault exists. `shared/**` was committable by
//      all seven with no config mentioning it: the write path open, the read path
//      absent. Dropping the index from a load hook would silently restore that,
//      and no test or session would fail.
//   8. The GitHub PR label registry (agents/github-pr-labels.yml) and the agents'
//      create_pr hooks agree in both directions. Whether the labels exist on GitHub
//      needs a token, so that half runs in the github-labels workflow instead.
//   9. The Linear label tables in PROTOCOLS.md §5 are what the generator writes, and
//      agents/linear-labels.yml agrees with the identities and LABEL_SKILLS: every
//      routing label described, no label routed by two agents, every LABEL_SKILLS[agent]
//      key either one of that agent's routing labels or a described modifier (HAR-23),
//      descriptions within Linear's 255 cap, and no agent doc naming a retired label
//      or a label in the wrong case (HAR-24).
//  10. The reverse of 5: every skills/*.md is one the router can select, or is listed
//      in NOT_ROUTER_SELECTED with a reason. Eleven skill files across five agents
//      had no selector, label, intent or default reaching them, most while their
//      docs promised a Linear label did (HAR-22).
//
// Exits non-zero listing every problem found, rather than stopping at the first:
// fixing config one CI run at a time is how a five-minute edit becomes an hour.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentConfig } from '../src/config/agentLoader.js';
import {
  STUB_HANDLERS,
  getSessionHandler,
  getToolCallHandler,
  inferCommand,
} from '../src/hooks/registry.js';
import type { GlobRegistrySpec } from '../src/config/globRegistry.js';
import { validateGlobRegistryFile } from '../src/config/globRegistry.js';
import { loadAgentDocs, loadRoutingFacts } from '../src/config/linearLabelFacts.js';
import { skillReachProblems } from '../src/config/skillReach.js';
import {
  LABELS_PATH,
  PROTOCOLS_PATH,
  crossCheckLinearLabels,
  generatedBlockProblems,
  parseLabelDescriptions,
  renderLabelTables,
  staleLabelMentions,
} from '../src/config/linearLabels.js';
import {
  REGISTRY_PATH,
  crossCheckLabels,
  declaredPrLabels,
  parseLabelRegistry,
} from '../src/config/prLabels.js';
import { loadIdentities } from '../src/routing/loader.js';
import { NOT_ROUTER_SELECTED, resolvableSkills } from '../src/routing/skill.js';
import { auditFleetModels } from '../src/runtime/modelCheck.js';
import { builtinToolsFrom } from '../src/runtime/toolAllowlist.js';
import type { AgentId } from '../src/types.js';

// Not `import.meta.dirname`: that landed in Node 20.11, and CI pins 20.10.0 to match
// deploy/Dockerfile's base image, where it is undefined. fileURLToPath works on both.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const problems: string[] = [];

function listAgentDirs(): AgentId[] {
  const dir = join(repoRoot, 'agents');
  return readdirSync(dir)
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort() as AgentId[];
}

const agents = listAgentDirs();
if (agents.length === 0) problems.push('agents/: no agent directories found');

/**
 * Hooks that are configured but reach no handler, and so do nothing. These are a
 * KNOWN backlog, not an accepted state — several are guards (an explicit-human-
 * command gate on both Builders, a URL gate on Marketer, a deny-pattern re-check on
 * Platform) whose config reads as protection that is not there.
 *
 * Listed here so the gate is a ratchet rather than a wall: the existing set is
 * enumerated and visible, and any NEW dead hook fails CI. Delete an entry when its
 * handler lands — a stale entry here is itself reported below.
 */
const KNOWN_DEAD_HOOKS = new Set<string>([
  // Empty. classify_path_tier — the last entry — was removed rather than
  // implemented: a SessionStart handler runs before the worktree and before
  // secrets, so it could never have had the PR's changed files. See the comment
  // on guardian's replacement `load` hook.
]);

/**
 * Hooks wired to a handler that is a STUB — registered, but it logs and returns
 * without doing the thing. Tracked separately from the no-handler list because the
 * failure looks different from the outside (the hook "resolves") while the effect
 * is identical: the guard or the formatting the config promises does not happen.
 *
 * Empty. It stays a ratchet: a newly stubbed hook fails until it is listed here
 * deliberately, and an entry that stops applying is reported so this shrinks.
 */
const KNOWN_STUBBED_HOOKS = new Set<string>();

// 1 + 2 — configs load, and every hook command actually resolves to a handler.
// The hook schema is open-shaped on purpose (Phase 6b validates per command), so a
// typo passes zod and then silently does nothing.
const TOOL_CALL_PHASES = new Set(['PreToolUse', 'PostToolUse']);
const deadFound = new Set<string>();
const stubbedFound = new Set<string>();
for (const agent of agents) {
  try {
    const config = loadAgentConfig(agent, { devTeamRoot: repoRoot });
    for (const [phase, entries] of Object.entries(config.settings.hooks)) {
      for (const entry of entries as Array<Record<string, unknown>>) {
        const command = inferCommand(entry);
        const id =
          command === undefined
            ? `${agent}/${phase}/shape:${Object.keys(entry)
                .filter((k) => k !== '_comment')
                .sort()
                .join(',')}`
            : `${agent}/${phase}/${command}`;
        const resolved =
          command !== undefined &&
          (TOOL_CALL_PHASES.has(phase)
            ? getToolCallHandler(command) !== undefined
            : getSessionHandler(command) !== undefined);
        if (resolved) {
          if (command === undefined || !STUB_HANDLERS.has(command)) continue;
          stubbedFound.add(id);
          if (KNOWN_STUBBED_HOOKS.has(id)) continue;
          problems.push(
            `${agent}: hooks.${phase} command '${command}' resolves to a STUB handler — it logs and returns without doing the work`,
          );
          continue;
        }

        deadFound.add(id);
        if (KNOWN_DEAD_HOOKS.has(id)) continue;
        problems.push(
          command === undefined
            ? `${agent}: hooks.${phase} entry matches no handler shape — it is a no-op (${id})`
            : `${agent}: hooks.${phase} command '${command}' has no registered handler — it is a no-op`,
        );
      }
    }
  } catch (err) {
    problems.push(`${agent}: ${(err as Error).message}`);
  }
}

// A handler that landed makes its allowlist entry stale. Report it, so the backlog
// shrinks as things are fixed instead of quietly keeping a permanent exemption.
for (const known of KNOWN_DEAD_HOOKS) {
  if (!deadFound.has(known)) {
    problems.push(`KNOWN_DEAD_HOOKS entry '${known}' no longer applies — remove it from the list`);
  }
}
for (const known of KNOWN_STUBBED_HOOKS) {
  if (!stubbedFound.has(known)) {
    problems.push(
      `KNOWN_STUBBED_HOOKS entry '${known}' no longer applies — remove it from the list`,
    );
  }
}

// 2b — `permissions.ask` must stay EMPTY. sdkCall passes only permissions.allow
// (allowedTools) and permissions.deny (disallowedTools); no code anywhere in
// router/src reads `ask`. A tool parked there was never gated behind a human
// prompt — it was simply available and undocumented, which is worse than either
// tier on its own.
//
// This was a note for one release, listing 27 such tools across all seven agents.
// Every one has now been resolved to allow, to deny, or deleted as naming a tool
// or a server that does not exist, so the note becomes a gate: any new entry is by
// construction either a lie about a gate or a tool nobody decided on.
for (const agent of agents) {
  let ask: readonly string[];
  try {
    ask = loadAgentConfig(agent, { devTeamRoot: repoRoot }).settings.permissions.ask ?? [];
  } catch {
    continue; // Already reported above.
  }
  for (const tool of ask) {
    if (tool.startsWith('_')) continue;
    problems.push(
      `${agent}: permissions.ask lists '${tool}', but nothing reads that field — put it in allow (available) or deny (blocked), or leave it out`,
    );
  }
}

// 2c — permissions.allow is now a REAL restriction: it becomes the SDK's `tools`,
// which is the base set of built-ins a session gets. So a tool dropped from an
// allow list is a tool the agent no longer has.
//
// This check lives here rather than only in toolAllowlist.test.ts because of which
// workflow runs when: ci.yml filters on `router/**`, so an edit to
// agents/*/settings.json ALONE never runs the vitest suite — the exact change this
// guards against would have skipped its own guard.
const REQUIRED_BUILTINS = ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'];
for (const agent of agents) {
  let allow: readonly string[];
  try {
    allow = loadAgentConfig(agent, { devTeamRoot: repoRoot }).settings.permissions.allow;
  } catch {
    continue; // Already reported above.
  }
  const tools = builtinToolsFrom(allow);
  if (!tools) {
    problems.push(
      `${agent}: permissions.allow names no built-in tools, so the session would fall back to unrestricted`,
    );
    continue;
  }
  for (const required of REQUIRED_BUILTINS) {
    if (!tools.includes(required)) {
      problems.push(
        `${agent}: permissions.allow does not include '${required}' — with TOOL_ALLOWLIST_ENABLED the agent would not have it`,
      );
    }
  }
}

// 2c — every `mcp__<server>__*` entry in permissions.ALLOW names a server the agent's
//      mcp.json declares. An allow list is a claim about what the agent can do; naming
//      a server that appears nowhere is a claim about a tool that cannot exist.
//
//      A `_` prefix counts as declared. That is the convention this check makes load-
//      bearing: `_`-prefixed servers are skipped by BOTH activeServers() and
//      collectInProcessMcp(), so the prefix already means "planned, currently off" —
//      Guardian's `_linear` and Builder-Client's `_claude-preview` are real capabilities
//      waiting on a secret or a decision, not mistakes. What the check catches is the
//      other case: a permission naming nothing at all.
//
//      DENY is deliberately unchecked. Denying a server this fleet does not have is
//      free insurance for the day it does — `mcp__deploy__*` and `mcp__secrets__*`
//      appear on several agents for exactly that reason.
for (const agent of agents) {
  let cfg: ReturnType<typeof loadAgentConfig>;
  try {
    cfg = loadAgentConfig(agent, { devTeamRoot: repoRoot });
  } catch {
    continue; // already reported by check 1
  }
  const declared = new Set(
    Object.keys(cfg.mcp.mcpServers ?? {}).map((name) =>
      name.replace(/^_+/, '').replace(/-/g, '_').toLowerCase(),
    ),
  );
  for (const rule of cfg.settings.permissions.allow) {
    const match = /^mcp__([A-Za-z0-9_]+?)__/.exec(rule);
    if (!match?.[1]) continue;
    const server = match[1].replace(/-/g, '_').toLowerCase();
    if (!declared.has(server)) {
      problems.push(
        `${agent}: permissions.allow has '${rule}', but no server '${server}' is declared in agents/${agent}/mcp.json — declare it (a '_' prefix means planned-and-off) or drop the entry`,
      );
    }
  }
}

// 3 — every configured model is priced. auditFleetModels logs the detail; we only
// need the count here, and it re-reports agents whose config failed above.
const unpriced = auditFleetModels(agents, repoRoot, {
  warn: (obj, msg) => problems.push(`${JSON.stringify(obj)} ${msg}`),
});
if (unpriced > 0) problems.push(`${unpriced} configured model(s) are not in the rate table`);

// 4 — identities parse, and correspond to agent directories both ways.
const { identities, errors } = loadIdentities(join(repoRoot, 'identities'));
for (const e of errors) problems.push(`identities/${e.file}: ${e.reason}`);
if (identities.length === 0) problems.push('identities/: none loaded');

const agentSet = new Set<string>(agents);
const identitySet = new Set(identities.map((i) => i.agent));
for (const id of identitySet) {
  if (!agentSet.has(id)) problems.push(`identity '${id}' has no agents/${id}/ directory`);
}
for (const agent of agentSet) {
  if (!identitySet.has(agent as AgentId)) {
    problems.push(`agents/${agent}/ has no identities/${agent}.yml — it can never be routed to`);
  }
}

// 5b — where a `create_pr: true` hook actually points. NOT a failure: two of the
//      four are inert by DESIGN, and deciding whether to remove them is a call
//      about each agent's role rather than a config error. Reported because it
//      was invisible — `create_pr` opened no PR at all until it was wired, and
//      even now a hook on a repo the router cannot write never reaches the call.
//
//      Writability comes from deploy/docker-compose.yml's router mounts:
//        dev-team                 :ro          (deliberate — Harness commits via
//                                               the GitHub MCP, see isRepoWritable)
//        <target-project>         read-write
//        dev-team-state           read-write
//        <workspace>              read-write   (the leased worktree)
//        <target-project>-marketing  NOT MOUNTED — no volume exists
const PR_CAPABLE_REPOS = new Set(['<target-project>', 'dev-team-state', '<workspace>']);
const inertPrHooks: string[] = [];
for (const agent of agents) {
  let prConfig: ReturnType<typeof loadAgentConfig>;
  try {
    prConfig = loadAgentConfig(agent, { devTeamRoot: repoRoot });
  } catch {
    continue; // already reported by check 1
  }
  for (const entry of (prConfig.settings.hooks?.SessionEnd ?? []) as Array<
    Record<string, unknown>
  >) {
    if (entry.create_pr !== true) continue;
    const repo = typeof entry.repo === 'string' ? entry.repo : '(no repo)';
    if (!PR_CAPABLE_REPOS.has(repo)) {
      inertPrHooks.push(
        `${agent}: create_pr on repo '${repo}', which the router cannot write — the hook skips before the PR call`,
      );
    }
  }
}
if (inertPrHooks.length > 0) {
  console.warn(
    `note: ${inertPrHooks.length} create_pr hook(s) target a repo this deployment does not mount writable:`,
  );
  for (const entry of inertPrHooks) console.warn(`  - ${entry}`);
}

// 6 — Guardian's TWO glob registries parse and every entry is well-formed.
//     Three separate documents route readers to sensitive-paths.yml (AGENTS.md's tier
//     table, PROTOCOLS.md §2, Strategist's curator backstop) and the file did not exist
//     at all until it was written. perf-sensitive-paths.yml (#54) had the same gap in
//     reverse: four files cite it and nothing validated it.
//
//     A silently malformed entry is the failure that matters in both: the registry
//     still loads, and a deep path reviews light. One shared code path rather than two
//     copies — see src/config/globRegistry.ts for the shape differences it absorbs.
const GLOB_REGISTRIES: Array<{ file: string; spec: GlobRegistrySpec }> = [
  {
    file: 'sensitive-paths.yml',
    spec: {
      label: 'guardian/sensitive-paths.yml',
      taxonomyKey: 'families',
      entryKey: 'family',
      requireSkip: true,
    },
  },
  {
    file: 'perf-sensitive-paths.yml',
    spec: {
      label: 'guardian/perf-sensitive-paths.yml',
      taxonomyKey: 'categories',
      entryKey: 'category',
      // No `skip` list: the perf scan has no equivalent of the tier table's
      // "never deep-review these" set.
      requireSkip: false,
    },
  },
];
for (const { file, spec } of GLOB_REGISTRIES) {
  problems.push(
    ...validateGlobRegistryFile(join(repoRoot, 'agents', 'guardian', file), spec, (p) =>
      readFileSync(p, 'utf-8'),
    ),
  );
}

// 7 — every agent's ALWAYS-ON SessionStart load hook carries the fleet-memory index.
//     Per PROTOCOLS.md §8, `shared/README.md` + `shared/process/README.md` are how an
//     agent learns the vault is there at all. Always-on specifically: behind
//     `only_skills` the cheap conversational sessions — the ones most likely to answer
//     from memory rather than re-derive — would not see it.
const VAULT_INDEX_PATHS = [
  'dev-team-state/shared/README.md',
  'dev-team-state/shared/process/README.md',
];
for (const agent of agents) {
  let vaultConfig: ReturnType<typeof loadAgentConfig>;
  try {
    vaultConfig = loadAgentConfig(agent, { devTeamRoot: repoRoot });
  } catch {
    continue; // already reported by check 1
  }
  const alwaysOnLoadPaths = (vaultConfig.settings.hooks?.SessionStart ?? [])
    .filter((e) => {
      const entry = e as Record<string, unknown>;
      return entry.command === 'load' && entry.only_skills === undefined;
    })
    .flatMap((e) => {
      const paths = (e as { paths?: unknown }).paths;
      return Array.isArray(paths) ? (paths as string[]) : [];
    });
  for (const required of VAULT_INDEX_PATHS) {
    if (!alwaysOnLoadPaths.includes(required)) {
      problems.push(
        `${agent}: no always-on SessionStart load hook carries '${required}' — the agent would never learn the fleet vault exists (PROTOCOLS.md §8)`,
      );
    }
  }
}

// 8 — the PR label registry and the hooks that apply the labels agree (HAR-13).
//     Until HAR-13 six labels were applied by hooks and existed nowhere; the registry
//     is what lets the github-labels workflow create and check them.
{
  const settingsByAgent = new Map<string, unknown>();
  for (const agent of agents) {
    try {
      settingsByAgent.set(
        agent,
        JSON.parse(readFileSync(join(repoRoot, 'agents', agent, 'settings.json'), 'utf-8')),
      );
    } catch {
      // already reported by check 1
    }
  }
  let registryText: string | undefined;
  try {
    registryText = readFileSync(join(repoRoot, REGISTRY_PATH), 'utf-8');
  } catch (err) {
    problems.push(`${REGISTRY_PATH}: could not read — ${(err as Error).message}`);
  }
  if (registryText !== undefined) {
    const { registry, problems: shape } = parseLabelRegistry(registryText);
    problems.push(...shape);
    if (registry) problems.push(...crossCheckLabels(declaredPrLabels(settingsByAgent), registry));
  }
}

// 9 — the Linear label tables in PROTOCOLS.md §5 are generated from the code, and
//     the descriptions file agrees with it (HAR-19). §5 used to be a hand-written
//     "canonical registry" nothing read, and it drifted from the identities. Agent
//     docs may not name a retired label, or a label in the wrong case (HAR-24).
{
  // Identity load errors are already reported by check 4.
  const { facts } = loadRoutingFacts(repoRoot);
  let labelsText: string | undefined;
  try {
    labelsText = readFileSync(join(repoRoot, LABELS_PATH), 'utf-8');
  } catch (err) {
    problems.push(`${LABELS_PATH}: could not read — ${(err as Error).message}`);
  }
  if (labelsText !== undefined) {
    const { descriptions, problems: shape } = parseLabelDescriptions(labelsText);
    problems.push(...shape);
    if (descriptions) {
      problems.push(...crossCheckLinearLabels(descriptions, facts));
      for (const { path, text } of loadAgentDocs(repoRoot)) {
        problems.push(...staleLabelMentions(descriptions, path, text));
      }
      try {
        const doc = readFileSync(join(repoRoot, PROTOCOLS_PATH), 'utf-8');
        problems.push(...generatedBlockProblems(doc, renderLabelTables(descriptions, facts)));
      } catch (err) {
        problems.push(`${PROTOCOLS_PATH}: could not read — ${(err as Error).message}`);
      }
    }
  }
}

// 5 — every skill the router can resolve for an agent has a file to deliver.
//     Before the session was handed its skill's markdown this was cosmetic; now a
//     missing file means the agent runs the trigger with no procedure at all.
for (const agent of agents) {
  for (const skill of resolvableSkills(agent)) {
    const path = join(repoRoot, 'agents', agent, 'skills', `${skill}.md`);
    if (!existsSync(path)) {
      problems.push(
        `${agent}: the router can resolve skill '${skill}' but agents/${agent}/skills/${skill}.md does not exist — that session would run with no procedure`,
      );
    }
  }
}

// 10 — every skill file is one the router can select, or is deliberately not.
for (const agent of agents) {
  const dir = join(repoRoot, 'agents', agent, 'skills');
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.slice(0, -3))
    : [];
  problems.push(
    ...skillReachProblems(agent, files, resolvableSkills(agent), NOT_ROUTER_SELECTED[agent] ?? {}),
  );
}

if (problems.length > 0) {
  console.error(`fleet config invalid — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `fleet config ok — ${agents.length} agents, ${identities.length} identities, all models priced, every allow entry names a declared server, every resolvable skill has a file and every skill file is reachable, every agent sees the vault index, both guardian glob registries well-formed, PR label registry matches the hooks, §5 Linear label tables current`,
);
