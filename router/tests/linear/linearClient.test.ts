import { describe, expect, it } from 'vitest';
import {
  LinearClient,
  LinearError,
  type LinearGraphQL,
  linearAuthHeader,
} from '../../src/linear/linearClient.js';

type Call = { query: string; variables: Record<string, unknown> };

/** Fake Linear GraphQL routed by the mutation/query name in the query string. */
function makeGql(over: { errors?: string[]; success?: boolean } = {}): {
  gql: LinearGraphQL;
  calls: Call[];
} {
  const calls: Call[] = [];
  const success = over.success ?? true;
  const gql: LinearGraphQL = async (query, variables) => {
    calls.push({ query, variables });
    if (over.errors) return { errors: over.errors.map((message) => ({ message })) };
    if (query.includes('teams {'))
      return { data: { teams: { nodes: [{ id: 'team_1', key: 'ENG', name: 'Engineering' }] } } };
    if (query.includes('TeamLabels'))
      return { data: { team: { labels: { nodes: [{ id: 'lab_1', name: 'mvp' }] } } } };
    if (query.includes('issues(filter'))
      return {
        data: { issues: { nodes: [{ id: 'iss_9', identifier: 'ENG-9', title: 'x', url: 'u' }] } },
      };
    if (query.includes('issueCreate'))
      return {
        data: { issueCreate: { success, issue: { id: 'iss_1', identifier: 'ENG-1', url: 'u1' } } },
      };
    if (query.includes('commentCreate'))
      return { data: { commentCreate: { success, comment: { id: 'com_1' } } } };
    if (query.includes('issueLabelCreate'))
      return {
        data: { issueLabelCreate: { success, issueLabel: { id: 'lab_2', name: 'feature' } } },
      };
    if (query.includes('projectCreate'))
      return { data: { projectCreate: { success, project: { id: 'proj_1', url: 'pu' } } } };
    if (query.includes('projectMilestoneCreate'))
      return { data: { projectMilestoneCreate: { success, projectMilestone: { id: 'mile_1' } } } };
    return { data: {} };
  };
  return { gql, calls };
}

describe('linearAuthHeader', () => {
  it('sends personal API keys raw and OAuth tokens as Bearer', () => {
    expect(linearAuthHeader('lin_api_abc123')).toBe('lin_api_abc123');
    expect(linearAuthHeader('lin_oauth_xyz')).toBe('Bearer lin_oauth_xyz');
  });
});

describe('LinearClient reads', () => {
  it('lists teams', async () => {
    const { gql } = makeGql();
    expect(await new LinearClient(gql).listTeams()).toEqual([
      { id: 'team_1', key: 'ENG', name: 'Engineering' },
    ]);
  });

  it("lists a team's labels", async () => {
    const { gql, calls } = makeGql();
    const labels = await new LinearClient(gql).listLabels('team_1');
    expect(labels).toEqual([{ id: 'lab_1', name: 'mvp' }]);
    expect(calls[0]?.variables).toEqual({ id: 'team_1' });
  });

  it('searches issues by title contains (for dedup)', async () => {
    const { gql, calls } = makeGql();
    const hits = await new LinearClient(gql).searchIssues('export');
    expect(hits[0]?.identifier).toBe('ENG-9');
    expect(calls[0]?.variables.filter).toEqual({ title: { contains: 'export' } });
  });
});

describe('LinearClient reads — getIssue / listIssues', () => {
  it('resolves a TEAM-123 identifier via team.key + number and maps the detail', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const gql: LinearGraphQL = async (_q, variables) => {
      calls.push(variables);
      return {
        data: {
          issues: {
            nodes: [
              {
                id: 'iss_1',
                identifier: 'IRS-1',
                title: 'Tenant model',
                url: 'u1',
                description: 'desc',
                state: { name: 'In Progress' },
                assignee: { name: 'platform (via App)' },
                project: { name: 'MVP' },
                projectMilestone: { name: 'M0' },
                labels: { nodes: [{ name: 'mvp' }, { name: 'infra' }] },
              },
            ],
          },
        },
      };
    };
    const issue = await new LinearClient(gql).getIssue('irs-1');
    expect(calls[0]?.filter).toEqual({ number: { eq: 1 }, team: { key: { eq: 'IRS' } } });
    expect(issue).toMatchObject({
      identifier: 'IRS-1',
      state: 'In Progress',
      milestone: 'M0',
      assignee: 'platform (via App)',
      labels: ['mvp', 'infra'],
    });
  });

  it('returns undefined when no issue matches', async () => {
    const gql: LinearGraphQL = async () => ({ data: { issues: { nodes: [] } } });
    expect(await new LinearClient(gql).getIssue('IRS-999')).toBeUndefined();
  });

  it('throws on a malformed identifier', async () => {
    const gql: LinearGraphQL = async () => ({ data: {} });
    await expect(new LinearClient(gql).getIssue('nope!')).rejects.toThrow(
      /invalid issue identifier/,
    );
  });

  it('builds a filter from milestone + state + label', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const gql: LinearGraphQL = async (_q, variables) => {
      calls.push(variables);
      return {
        data: { issues: { nodes: [{ id: 'i', identifier: 'IRS-2', title: 't', url: 'u' }] } },
      };
    };
    const res = await new LinearClient(gql).listIssues({
      milestoneId: 'mile_1',
      state: 'Done',
      label: 'mvp',
    });
    expect(calls[0]?.filter).toEqual({
      projectMilestone: { id: { eq: 'mile_1' } },
      state: { name: { eq: 'Done' } },
      labels: { some: { name: { eq: 'mvp' } } },
    });
    expect(res[0]?.identifier).toBe('IRS-2');
  });
});

describe('LinearClient.defaultTeamId', () => {
  const teamsGql =
    (nodes: Array<{ id: string; key: string; name: string }>): LinearGraphQL =>
    async () => ({ data: { teams: { nodes } } });

  it('returns the sole team id in a single-team workspace', async () => {
    const client = new LinearClient(teamsGql([{ id: 'team_1', key: 'ENG', name: 'Engineering' }]));
    expect(await client.defaultTeamId()).toBe('team_1');
  });

  it('throws when there are no teams', async () => {
    await expect(new LinearClient(teamsGql([])).defaultTeamId()).rejects.toThrow(/no Linear teams/);
  });

  it('throws (listing the keys) when there are multiple teams', async () => {
    const client = new LinearClient(
      teamsGql([
        { id: 't1', key: 'ENG', name: 'Engineering' },
        { id: 't2', key: 'OPS', name: 'Ops' },
      ]),
    );
    await expect(client.defaultTeamId()).rejects.toThrow(/multiple Linear teams \(ENG, OPS\)/);
  });
});

describe('LinearClient writes (founding tier)', () => {
  it('creates an issue with the given input', async () => {
    const { gql, calls } = makeGql();
    const issue = await new LinearClient(gql).createIssue({
      teamId: 'team_1',
      title: '[Feature] Export',
      labelIds: ['lab_1'],
      projectId: 'proj_1',
    });
    expect(issue).toEqual({ id: 'iss_1', identifier: 'ENG-1', url: 'u1' });
    expect(calls[0]?.variables.input).toMatchObject({
      teamId: 'team_1',
      title: '[Feature] Export',
      labelIds: ['lab_1'],
      projectId: 'proj_1',
    });
  });

  it('creates a comment', async () => {
    const { gql } = makeGql();
    expect(await new LinearClient(gql).createComment('iss_1', 'hi')).toEqual({ id: 'com_1' });
  });

  it('attributes creates to the actor name (createAsUser) when set', async () => {
    const { gql, calls } = makeGql();
    const client = new LinearClient(gql, 'platform');
    await client.createIssue({ teamId: 'team_1', title: 'X' });
    expect(calls[0]?.variables.input).toMatchObject({ title: 'X', createAsUser: 'platform' });
    await client.createComment('iss_1', 'hi');
    expect(calls[1]?.variables.input).toMatchObject({
      issueId: 'iss_1',
      body: 'hi',
      createAsUser: 'platform',
    });
  });

  it('omits createAsUser when no actor name is set', async () => {
    const { gql, calls } = makeGql();
    await new LinearClient(gql).createComment('iss_1', 'hi');
    expect(calls[0]?.variables.input).not.toHaveProperty('createAsUser');
  });

  it('creates a label', async () => {
    const { gql } = makeGql();
    expect(await new LinearClient(gql).createLabel('team_1', 'feature')).toEqual({
      id: 'lab_2',
      name: 'feature',
    });
  });

  it('creates a project (the MVP epic) with teamIds', async () => {
    const { gql, calls } = makeGql();
    const proj = await new LinearClient(gql).createProject('MVP — v1', ['team_1'], 'desc');
    expect(proj).toEqual({ id: 'proj_1', url: 'pu' });
    expect(calls[0]?.variables.input).toEqual({
      name: 'MVP — v1',
      teamIds: ['team_1'],
      description: 'desc',
    });
  });

  it('creates a project milestone', async () => {
    const { gql, calls } = makeGql();
    const m = await new LinearClient(gql).createProjectMilestone(
      'proj_1',
      'Milestone 1',
      '2026-09-01',
    );
    expect(m).toEqual({ id: 'mile_1' });
    expect(calls[0]?.variables.input).toEqual({
      projectId: 'proj_1',
      name: 'Milestone 1',
      targetDate: '2026-09-01',
    });
  });
});

/** Fake Linear GraphQL for the gated mutation tier (issueContext → resolve → issueUpdate). */
function mutGql(
  over: { project?: { id: string } | null; users?: Array<Record<string, unknown>> } = {},
): { gql: LinearGraphQL; calls: Call[] } {
  const calls: Call[] = [];
  const project = over.project === undefined ? { id: 'proj_1' } : over.project;
  const users = over.users ?? [
    { id: 'usr_1', name: 'German', displayName: 'German', email: 'g@x.com' },
  ];
  const gql: LinearGraphQL = async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes('IssueCtx'))
      return { data: { issues: { nodes: [{ id: 'iss_1', team: { id: 'team_1' }, project }] } } };
    if (query.includes('TeamStates'))
      return {
        data: {
          team: {
            states: {
              nodes: [
                { id: 's_todo', name: 'Todo', type: 'unstarted' },
                { id: 's_rev', name: 'In Review', type: 'started' },
                { id: 's_done', name: 'Done', type: 'completed' },
              ],
            },
          },
        },
      };
    if (query.includes('ProjectMilestones'))
      return {
        data: {
          project: { projectMilestones: { nodes: [{ id: 'mile_m1', name: 'M1 — Builder' }] } },
        },
      };
    if (query.includes('Users')) return { data: { users: { nodes: users } } };
    if (query.includes('issueUpdate'))
      return {
        data: {
          issueUpdate: {
            success: true,
            issue: { identifier: 'IRS-7', url: 'https://l/IRS-7', state: { name: 'x' } },
          },
        },
      };
    return { data: {} };
  };
  return { gql, calls };
}

function updateInput(calls: Call[]): Record<string, unknown> {
  const c = calls.find((x) => x.query.includes('issueUpdate'));
  return (c?.variables.input ?? {}) as Record<string, unknown>;
}

describe('LinearClient gated mutations', () => {
  it('moves an issue to a named state (resolves stateId)', async () => {
    const { gql, calls } = mutGql();
    const r = await new LinearClient(gql).moveIssueToState('IRS-7', 'in review');
    expect(r.identifier).toBe('IRS-7');
    expect(updateInput(calls)).toEqual({ stateId: 's_rev' });
  });

  it('throws (listing states) for an unknown state name', async () => {
    const { gql } = mutGql();
    await expect(new LinearClient(gql).moveIssueToState('IRS-7', 'Nope')).rejects.toThrow(
      /no workflow state named "Nope".*Todo, In Review, Done/,
    );
  });

  it('sets a milestone by name (resolves projectMilestoneId)', async () => {
    const { gql, calls } = mutGql();
    await new LinearClient(gql).setIssueMilestone('IRS-7', 'M1 — Builder');
    expect(updateInput(calls)).toEqual({ projectMilestoneId: 'mile_m1' });
  });

  it('refuses a milestone when the issue has no project', async () => {
    const { gql } = mutGql({ project: null });
    await expect(new LinearClient(gql).setIssueMilestone('IRS-7', 'M1 — Builder')).rejects.toThrow(
      /not in a project/,
    );
  });

  it('reassigns to a resolved user id', async () => {
    const { gql, calls } = mutGql();
    await new LinearClient(gql).assignIssue('IRS-7', 'German');
    expect(updateInput(calls)).toEqual({ assigneeId: 'usr_1' });
  });

  it('throws when an assignee query is ambiguous', async () => {
    const { gql } = mutGql({
      users: [
        { id: 'u1', name: 'Alex Kim', displayName: 'Alex', email: 'a@x.com' },
        { id: 'u2', name: 'Alex Lee', displayName: 'Alex', email: 'b@x.com' },
      ],
    });
    await expect(new LinearClient(gql).assignIssue('IRS-7', 'Alex')).rejects.toThrow(/multiple/);
  });

  it('sets a due date', async () => {
    const { gql, calls } = mutGql();
    await new LinearClient(gql).setIssueDueDate('IRS-7', '2026-09-01');
    expect(updateInput(calls)).toEqual({ dueDate: '2026-09-01' });
  });

  it('closes an issue by moving it to the completed-type state', async () => {
    const { gql, calls } = mutGql();
    await new LinearClient(gql).closeIssue('IRS-7');
    expect(updateInput(calls)).toEqual({ stateId: 's_done' });
  });
});

describe('LinearClient error handling', () => {
  it('throws LinearError when GraphQL returns errors', async () => {
    const { gql } = makeGql({ errors: ['Not authorized'] });
    await expect(new LinearClient(gql).listTeams()).rejects.toBeInstanceOf(LinearError);
    await expect(new LinearClient(gql).listTeams()).rejects.toThrow(/Not authorized/);
  });

  it('throws when a create mutation reports success: false', async () => {
    const { gql } = makeGql({ success: false });
    await expect(new LinearClient(gql).createIssue({ teamId: 't', title: 'x' })).rejects.toThrow(
      /issueCreate did not succeed/,
    );
  });
});
