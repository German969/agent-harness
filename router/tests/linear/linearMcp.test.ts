import { describe, expect, it } from 'vitest';
import { LinearClient, type LinearGraphQL } from '../../src/linear/linearClient.js';
import {
  runCloseIssue,
  runCreateIssue,
  runCreateProject,
  runGetIssue,
  runListIssues,
  runListTeams,
  runMoveIssue,
  runSearchIssues,
  runSetMilestone,
} from '../../src/linear/linearMcp.js';

/** Fake client that resolves the gated mutation chain (IssueCtx → states → update). */
function mutClient(): LinearClient {
  const gql: LinearGraphQL = async (query) => {
    if (query.includes('IssueCtx'))
      return {
        data: {
          issues: { nodes: [{ id: 'iss_1', team: { id: 'team_1' }, project: { id: 'p1' } }] },
        },
      };
    if (query.includes('TeamStates'))
      return {
        data: {
          team: {
            states: {
              nodes: [
                { id: 's_rev', name: 'In Review', type: 'started' },
                { id: 's_done', name: 'Done', type: 'completed' },
              ],
            },
          },
        },
      };
    if (query.includes('ProjectMilestones'))
      return { data: { project: { projectMilestones: { nodes: [{ id: 'm1', name: 'M1' }] } } } };
    if (query.includes('issueUpdate'))
      return {
        data: {
          issueUpdate: {
            success: true,
            issue: { identifier: 'IRS-7', url: 'u', state: { name: 'Done' } },
          },
        },
      };
    return { data: {} };
  };
  return new LinearClient(gql);
}

function client(over: { errors?: string[]; success?: boolean } = {}): LinearClient {
  const success = over.success ?? true;
  const gql: LinearGraphQL = async (query) => {
    if (over.errors) return { errors: over.errors.map((message) => ({ message })) };
    if (query.includes('teams {'))
      return { data: { teams: { nodes: [{ id: 'team_1', key: 'ENG', name: 'Engineering' }] } } };
    if (query.includes('issues(filter'))
      return {
        data: { issues: { nodes: [{ id: 'i9', identifier: 'ENG-9', title: 't', url: 'u' }] } },
      };
    if (query.includes('issueCreate'))
      return {
        data: { issueCreate: { success, issue: { id: 'i1', identifier: 'ENG-1', url: 'u1' } } },
      };
    if (query.includes('projectCreate'))
      return { data: { projectCreate: { success, project: { id: 'p1', url: 'pu' } } } };
    return { data: {} };
  };
  return new LinearClient(gql);
}

/** Capturing variant — records the variables passed to each mutation. */
function capturingClient(): { client: LinearClient; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const gql: LinearGraphQL = async (query, variables) => {
    calls.push({ query, ...variables });
    if (query.includes('teams {'))
      return { data: { teams: { nodes: [{ id: 'team_1', key: 'ENG', name: 'Engineering' }] } } };
    if (query.includes('issueCreate'))
      return {
        data: {
          issueCreate: { success: true, issue: { id: 'i1', identifier: 'ENG-1', url: 'u1' } },
        },
      };
    if (query.includes('projectCreate'))
      return { data: { projectCreate: { success: true, project: { id: 'p1', url: 'pu' } } } };
    return { data: {} };
  };
  return { client: new LinearClient(gql), calls };
}

describe('linear MCP handlers', () => {
  it('create_issue defaults teamId to the sole team when omitted', async () => {
    const { client, calls } = capturingClient();
    const r = await runCreateIssue(client, { title: 'no team given' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toContain('ENG-1');
    const create = calls.find((c) => String(c.query).includes('issueCreate'));
    expect((create?.input as { teamId?: string })?.teamId).toBe('team_1');
  });

  it('create_project defaults teamIds to the sole team when omitted', async () => {
    const { client, calls } = capturingClient();
    const r = await runCreateProject(client, 'MVP — v1', undefined, undefined);
    expect(r.isError).toBeFalsy();
    const create = calls.find((c) => String(c.query).includes('projectCreate'));
    expect((create?.input as { teamIds?: string[] })?.teamIds).toEqual(['team_1']);
  });

  it('get_issue returns the issue detail as JSON', async () => {
    const r = await runGetIssue(client(), 'ENG-9');
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toContain('ENG-9');
  });

  it('list_issues returns matches as JSON', async () => {
    const r = await runListIssues(client(), { state: 'Done' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toContain('ENG-9');
  });

  it('list_teams returns JSON the agent can parse for a teamId', async () => {
    const r = await runListTeams(client());
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0]?.text ?? '')[0]).toMatchObject({ id: 'team_1', key: 'ENG' });
  });

  it('search_issues returns matches', async () => {
    const r = await runSearchIssues(client(), 'export');
    expect(JSON.parse(r.content[0]?.text ?? '')[0].identifier).toBe('ENG-9');
  });

  it('create_issue reports the identifier + url', async () => {
    const r = await runCreateIssue(client(), { teamId: 'team_1', title: '[Feature] Export' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toContain('ENG-1');
    expect(r.content[0]?.text).toContain('u1');
  });

  // The loop guard follows a chain across the thread boundary a new ticket opens
  // (state/artifact_origin.ts), and this callback is where the origin is recorded.
  it('create_issue reports the new ticket thread_key to onCreated', async () => {
    const seen: string[] = [];
    const r = await runCreateIssue(
      client(),
      { teamId: 'team_1', title: 'subtask' },
      undefined,
      (k) => seen.push(k),
    );
    expect(r.isError).toBeFalsy();
    // Exactly the key buildThreadKey produces for events on this ticket — the
    // consumer looks the origin up by that value with no further parsing.
    expect(seen).toEqual(['linear:ENG-1']);
  });

  it('does not call onCreated when the create failed', async () => {
    const seen: string[] = [];
    await runCreateIssue(
      client({ errors: ['Not authorized'] }),
      { teamId: 't', title: 'x' },
      undefined,
      (k) => seen.push(k),
    );
    expect(seen).toEqual([]);
  });

  it('a throwing onCreated never fails a ticket Linear already created', async () => {
    const r = await runCreateIssue(
      client(),
      { teamId: 'team_1', title: 'subtask' },
      undefined,
      () => {
        throw new Error('db is gone');
      },
    );
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toContain('ENG-1');
  });

  it('create_project reports the project url', async () => {
    const r = await runCreateProject(client(), 'MVP — v1', ['team_1'], undefined);
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toContain('pu');
  });

  it('surfaces errors as an error result (not a throw)', async () => {
    const r = await runCreateIssue(client({ errors: ['Not authorized'] }), {
      teamId: 't',
      title: 'x',
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain('Not authorized');
  });

  it('reports a create that did not succeed', async () => {
    const r = await runCreateProject(client({ success: false }), 'p', ['t'], undefined);
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain('did not succeed');
  });
});

describe('linear MCP gated handlers', () => {
  it('move_issue reports the move', async () => {
    const r = await runMoveIssue(mutClient(), 'IRS-7', 'In Review');
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toContain('Moved IRS-7');
  });

  it('move_issue surfaces an unknown-state error (not a throw)', async () => {
    const r = await runMoveIssue(mutClient(), 'IRS-7', 'Nonexistent');
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain('move_issue failed');
  });

  it('set_milestone reports the milestone', async () => {
    const r = await runSetMilestone(mutClient(), 'IRS-7', 'M1');
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toContain('milestone to "M1"');
  });

  it('close_issue reports the close', async () => {
    const r = await runCloseIssue(mutClient(), 'IRS-7');
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toContain('Closed IRS-7');
  });
});
