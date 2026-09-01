// In-process MCP server exposing Linear tools as `mcp__linear__*`. Registered by
// the Anthropic SDK adapter per session, authed with that session's LINEAR_TOKEN.
//
// The always-allowed tier (create issue/comment/label/project/milestone + reads)
// is exposed in every Linear-enabled session. The GATED tier (move status, set
// milestone, reassign, set due date, close) is exposed ONLY when the adapter
// passes `gatedMutations: true` — which the runtime sets only for a human-command
// session (an explicit @-mention) on an agent whose mcp.json linear entry declares
// `gated_mutations: true` (Strategist). This keeps AGENTS.md's tiered scope enforced
// at the tool surface: in an autonomous/work session the mutation tools simply do
// not exist, so the `mcp__linear__*` allow entry can't auto-approve them. Delete +
// archive are the forbidden tier and have no tool at all.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from 'pino';
import { z } from 'zod';
import { type CreateIssueInput, type LinearClient, LinearError } from './linearClient.js';

export const LINEAR_SERVER = 'linear';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}
function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
function errorText(err: unknown): string {
  if (err instanceof LinearError)
    return err.status ? `${err.message} (HTTP ${err.status})` : err.message;
  return (err as Error).message ?? String(err);
}

// --- handler logic (pure + testable) --------------------------------------

export async function runListTeams(client: LinearClient): Promise<ToolResult> {
  try {
    return ok(JSON.stringify(await client.listTeams()));
  } catch (err) {
    return fail(`list_teams failed: ${errorText(err)}`);
  }
}

export async function runListLabels(client: LinearClient, teamId: string): Promise<ToolResult> {
  try {
    return ok(JSON.stringify(await client.listLabels(teamId)));
  } catch (err) {
    return fail(`list_labels failed: ${errorText(err)}`);
  }
}

export async function runSearchIssues(
  client: LinearClient,
  term: string,
  first?: number,
): Promise<ToolResult> {
  try {
    return ok(JSON.stringify(await client.searchIssues(term, first)));
  } catch (err) {
    return fail(`search_issues failed: ${errorText(err)}`);
  }
}

/** create_issue args — teamId is optional; it defaults to the sole team. */
export type CreateIssueArgs = Omit<CreateIssueInput, 'teamId'> & { teamId?: string | undefined };

export async function runGetIssue(client: LinearClient, identifier: string): Promise<ToolResult> {
  try {
    const issue = await client.getIssue(identifier);
    if (!issue) return ok(`No issue found with identifier ${identifier}.`);
    return ok(JSON.stringify(issue));
  } catch (err) {
    return fail(`get_issue failed: ${errorText(err)}`);
  }
}

export async function runListIssues(
  client: LinearClient,
  filter: Parameters<LinearClient['listIssues']>[0],
): Promise<ToolResult> {
  try {
    return ok(JSON.stringify(await client.listIssues(filter)));
  } catch (err) {
    return fail(`list_issues failed: ${errorText(err)}`);
  }
}

export async function runCreateIssue(
  client: LinearClient,
  input: CreateIssueArgs,
  log?: Logger,
  onCreated?: (threadKey: string) => void,
): Promise<ToolResult> {
  try {
    const teamId = input.teamId ?? (await client.defaultTeamId());
    const issue = await client.createIssue({ ...input, teamId });
    log?.info({ ...issue }, 'linear: create_issue');
    // Attribute the new ticket to this session so the loop guard can follow the
    // chain across the thread boundary — see state/artifact_origin.ts. Best-effort:
    // a bookkeeping failure must never fail a ticket that Linear already created.
    if (onCreated) {
      try {
        onCreated(`linear:${issue.identifier}`);
      } catch (err) {
        log?.warn({ err: (err as Error).message }, 'linear: artifact origin not recorded');
      }
    }
    return ok(`Created ${issue.identifier}: ${issue.url} (id ${issue.id}).`);
  } catch (err) {
    return fail(`create_issue failed: ${errorText(err)}`);
  }
}

export async function runCreateComment(
  client: LinearClient,
  issueId: string,
  body: string,
): Promise<ToolResult> {
  try {
    const c = await client.createComment(issueId, body);
    return ok(`Commented on ${issueId} (comment ${c.id}).`);
  } catch (err) {
    return fail(`create_comment failed: ${errorText(err)}`);
  }
}

export async function runCreateLabel(
  client: LinearClient,
  teamId: string | undefined,
  name: string,
  color?: string,
): Promise<ToolResult> {
  try {
    const l = await client.createLabel(teamId ?? (await client.defaultTeamId()), name, color);
    return ok(`Created label "${l.name}" (id ${l.id}).`);
  } catch (err) {
    return fail(`create_label failed: ${errorText(err)}`);
  }
}

export async function runCreateProject(
  client: LinearClient,
  name: string,
  teamIds: string[] | undefined,
  description: string | undefined,
  log?: Logger,
): Promise<ToolResult> {
  try {
    const ids = teamIds && teamIds.length > 0 ? teamIds : [await client.defaultTeamId()];
    const p = await client.createProject(name, ids, description);
    log?.info({ ...p, name }, 'linear: create_project');
    return ok(`Created project "${name}": ${p.url} (id ${p.id}).`);
  } catch (err) {
    return fail(`create_project failed: ${errorText(err)}`);
  }
}

export async function runCreateProjectMilestone(
  client: LinearClient,
  projectId: string,
  name: string,
  targetDate?: string,
): Promise<ToolResult> {
  try {
    const m = await client.createProjectMilestone(projectId, name, targetDate);
    return ok(`Created milestone "${name}" (id ${m.id}) on project ${projectId}.`);
  } catch (err) {
    return fail(`create_project_milestone failed: ${errorText(err)}`);
  }
}

// --- gated tier runners (exposed only in human-command sessions) -----------

export async function runMoveIssue(client: LinearClient, identifier: string, state: string) {
  try {
    const r = await client.moveIssueToState(identifier, state);
    return ok(`Moved ${r.identifier} to "${r.state}". ${r.url}`);
  } catch (err) {
    return fail(`move_issue failed: ${errorText(err)}`);
  }
}

export async function runSetMilestone(client: LinearClient, identifier: string, milestone: string) {
  try {
    const r = await client.setIssueMilestone(identifier, milestone);
    return ok(`Set ${r.identifier} milestone to "${milestone}". ${r.url}`);
  } catch (err) {
    return fail(`set_milestone failed: ${errorText(err)}`);
  }
}

export async function runAssignIssue(client: LinearClient, identifier: string, assignee: string) {
  try {
    const r = await client.assignIssue(identifier, assignee);
    return ok(`Assigned ${r.identifier} to "${assignee}". ${r.url}`);
  } catch (err) {
    return fail(`assign_issue failed: ${errorText(err)}`);
  }
}

export async function runSetDueDate(client: LinearClient, identifier: string, dueDate: string) {
  try {
    const r = await client.setIssueDueDate(identifier, dueDate);
    return ok(`Set ${r.identifier} due date to ${dueDate}. ${r.url}`);
  } catch (err) {
    return fail(`set_due_date failed: ${errorText(err)}`);
  }
}

export async function runCloseIssue(client: LinearClient, identifier: string) {
  try {
    const r = await client.closeIssue(identifier);
    return ok(`Closed ${r.identifier} (now "${r.state}"). ${r.url}`);
  } catch (err) {
    return fail(`close_issue failed: ${errorText(err)}`);
  }
}

function gatedTools(client: LinearClient) {
  return [
    tool(
      'move_issue',
      'GATED (human-command only): move an issue to a workflow state by name, e.g. state "In Review" or "Done".',
      { identifier: z.string(), state: z.string() },
      async (args) => runMoveIssue(client, args.identifier, args.state),
    ),
    tool(
      'set_milestone',
      "GATED (human-command only): set an issue's project milestone by milestone name.",
      { identifier: z.string(), milestone: z.string() },
      async (args) => runSetMilestone(client, args.identifier, args.milestone),
    ),
    tool(
      'assign_issue',
      'GATED (human-command only): reassign an issue to a user by name, display name, or email.',
      { identifier: z.string(), assignee: z.string() },
      async (args) => runAssignIssue(client, args.identifier, args.assignee),
    ),
    tool(
      'set_due_date',
      "GATED (human-command only): set an issue's due date (YYYY-MM-DD).",
      { identifier: z.string(), dueDate: z.string() },
      async (args) => runSetDueDate(client, args.identifier, args.dueDate),
    ),
    tool(
      'close_issue',
      "GATED (human-command only): close an issue (move it to the team's completed state).",
      { identifier: z.string() },
      async (args) => runCloseIssue(client, args.identifier),
    ),
  ];
}

// --- MCP server assembly ---------------------------------------------------

export function buildLinearMcpServer(
  client: LinearClient,
  opts: {
    log?: Logger;
    gatedMutations?: boolean;
    /** Called with the new ticket's thread_key whenever this session creates one. */
    onIssueCreated?: (threadKey: string) => void;
  } = {},
) {
  const log = opts.log;
  return createSdkMcpServer({
    name: LINEAR_SERVER,
    version: '0.1.0',
    tools: [
      tool(
        'list_teams',
        'List Linear teams (id, key, name). Use to resolve a teamId.',
        {},
        async () => runListTeams(client),
      ),
      tool(
        'list_labels',
        "List a team's labels (id, name). Use to resolve label names to ids before creating an issue.",
        { teamId: z.string() },
        async (args) => runListLabels(client, args.teamId),
      ),
      tool(
        'search_issues',
        'Search issues whose title contains a term — run this before creating to avoid duplicates.',
        { term: z.string(), first: z.number().int().positive().optional() },
        async (args) => runSearchIssues(client, args.term, args.first),
      ),
      tool(
        'get_issue',
        'Read one issue by its identifier (e.g. "IRS-1") — returns state, description, assignee, project, milestone, and labels. Use this to check a ticket before acting on it.',
        { identifier: z.string() },
        async (args) => runGetIssue(client, args.identifier),
      ),
      tool(
        'list_issues',
        'List issues (id, identifier, title, url) filtered by project, milestone, team, state name, or label. All filters optional; omit them to list recent issues. Use to see a milestone/project’s tickets.',
        {
          projectId: z.string().optional(),
          milestoneId: z.string().optional(),
          teamId: z.string().optional(),
          state: z.string().optional(),
          label: z.string().optional(),
          first: z.number().int().positive().optional(),
        },
        async (args) => runListIssues(client, args),
      ),
      tool(
        'create_issue',
        'Create an issue (feature ticket). teamId is optional — in a single-team workspace it defaults to that team, so you need not look it up or ask. Optionally attach labelIds, a projectId, a projectMilestoneId, or a parentId.',
        {
          teamId: z.string().optional(),
          title: z.string(),
          description: z.string().optional(),
          labelIds: z.array(z.string()).optional(),
          projectId: z.string().optional(),
          projectMilestoneId: z.string().optional(),
          parentId: z.string().optional(),
        },
        async (args) => runCreateIssue(client, args, log, opts.onIssueCreated),
      ),
      tool(
        'create_comment',
        'Comment on an issue.',
        { issueId: z.string(), body: z.string() },
        async (args) => runCreateComment(client, args.issueId, args.body),
      ),
      tool(
        'create_label',
        'Create a label on a team (only if search/list shows it does not already exist). teamId is optional — defaults to the sole team in a single-team workspace.',
        { teamId: z.string().optional(), name: z.string(), color: z.string().optional() },
        async (args) => runCreateLabel(client, args.teamId, args.name, args.color),
      ),
      tool(
        'create_project',
        'Create a project — the container for an MVP epic. teamIds is optional — defaults to the sole team in a single-team workspace.',
        {
          name: z.string(),
          teamIds: z.array(z.string()).optional(),
          description: z.string().optional(),
        },
        async (args) => runCreateProject(client, args.name, args.teamIds, args.description, log),
      ),
      tool(
        'create_project_milestone',
        'Create a milestone under a project.',
        { projectId: z.string(), name: z.string(), targetDate: z.string().optional() },
        async (args) =>
          runCreateProjectMilestone(client, args.projectId, args.name, args.targetDate),
      ),
      ...(opts.gatedMutations ? gatedTools(client) : []),
    ],
  });
}
