// HAR-19: §5's label tables are generated from the code, and the descriptions file
// agrees with the identities and LABEL_SKILLS. Fakes test each rule; the last block
// runs the real repo, so drift fails here as well as in validate:fleet.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadRoutingFacts } from '../../src/config/linearLabelFacts.js';
import {
  BEGIN_MARKER,
  END_MARKER,
  LABELS_PATH,
  MAX_DESCRIPTION,
  PROTOCOLS_PATH,
  type RoutingFacts,
  crossCheckLinearLabels,
  generatedBlockProblems,
  parseLabelDescriptions,
  renderLabelTables,
  routingMap,
  withGeneratedBlock,
} from '../../src/config/linearLabels.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const labelSkills = (entries: Record<string, Record<string, string>>) =>
  new Map(Object.entries(entries).map(([agent, m]) => [agent, new Map(Object.entries(m))]));

function facts(overrides: Partial<RoutingFacts> = {}): RoutingFacts {
  return {
    declared: new Map([
      ['strategist', ['prd', 'research']],
      ['marketer', ['campaign']],
    ]),
    labelSkills: labelSkills({
      strategist: { prd: 'pm' },
      marketer: { benchmark: 'benchmarking' },
    }),
    workDefaultSkill: (a) => (a === 'strategist' ? 'conversational' : 'campaign-lead'),
    ...overrides,
  };
}

const yaml = (routing: string, modifiers = '  benchmark: "b"', conventions = '  Bug: "c"') =>
  `version: 1\nrouting:\n${routing}\nmodifiers:\n${modifiers}\nconventions:\n${conventions}\n`;
const OK_ROUTING = '  prd: "p"\n  research: "r"\n  campaign: "c"';
const parsed = (text: string) => {
  const { descriptions, problems } = parseLabelDescriptions(text);
  expect(problems).toEqual([]);
  return descriptions as NonNullable<typeof descriptions>;
};

describe('parseLabelDescriptions', () => {
  it('rejects empty and over-long descriptions, unknown keys, and a label in two sections', () => {
    const long = 'x'.repeat(MAX_DESCRIPTION + 1);
    const { problems } = parseLabelDescriptions(
      `version: 1\nrouting:\n  a: ""\n  b: "${long}"\n  Bug: "dup"\nmodifiers: {}\nconventions:\n  Bug: "x"\nextra: 1\n`,
    );
    const all = problems.join('\n');
    expect(all).toMatch(/routing 'a' has no description/);
    expect(all).toMatch(/routing 'b' description is 256 characters/);
    expect(all).toMatch(/'Bug' is listed under both `routing` and `conventions`/);
    expect(all).toMatch(/unknown top-level key `extra`/);
  });

  it('rejects a missing section and a wrong version', () => {
    const all = parseLabelDescriptions('version: 2\nrouting: {}\nmodifiers: {}\n').problems.join(
      '\n',
    );
    expect(all).toMatch(/`version` must be 1/);
    expect(all).toMatch(/`conventions` is missing/);
  });
});

describe('routingMap', () => {
  it('reports a label two agents declare, whichever order they load in', () => {
    for (const order of [
      [
        ['a', ['x']],
        ['b', ['x']],
      ],
      [
        ['b', ['x']],
        ['a', ['x']],
      ],
    ] as Array<Array<[string, string[]]>>) {
      expect(routingMap(new Map(order)).collisions).toEqual([
        expect.stringMatching(/'x' is declared by (a and b|b and a)/),
      ]);
    }
  });
});

describe('crossCheckLinearLabels', () => {
  it('is clean when everything agrees', () => {
    expect(crossCheckLinearLabels(parsed(yaml(OK_ROUTING)), facts())).toEqual([]);
  });

  it('fails a routing label with no description, and a description nothing routes', () => {
    const all = crossCheckLinearLabels(
      parsed(yaml('  prd: "p"\n  campaign: "c"\n  ghost: "g"')),
      facts(),
    ).join('\n');
    expect(all).toMatch(/strategist: routes on Linear label 'research'/);
    expect(all).toMatch(/routing label 'ghost' is declared by no identity/);
  });

  it('fails a collision', () => {
    const f = facts({
      declared: new Map([
        ['strategist', ['prd', 'research']],
        ['marketer', ['campaign', 'research']],
      ]),
    });
    expect(crossCheckLinearLabels(parsed(yaml(OK_ROUTING)), f).join('\n')).toMatch(
      /'research' is declared by strategist and marketer/,
    );
  });

  it('fails a LABEL_SKILLS key that routes nowhere and is not a described modifier', () => {
    expect(crossCheckLinearLabels(parsed(yaml(OK_ROUTING, '  {}')), facts()).join('\n')).toMatch(
      /LABEL_SKILLS.marketer: 'benchmark' routes nowhere/,
    );
  });

  it('fails a modifier that is not in LABEL_SKILLS', () => {
    expect(
      crossCheckLinearLabels(
        parsed(yaml(OK_ROUTING, '  benchmark: "b"\n  nothing: "n"')),
        facts(),
      ).join('\n'),
    ).toMatch(/modifier 'nothing' is in no agent's LABEL_SKILLS/);
  });

  it('fails a modifier that routes on its own', () => {
    expect(
      crossCheckLinearLabels(
        parsed(yaml('  research: "r"\n  campaign: "c"', '  benchmark: "b"\n  prd: "p"')),
        facts(),
      ).join('\n'),
    ).toMatch(/'prd' routes \(to strategist\), so it belongs under routing/);
  });

  it('fails a LABEL_SKILLS key that routes to a different agent (HAR-23)', () => {
    // Guardian keyed on Marketer's `campaign`: it could only fire on a ticket some
    // other label sent to Guardian, letting Marketer's label pick Guardian's skill.
    const f = facts({
      labelSkills: labelSkills({
        strategist: { prd: 'pm' },
        marketer: { benchmark: 'benchmarking' },
        guardian: { campaign: 'qa' },
      }),
    });
    expect(crossCheckLinearLabels(parsed(yaml(OK_ROUTING)), f)).toEqual([
      expect.stringMatching(
        /LABEL_SKILLS.guardian: 'campaign' \(→ 'qa'\) routes to marketer, not guardian/,
      ),
    ]);
  });

  it('fails a modifier no agent keys on, even when another agent does', () => {
    const f = facts({ labelSkills: labelSkills({ strategist: { prd: 'pm' } }) });
    expect(crossCheckLinearLabels(parsed(yaml(OK_ROUTING)), f).join('\n')).toMatch(
      /modifier 'benchmark' is in no agent's LABEL_SKILLS/,
    );
  });

  it('fails a convention label that routes', () => {
    expect(
      crossCheckLinearLabels(
        parsed(yaml('  prd: "p"\n  campaign: "c"', '  benchmark: "b"', '  research: "x"')),
        facts(),
      ).join('\n'),
    ).toMatch(/convention 'research' also routes/);
  });
});

describe('renderLabelTables', () => {
  const out = renderLabelTables(parsed(yaml(OK_ROUTING)), facts());

  it('shows the skill LABEL_SKILLS selects, or the work default when it has none', () => {
    expect(out).toContain('| `prd` | Strategist | `pm` | p |');
    expect(out).toContain('| `research` | Strategist | `conversational` (work default) | r |');
    expect(out).toContain('| `campaign` | Marketer | `campaign-lead` (work default) | c |');
  });

  it('shows a routing label another agent keys on as the work default, not that skill', () => {
    // The generator must show what the router does: LABEL_SKILLS.strategist.campaign
    // cannot fire on a ticket routed to Marketer.
    const f = facts({
      labelSkills: labelSkills({ strategist: { prd: 'pm', campaign: 'pm' } }),
    });
    expect(renderLabelTables(parsed(yaml(OK_ROUTING)), f)).toContain(
      '| `campaign` | Marketer | `campaign-lead` (work default) | c |',
    );
  });

  it('lists modifiers with the agent and skill, and conventions', () => {
    expect(out).toContain('| `benchmark` | Marketer | `benchmarking` | b |');
    expect(out).toContain('| `Bug` | c |');
  });

  it('escapes a pipe in a description so it cannot break the table', () => {
    const piped = renderLabelTables(
      parsed(yaml('  prd: "a | b"\n  research: "r"\n  campaign: "c"')),
      facts(),
    );
    expect(piped).toContain('| `prd` | Strategist | `pm` | a \\| b |');
  });

  it('is deterministic', () => {
    expect(renderLabelTables(parsed(yaml(OK_ROUTING)), facts())).toBe(out);
  });
});

describe('the generated block', () => {
  const doc = `intro\n${BEGIN_MARKER}\n\nold\n\n${END_MARKER}\noutro\n`;

  it('replaces only what is between the markers', () => {
    expect(withGeneratedBlock(doc, 'new')).toBe(
      `intro\n${BEGIN_MARKER}\n\nnew\n\n${END_MARKER}\noutro\n`,
    );
  });

  it('reports a stale block, and passes a current one', () => {
    expect(generatedBlockProblems(doc, 'new')).toEqual([expect.stringMatching(/out of date/)]);
    expect(generatedBlockProblems(withGeneratedBlock(doc, 'new'), 'new')).toEqual([]);
  });

  it('fails on missing, reversed or duplicated markers', () => {
    expect(generatedBlockProblems('no markers', 'x')[0]).toMatch(/missing or out of order/);
    expect(generatedBlockProblems(`${END_MARKER}\n${BEGIN_MARKER}`, 'x')[0]).toMatch(
      /out of order/,
    );
    expect(generatedBlockProblems(`${doc}${BEGIN_MARKER}`, 'x')[0]).toMatch(/more than once/);
  });
});

describe('the real repo', () => {
  const { facts: real, errors } = loadRoutingFacts(repoRoot);
  const { descriptions, problems } = parseLabelDescriptions(
    readFileSync(join(repoRoot, LABELS_PATH), 'utf-8'),
  );

  it('identities load, and the descriptions file parses', () => {
    expect(errors).toEqual([]);
    expect(problems).toEqual([]);
  });

  it('descriptions, identities and LABEL_SKILLS agree', () => {
    expect(crossCheckLinearLabels(descriptions as never, real)).toEqual([]);
  });

  it('PROTOCOLS.md §5 carries exactly the generated tables', () => {
    const doc = readFileSync(join(repoRoot, PROTOCOLS_PATH), 'utf-8');
    expect(generatedBlockProblems(doc, renderLabelTables(descriptions as never, real))).toEqual([]);
  });

  it('no routing label is claimed by two agents (the design collision stays fixed)', () => {
    expect(routingMap(real.declared).collisions).toEqual([]);
    expect(routingMap(real.declared).byLabel.get('design')).toBe('builder-client');
  });
});
