// The Linear label registry (agents/linear-labels.yml) and the generated table in
// agents/PROTOCOLS.md §5 (HAR-19).
//
// §5 used to call itself "the canonical label registry" while nothing read it. The
// router's label → agent map comes only from `routing.linear_labels` in
// identities/*.yml, and the label → skill map only from LABEL_SKILLS (keyed by
// agent since HAR-23). §5 had
// drifted from both: seven labels under names that never routed, eleven routing
// labels missing, and ones that exist nowhere. A second copy nothing checks
// is a second copy that drifts.
//
// So §5's table is now generated from the code, with only the descriptions taken
// from the sidecar, and validate:fleet fails when the committed table is not what
// the generator would write. Owner decision on HAR-8: descriptions live in a
// separate file, not an identity field.
//
// Lives in src/ because tsconfig and biome do not cover scripts/.

import { load } from 'js-yaml';

export const LABELS_PATH = 'agents/linear-labels.yml';
export const PROTOCOLS_PATH = 'agents/PROTOCOLS.md';
export const BEGIN_MARKER =
  '<!-- BEGIN GENERATED: linear-labels. Edit agents/linear-labels.yml or identities/*.yml, then run `pnpm labels:protocols`. -->';
export const END_MARKER = '<!-- END GENERATED: linear-labels -->';

/** Linear rejects a label description over 255 characters. */
export const MAX_DESCRIPTION = 255;

export type LabelDescriptions = {
  routing: Map<string, string>;
  modifiers: Map<string, string>;
  conventions: Map<string, string>;
};

/** What the generator needs from the router, injected so tests can supply fakes. */
export type RoutingFacts = {
  /** agent → its routing.linear_labels, in identity-file order. */
  declared: ReadonlyMap<string, readonly string[]>;
  /** agent → (Linear label → skill): LABEL_SKILLS, which is keyed by agent. */
  labelSkills: ReadonlyMap<string, ReadonlyMap<string, string>>;
  workDefaultSkill: (agent: string) => string;
};

const SECTIONS = ['routing', 'modifiers', 'conventions'] as const;

/** Parse and shape-check the sidecar. `descriptions` is undefined when unusable. */
export function parseLabelDescriptions(text: string): {
  descriptions?: LabelDescriptions;
  problems: string[];
} {
  const problems: string[] = [];
  const at = (msg: string) => problems.push(`${LABELS_PATH}: ${msg}`);
  let doc: unknown;
  try {
    doc = load(text);
  } catch (err) {
    return { problems: [`${LABELS_PATH}: could not parse — ${(err as Error).message}`] };
  }
  if (!isRecord(doc)) return { problems: [`${LABELS_PATH}: top level must be a mapping`] };
  for (const key of Object.keys(doc)) {
    if (key !== 'version' && !(SECTIONS as readonly string[]).includes(key)) {
      at(`unknown top-level key \`${key}\``);
    }
  }
  if (doc.version !== 1) at('`version` must be 1');

  const out = {} as LabelDescriptions;
  const seen = new Map<string, string>();
  for (const section of SECTIONS) {
    const raw = doc[section];
    const map = new Map<string, string>();
    out[section] = map;
    if (raw === undefined) {
      at(`\`${section}\` is missing`);
      continue;
    }
    if (!isRecord(raw)) {
      at(`\`${section}\` must be a mapping of label → description`);
      continue;
    }
    for (const [label, description] of Object.entries(raw)) {
      const where = `${section} '${label}'`;
      if (seen.has(label))
        at(`'${label}' is listed under both \`${seen.get(label)}\` and \`${section}\``);
      seen.set(label, section);
      if (typeof description !== 'string' || description.trim() === '') {
        at(`${where} has no description`);
        continue;
      }
      if (description.length > MAX_DESCRIPTION) {
        at(
          `${where} description is ${description.length} characters; Linear rejects more than ${MAX_DESCRIPTION}`,
        );
      }
      map.set(label, description.trim());
    }
  }
  return { descriptions: out, problems };
}

/** The label → agent map as the router builds it, plus every collision. */
export function routingMap(declared: ReadonlyMap<string, readonly string[]>): {
  byLabel: Map<string, string>;
  collisions: string[];
} {
  const owners = new Map<string, string[]>();
  for (const [agent, labels] of declared) {
    for (const label of labels) owners.set(label, [...(owners.get(label) ?? []), agent]);
  }
  const byLabel = new Map<string, string>();
  const collisions: string[] = [];
  for (const [label, agents] of owners) {
    const distinct = [...new Set(agents)];
    if (distinct.length > 1) {
      collisions.push(
        `routing label '${label}' is declared by ${distinct.join(' and ')}. The router gives it to whichever identity file loads first, and readdir order is not something to route on; keep it in one`,
      );
    }
    byLabel.set(label, agents[0] as string);
  }
  return { byLabel, collisions };
}

/** Every problem between the sidecar, the identities and LABEL_SKILLS. */
export function crossCheckLinearLabels(d: LabelDescriptions, facts: RoutingFacts): string[] {
  const problems: string[] = [];
  const { byLabel, collisions } = routingMap(facts.declared);
  problems.push(...collisions);

  for (const [label, agent] of byLabel) {
    if (!d.routing.has(label)) {
      problems.push(
        `${agent}: routes on Linear label '${label}', which ${LABELS_PATH} → routing does not describe`,
      );
    }
  }
  for (const label of d.routing.keys()) {
    if (!byLabel.has(label)) {
      problems.push(
        `${LABELS_PATH}: routing label '${label}' is declared by no identity — it routes nowhere`,
      );
    }
  }

  // LABEL_SKILLS is keyed by agent (HAR-23). An entry fires only on a ticket routed
  // to that agent, so its key must be one of that agent's own routing labels or a
  // modifier that routes nowhere. A key another agent routes on is dead at best,
  // and a label another agent owns picking this agent's skill is the ambiguity the
  // per-agent keying removed. Whether each skill has a file is check 5's job:
  // resolvableSkills includes these values.
  const modifierAgents = new Map<string, string[]>();
  for (const [agent, skills] of facts.labelSkills) {
    for (const [label, skill] of skills) {
      const router = byLabel.get(label);
      if (router === undefined) {
        modifierAgents.set(label, [...(modifierAgents.get(label) ?? []), agent]);
        if (!d.modifiers.has(label)) {
          problems.push(
            `LABEL_SKILLS.${agent}: '${label}' routes nowhere and ${LABELS_PATH} → modifiers does not describe it`,
          );
        }
      } else if (router !== agent) {
        problems.push(
          `LABEL_SKILLS.${agent}: '${label}' (→ '${skill}') routes to ${router}, not ${agent}. A key must be one of ${agent}'s routing labels or a modifier`,
        );
      }
    }
  }
  for (const label of d.modifiers.keys()) {
    if (byLabel.has(label)) {
      problems.push(
        `${LABELS_PATH}: '${label}' routes (to ${byLabel.get(label)}), so it belongs under routing, not modifiers`,
      );
    } else if (!modifierAgents.has(label)) {
      problems.push(
        `${LABELS_PATH}: modifier '${label}' is in no agent's LABEL_SKILLS, so it selects nothing`,
      );
    }
  }

  for (const label of d.conventions.keys()) {
    if (byLabel.has(label)) {
      problems.push(
        `${LABELS_PATH}: convention '${label}' also routes (to ${byLabel.get(label)}); list it under routing`,
      );
    }
  }
  return problems;
}

/** Table order: the fleet's usual order, so the output never depends on readdir. */
export const AGENT_ORDER = [
  'strategist',
  'platform',
  'builder-server',
  'builder-client',
  'guardian',
  'marketer',
  'harness',
] as const;

const AGENT_NAMES: Record<string, string> = {
  strategist: 'Strategist',
  platform: 'Platform',
  'builder-server': 'Builder-Server',
  'builder-client': 'Builder-Client',
  guardian: 'Guardian',
  marketer: 'Marketer',
  harness: 'Harness',
};
const agentName = (agent: string) => AGENT_NAMES[agent] ?? agent;
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** The markdown between the markers. Deterministic: same inputs, same bytes. */
export function renderLabelTables(d: LabelDescriptions, facts: RoutingFacts): string {
  const { byLabel } = routingMap(facts.declared);
  const lines: string[] = [];

  lines.push('#### Routing labels — each sends the ticket to one agent', '');
  lines.push('| Label | Routes to | Starts skill | What it is for |', '|---|---|---|---|');
  for (const [agent, labels] of facts.declared) {
    for (const label of labels) {
      if (byLabel.get(label) !== agent) continue; // a collision; reported by the check
      const selected = facts.labelSkills.get(agent)?.get(label);
      const skill = selected
        ? `\`${selected}\``
        : `\`${facts.workDefaultSkill(agent)}\` (work default)`;
      lines.push(
        `| \`${label}\` | ${agentName(agent)} | ${skill} | ${cell(d.routing.get(label) ?? '')} |`,
      );
    }
  }

  lines.push('', '#### Modifier labels — pick the skill, route nowhere on their own', '');
  lines.push(
    '| Label | On a ticket routed to | Selects skill | What it is for |',
    '|---|---|---|---|',
  );
  for (const [label, description] of [...d.modifiers].sort(([a], [b]) => a.localeCompare(b))) {
    const users = [...facts.labelSkills].filter(([, skills]) => skills.has(label));
    if (users.length === 0) lines.push(`| \`${label}\` | — | — | ${cell(description)} |`);
    for (const [agent, skills] of users) {
      lines.push(
        `| \`${label}\` | ${agentName(agent)} | \`${skills.get(label)}\` | ${cell(description)} |`,
      );
    }
  }

  lines.push('', '#### Convention labels — route nothing; applied per the layers below', '');
  lines.push('| Label | What it is for |', '|---|---|');
  for (const [label, description] of d.conventions) {
    lines.push(`| \`${label}\` | ${cell(description)} |`);
  }
  return lines.join('\n');
}

/** Replace the generated block. Throws when the markers are missing or out of order. */
export function withGeneratedBlock(doc: string, body: string): string {
  const begin = doc.indexOf(BEGIN_MARKER);
  const end = doc.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `${PROTOCOLS_PATH}: the generated label block's markers are missing or out of order`,
    );
  }
  if (doc.indexOf(BEGIN_MARKER, begin + 1) !== -1 || doc.indexOf(END_MARKER, end + 1) !== -1) {
    throw new Error(`${PROTOCOLS_PATH}: the generated label block's markers appear more than once`);
  }
  return `${doc.slice(0, begin)}${BEGIN_MARKER}\n\n${body}\n\n${doc.slice(end)}`;
}

/** The check validate:fleet runs: is the committed block what the generator writes? */
export function generatedBlockProblems(doc: string, body: string): string[] {
  let expected: string;
  try {
    expected = withGeneratedBlock(doc, body);
  } catch (err) {
    return [(err as Error).message];
  }
  return expected === doc
    ? []
    : [
        `${PROTOCOLS_PATH}: the §5 label tables are out of date with the identities, LABEL_SKILLS or ${LABELS_PATH} — run \`pnpm labels:protocols\` from router/ and commit the result`,
      ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
