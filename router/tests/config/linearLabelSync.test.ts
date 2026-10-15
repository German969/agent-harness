// HAR-8: the online Linear label check. Scoping runs against the REAL identities,
// LABEL_SKILLS and agents/linear-labels.yml; the Linear side is faked at the
// GraphQL boundary, so the queries the client sends are pinned too.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadRoutingFacts } from '../../src/config/linearLabelFacts.js';
import {
  type LinearLabelClient,
  type ListedLabel,
  graphqlLabelClient,
  syncLinearLabels,
  wantedLinearLabels,
} from '../../src/config/linearLabelSync.js';
import {
  LABELS_PATH,
  type LabelDescriptions,
  parseLabelDescriptions,
} from '../../src/config/linearLabels.js';
import type { LinearGraphQL } from '../../src/linear/linearClient.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { facts } = loadRoutingFacts(repoRoot);
const descriptions = parseLabelDescriptions(readFileSync(join(repoRoot, LABELS_PATH), 'utf-8'))
  .descriptions as LabelDescriptions;

function fakeClient(initial: ListedLabel[]) {
  const labels = [...initial];
  const created: Array<{ name: string; description: string }> = [];
  const client: LinearLabelClient = {
    list: async () => [...labels],
    create: async (name, description) => {
      created.push({ name, description });
      labels.push({ name, team: 'IRS' });
    },
  };
  return { client, created };
}

describe('wantedLinearLabels (real registry)', () => {
  it("takes an agent's routing labels and its modifiers, with their descriptions", () => {
    const { wanted, problems } = wantedLinearLabels(descriptions, facts, ['marketer'], {
      conventions: false,
    });
    expect(problems).toEqual([]);
    expect(wanted.has('campaign')).toBe(true);
    expect(wanted.get('benchmark')).toBe(descriptions.modifiers.get('benchmark'));
    expect(wanted.has('prd')).toBe(false);
    expect(wanted.has('P0')).toBe(false);
  });

  it('leaves out agents not asked for, and adds conventions only when asked', () => {
    const { wanted } = wantedLinearLabels(descriptions, facts, ['strategist'], {
      conventions: true,
    });
    expect(wanted.has('prd')).toBe(true);
    expect(wanted.has('keep-forever')).toBe(true);
    expect(wanted.has('campaign')).toBe(false);
    expect(wanted.has('benchmark')).toBe(false);
  });

  it('names an agent no identity declares instead of checking nothing', () => {
    expect(
      wantedLinearLabels(descriptions, facts, ['stratgist'], { conventions: false }).problems,
    ).toEqual(["no identity file declares an agent named 'stratgist'"]);
  });
});

describe('syncLinearLabels', () => {
  const wanted = new Map([
    ['prd', 'PRD work'],
    ['blocker', 'Sprint blocker'],
    ['Bug', 'Defect'],
  ]);

  it('check: fails naming each missing label, and creates nothing', async () => {
    const { client, created } = fakeClient([{ name: 'prd', team: 'IRS' }, { name: 'Bug' }]);
    const r = await syncLinearLabels('IRS', wanted, client, 'check');
    expect(r.code).toBe(1);
    expect(r.out).toContain("'blocker'");
    expect(r.out).not.toContain("'prd'");
    expect(created).toEqual([]);
  });

  it('counts a workspace label as present, and another team’s label as absent', async () => {
    const { client } = fakeClient([
      { name: 'prd', team: 'HAR' },
      { name: 'blocker', team: 'IRS' },
      { name: 'Bug' },
    ]);
    const r = await syncLinearLabels('IRS', wanted, client, 'check');
    expect(r.code).toBe(1);
    expect(r.out).toContain("missing from IRS: 'prd'");
  });

  it('reports a label that differs only in case, and never creates or renames it', async () => {
    const { client, created } = fakeClient([
      { name: 'prd', team: 'IRS' },
      { name: 'Blocker', team: 'IRS' },
      { name: 'Bug' },
    ]);
    const r = await syncLinearLabels('IRS', wanted, client, 'create');
    expect(r.code).toBe(1);
    expect(r.out).toContain("'blocker' exists as 'Blocker'");
    expect(created).toEqual([]);
  });

  it('create: creates only the missing ones, with their descriptions, and verifies', async () => {
    const { client, created } = fakeClient([{ name: 'prd', team: 'IRS' }, { name: 'Bug' }]);
    const r = await syncLinearLabels('IRS', wanted, client, 'create');
    expect(created).toEqual([{ name: 'blocker', description: 'Sprint blocker' }]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("created 'blocker'");
  });

  it('create: a second run is a no-op that says so', async () => {
    const { client, created } = fakeClient([
      { name: 'prd', team: 'IRS' },
      { name: 'blocker', team: 'IRS' },
      { name: 'Bug' },
    ]);
    const r = await syncLinearLabels('IRS', wanted, client, 'create');
    expect(created).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('nothing to create');
  });

  it('create: fails when a created label still does not list', async () => {
    const client: LinearLabelClient = { list: async () => [], create: async () => {} };
    const r = await syncLinearLabels('IRS', new Map([['prd', 'x']]), client, 'create');
    expect(r.code).toBe(1);
    expect(r.out).toContain('still not listed');
  });
});

describe('graphqlLabelClient', () => {
  it('lists every page of workspace labels with their team key', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const gql: LinearGraphQL = async (_q, variables) => {
      calls.push(variables);
      return variables.after === null
        ? {
            data: {
              issueLabels: {
                nodes: [{ name: 'prd', team: { key: 'IRS' } }],
                pageInfo: { hasNextPage: true, endCursor: 'c1' },
              },
            },
          }
        : {
            data: {
              issueLabels: {
                nodes: [{ name: 'Bug', team: null }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          };
    };
    expect(await graphqlLabelClient(gql, 'IRS').list()).toEqual([
      { name: 'prd', team: 'IRS' },
      { name: 'Bug', team: undefined },
    ]);
    expect(calls).toEqual([{ after: null }, { after: 'c1' }]);
  });

  it('creates on the team UUID resolved from its key, with the description', async () => {
    const inputs: unknown[] = [];
    const gql: LinearGraphQL = async (query, variables) => {
      if (query.includes('teams')) {
        return {
          data: {
            teams: {
              nodes: [
                { id: 'uuid-har', key: 'HAR' },
                { id: 'uuid-irs', key: 'IRS' },
              ],
            },
          },
        };
      }
      inputs.push(variables.input);
      return { data: { issueLabelCreate: { success: true } } };
    };
    await graphqlLabelClient(gql, 'IRS').create('blocker', 'Sprint blocker');
    expect(inputs).toEqual([
      { teamId: 'uuid-irs', name: 'blocker', description: 'Sprint blocker' },
    ]);
  });

  it('surfaces a GraphQL error instead of reading it as an empty list', async () => {
    const gql: LinearGraphQL = async () => ({ errors: [{ message: 'Authentication required' }] });
    await expect(graphqlLabelClient(gql, 'IRS').list()).rejects.toThrow('Authentication required');
  });
});
