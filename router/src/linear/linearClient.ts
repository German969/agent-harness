// Linear GraphQL client — the write/read operations the Strategist's founding
// (Phase 0.6) + pm/pjm/triage skills need. Covers the "always allowed" tier
// (create issue/comment/label/project/milestone + reads) plus the GATED tier
// (move status, set milestone, reassign, set due date, close). The gated
// mutations are exposed as MCP tools ONLY in human-command sessions (see
// linearMcp.ts) — the client methods exist unconditionally, but the tool surface
// enforces AGENTS.md's tiered scope. Delete + archive stay unimplemented here
// (forbidden tier).
//
// Auth: personal API keys (lin_api_…) go raw in the Authorization header; OAuth
// access tokens (used for actor=app per-agent attribution) get a `Bearer` prefix —
// see linearAuthHeader. Create mutations attach `createAsUser` when an actorName is
// set, so one OAuth app attributes each agent's actions as "<agent> (via <App>)".

/** Injectable GraphQL executor — real impl POSTs to api.linear.app; tests fake it. */
export type LinearGraphQL = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<{ data?: unknown; errors?: Array<{ message: string }> }>;

export class LinearError extends Error {
  override readonly name = 'LinearError';
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export type Team = { id: string; key: string; name: string };
export type Label = { id: string; name: string };
export type CreatedIssue = { id: string; identifier: string; url: string };
export type CreatedProject = { id: string; url: string };
export type IssueMatch = { id: string; identifier: string; title: string; url: string };
export type IssueDetail = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: string;
  description: string;
  assignee: string | null;
  project: string | null;
  milestone: string | null;
  labels: string[];
};

export type ListIssuesFilter = {
  projectId?: string | undefined;
  milestoneId?: string | undefined;
  teamId?: string | undefined;
  state?: string | undefined;
  label?: string | undefined;
  first?: number | undefined;
};

/** Result of a gated issue mutation (move/milestone/assign/due-date/close). */
export type MutationResult = { identifier: string; url: string; state: string };

export type CreateIssueInput = {
  teamId: string;
  title: string;
  description?: string | undefined;
  labelIds?: string[] | undefined;
  projectId?: string | undefined;
  projectMilestoneId?: string | undefined;
  parentId?: string | undefined;
};

export class LinearClient {
  constructor(
    private readonly gql: LinearGraphQL,
    /** When set, create mutations attribute the action to this display name via
     *  Linear's `createAsUser` (OAuth actor=app only) — rendered as
     *  "<name> (via <App>)". Lets ONE OAuth app attribute each agent's Linear
     *  actions distinctly (per-agent identity without per-agent Linear seats). */
    private readonly actorName?: string,
  ) {}

  static fromToken(
    token: string,
    opts: { actorName?: string; baseUrl?: string } = {},
  ): LinearClient {
    return new LinearClient(
      defaultGraphQL(token, opts.baseUrl ?? 'https://api.linear.app/graphql'),
      opts.actorName,
    );
  }

  /** Attach `createAsUser` to a create-mutation input when an actor name is set. */
  private withActor(input: Record<string, unknown>): Record<string, unknown> {
    return this.actorName ? { ...input, createAsUser: this.actorName } : input;
  }

  async listTeams(): Promise<Team[]> {
    const data = await this.run('query { teams { nodes { id key name } } }', {});
    return asArray(pick(data, ['teams', 'nodes'])).map(toTeam);
  }

  /**
   * Resolve the team to act on when the caller didn't pass one. In a single-team
   * workspace (the common case) this returns that team's id so agents don't have
   * to look it up or ask. With zero or multiple teams it throws a clear, actionable
   * error — the agent should then list teams and pick, not guess.
   */
  async defaultTeamId(): Promise<string> {
    const teams = await this.listTeams();
    const [only] = teams;
    if (teams.length === 1 && only) return only.id;
    if (teams.length === 0) throw new LinearError('no Linear teams found for this token');
    throw new LinearError(
      `multiple Linear teams (${teams.map((t) => t.key).join(', ')}); pass teamId to pick one`,
    );
  }

  async listLabels(teamId: string): Promise<Label[]> {
    const data = await this.run(
      'query TeamLabels($id: String!) { team(id: $id) { labels { nodes { id name } } } }',
      { id: teamId },
    );
    return asArray(pick(data, ['team', 'labels', 'nodes'])).map(toLabel);
  }

  async searchIssues(term: string, first = 20): Promise<IssueMatch[]> {
    const data = await this.run(
      `query Issues($filter: IssueFilter, $first: Int!) {
        issues(filter: $filter, first: $first) { nodes { id identifier title url } }
      }`,
      { filter: { title: { contains: term } }, first },
    );
    return asArray(pick(data, ['issues', 'nodes'])).map(toIssueMatch);
  }

  /**
   * Fetch one issue by its human identifier (e.g. `IRS-1`). Linear's `issue(id:)`
   * query only takes the UUID, so we resolve the identifier via a `team.key` +
   * `number` filter. Returns undefined when nothing matches.
   */
  async getIssue(identifier: string): Promise<IssueDetail | undefined> {
    const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(identifier.trim());
    if (!m) throw new LinearError(`invalid issue identifier: "${identifier}" (expected TEAM-123)`);
    const teamKey = (m[1] as string).toUpperCase();
    const number = Number(m[2]);
    const data = await this.run(
      `query IssueByKey($filter: IssueFilter) {
        issues(filter: $filter, first: 1) {
          nodes {
            id identifier title url description
            state { name } assignee { name } project { name }
            projectMilestone { name } labels { nodes { name } }
          }
        }
      }`,
      { filter: { number: { eq: number }, team: { key: { eq: teamKey } } } },
    );
    const node = asArray(pick(data, ['issues', 'nodes']))[0];
    return node ? toIssueDetail(node) : undefined;
  }

  /** List issues by project / milestone / team / state / label (read-only). */
  async listIssues(filter: ListIssuesFilter = {}): Promise<IssueMatch[]> {
    const f: Record<string, unknown> = {};
    if (filter.projectId) f.project = { id: { eq: filter.projectId } };
    if (filter.milestoneId) f.projectMilestone = { id: { eq: filter.milestoneId } };
    if (filter.teamId) f.team = { id: { eq: filter.teamId } };
    if (filter.state) f.state = { name: { eq: filter.state } };
    if (filter.label) f.labels = { some: { name: { eq: filter.label } } };
    const data = await this.run(
      `query Issues($filter: IssueFilter, $first: Int!) {
        issues(filter: $filter, first: $first) { nodes { id identifier title url } }
      }`,
      { filter: f, first: filter.first ?? 50 },
    );
    return asArray(pick(data, ['issues', 'nodes'])).map(toIssueMatch);
  }

  async createIssue(input: CreateIssueInput): Promise<CreatedIssue> {
    const data = await this.run(
      `mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { id identifier url } }
      }`,
      { input: this.withActor(input as unknown as Record<string, unknown>) },
    );
    return requireCreated(pick(data, ['issueCreate']), 'issue', toCreatedIssue);
  }

  async createComment(issueId: string, body: string): Promise<{ id: string }> {
    const data = await this.run(
      `mutation CommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { id } }
      }`,
      { input: this.withActor({ issueId, body }) },
    );
    return requireCreated(pick(data, ['commentCreate']), 'comment', (c) => ({
      id: requireString(c, 'id'),
    }));
  }

  async createLabel(teamId: string, name: string, color?: string): Promise<Label> {
    const data = await this.run(
      `mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) { success issueLabel { id name } }
      }`,
      { input: { teamId, name, ...(color ? { color } : {}) } },
    );
    return requireCreated(pick(data, ['issueLabelCreate']), 'issueLabel', toLabel);
  }

  async createProject(
    name: string,
    teamIds: string[],
    description?: string,
  ): Promise<CreatedProject> {
    const data = await this.run(
      `mutation ProjectCreate($input: ProjectCreateInput!) {
        projectCreate(input: $input) { success project { id url } }
      }`,
      { input: { name, teamIds, ...(description ? { description } : {}) } },
    );
    return requireCreated(pick(data, ['projectCreate']), 'project', (p) => ({
      id: requireString(p, 'id'),
      url: requireString(p, 'url'),
    }));
  }

  async createProjectMilestone(
    projectId: string,
    name: string,
    targetDate?: string,
  ): Promise<{ id: string }> {
    const data = await this.run(
      `mutation ProjectMilestoneCreate($input: ProjectMilestoneCreateInput!) {
        projectMilestoneCreate(input: $input) { success projectMilestone { id } }
      }`,
      { input: { projectId, name, ...(targetDate ? { targetDate } : {}) } },
    );
    return requireCreated(pick(data, ['projectMilestoneCreate']), 'projectMilestone', (m) => ({
      id: requireString(m, 'id'),
    }));
  }

  // --- gated tier (move / milestone / reassign / due date / close) ----------
  // These execute only via MCP tools that are exposed in human-command sessions
  // (linearMcp.ts). Each resolves the human-friendly name (state / milestone /
  // assignee) to its id and then issues one issueUpdate.

  /** Move an issue to a workflow state named `stateName` (case-insensitive). */
  async moveIssueToState(identifier: string, stateName: string): Promise<MutationResult> {
    const { id, teamId } = await this.issueContext(identifier);
    const states = await this.teamStates(teamId);
    const match = states.find((s) => s.name.toLowerCase() === stateName.trim().toLowerCase());
    if (!match) {
      throw new LinearError(
        `no workflow state named "${stateName}" (have: ${states.map((s) => s.name).join(', ')})`,
      );
    }
    return this.issueUpdate(id, { stateId: match.id });
  }

  /** Set an issue's project milestone by milestone name (case-insensitive). */
  async setIssueMilestone(identifier: string, milestoneName: string): Promise<MutationResult> {
    const { id, projectId } = await this.issueContext(identifier);
    if (!projectId) {
      throw new LinearError(`issue ${identifier} is not in a project; cannot set a milestone`);
    }
    const data = await this.run(
      `query ProjectMilestones($id: String!) {
        project(id: $id) { projectMilestones { nodes { id name } } }
      }`,
      { id: projectId },
    );
    const nodes = asArray(pick(data, ['project', 'projectMilestones', 'nodes']));
    const names = nodes.map((n) => optString(n, ['name'])).filter((s): s is string => s !== null);
    const match = nodes.find(
      (n) => optString(n, ['name'])?.toLowerCase() === milestoneName.trim().toLowerCase(),
    );
    if (!match) {
      throw new LinearError(
        `no milestone named "${milestoneName}" on this project (have: ${names.join(', ')})`,
      );
    }
    return this.issueUpdate(id, { projectMilestoneId: requireString(match, 'id') });
  }

  /** Reassign an issue to the user matching `assignee` (name / display name / email). */
  async assignIssue(identifier: string, assignee: string): Promise<MutationResult> {
    const { id } = await this.issueContext(identifier);
    const assigneeId = await this.resolveUserId(assignee);
    return this.issueUpdate(id, { assigneeId });
  }

  /** Set an issue's due date (`YYYY-MM-DD`). */
  async setIssueDueDate(identifier: string, dueDate: string): Promise<MutationResult> {
    const { id } = await this.issueContext(identifier);
    return this.issueUpdate(id, { dueDate });
  }

  /** Close an issue by moving it to the team's first `completed`-type state. */
  async closeIssue(identifier: string): Promise<MutationResult> {
    const { id, teamId } = await this.issueContext(identifier);
    const states = await this.teamStates(teamId);
    const done = states.find((s) => s.type === 'completed');
    if (!done) throw new LinearError('no completed-type workflow state found on this team');
    return this.issueUpdate(id, { stateId: done.id });
  }

  /** Resolve an issue identifier (e.g. `IRS-7`) to its UUID + team/project ids. */
  private async issueContext(
    identifier: string,
  ): Promise<{ id: string; teamId: string; projectId: string | null }> {
    const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(identifier.trim());
    if (!m) throw new LinearError(`invalid issue identifier: "${identifier}" (expected TEAM-123)`);
    const teamKey = (m[1] as string).toUpperCase();
    const number = Number(m[2]);
    const data = await this.run(
      `query IssueCtx($filter: IssueFilter) {
        issues(filter: $filter, first: 1) {
          nodes { id team { id } project { id } }
        }
      }`,
      { filter: { number: { eq: number }, team: { key: { eq: teamKey } } } },
    );
    const node = asArray(pick(data, ['issues', 'nodes']))[0];
    if (!node) throw new LinearError(`issue not found: ${identifier}`);
    return {
      id: requireString(node, 'id'),
      teamId: requireString(pick(node, ['team']), 'id'),
      projectId: optString(node, ['project', 'id']),
    };
  }

  private async teamStates(
    teamId: string,
  ): Promise<Array<{ id: string; name: string; type: string }>> {
    const data = await this.run(
      `query TeamStates($id: String!) {
        team(id: $id) { states { nodes { id name type } } }
      }`,
      { id: teamId },
    );
    return asArray(pick(data, ['team', 'states', 'nodes'])).map((n) => ({
      id: requireString(n, 'id'),
      name: requireString(n, 'name'),
      type: optString(n, ['type']) ?? '',
    }));
  }

  private async resolveUserId(query: string): Promise<string> {
    const q = query.trim();
    const data = await this.run(
      `query Users($q: String!) {
        users(filter: { or: [
          { name: { containsIgnoreCase: $q } },
          { displayName: { containsIgnoreCase: $q } },
          { email: { eqIgnoreCase: $q } }
        ] }, first: 10) { nodes { id name displayName email } }
      }`,
      { q },
    );
    const nodes = asArray(pick(data, ['users', 'nodes']));
    if (nodes.length === 0) throw new LinearError(`no Linear user matches "${query}"`);
    const lc = q.toLowerCase();
    const exact = nodes.filter(
      (n) =>
        optString(n, ['name'])?.toLowerCase() === lc ||
        optString(n, ['displayName'])?.toLowerCase() === lc ||
        optString(n, ['email'])?.toLowerCase() === lc,
    );
    const pickList = exact.length > 0 ? exact : nodes;
    if (pickList.length > 1) {
      const names = pickList.map((n) => optString(n, ['name']) ?? '?').join(', ');
      throw new LinearError(
        `"${query}" matches multiple Linear users (${names}); be more specific`,
      );
    }
    return requireString(pickList[0], 'id');
  }

  private async issueUpdate(id: string, input: Record<string, unknown>): Promise<MutationResult> {
    const data = await this.run(
      `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success issue { identifier url state { name } }
        }
      }`,
      { id, input },
    );
    return requireOk(pick(data, ['issueUpdate']), 'issue', 'issueUpdate', (n) => ({
      identifier: requireString(n, 'identifier'),
      url: requireString(n, 'url'),
      state: optString(n, ['state', 'name']) ?? 'unknown',
    }));
  }

  private async run(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const res = await this.gql(query, variables);
    if (res.errors && res.errors.length > 0) {
      throw new LinearError(`linear graphql: ${res.errors.map((e) => e.message).join('; ')}`);
    }
    return res.data;
  }
}

/**
 * Linear auth header. Personal API keys (`lin_api_…`) are sent RAW; OAuth access
 * tokens (needed for `actor=app` per-agent attribution) require a `Bearer` prefix.
 */
export function linearAuthHeader(token: string): string {
  return token.startsWith('lin_api_') ? token : `Bearer ${token}`;
}

export function defaultGraphQL(token: string, baseUrl: string): LinearGraphQL {
  const authHeader = linearAuthHeader(token);
  return async (query, variables) => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      // 401/403 is almost always the token, not the query: an expired OAuth
      // access token or one authorized without the `read` scope. Say so, so the
      // failure is actionable (re-authorize the Linear OAuth app) instead of opaque.
      const hint =
        res.status === 401 || res.status === 403
          ? ' — LINEAR_TOKEN rejected (expired, revoked, or missing read scope); re-authorize the Linear OAuth app'
          : '';
      throw new LinearError(`linear graphql HTTP ${res.status}${hint}`, res.status);
    }
    return (await res.json()) as { data?: unknown; errors?: Array<{ message: string }> };
  };
}

// --- parsing helpers -------------------------------------------------------

function pick(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function requireString(obj: unknown, key: string): string {
  const v = obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
  if (typeof v !== 'string') throw new LinearError(`linear response missing "${key}"`);
  return v;
}

function requireCreated<T>(payload: unknown, node: string, map: (n: unknown) => T): T {
  return requireOk(payload, node, `${node}Create`, map);
}

/** Assert a mutation payload's `success` + non-null node, then map the node. */
function requireOk<T>(payload: unknown, node: string, op: string, map: (n: unknown) => T): T {
  const success =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>).success
      : undefined;
  const inner = pick(payload, [node]);
  if (success !== true || inner === undefined || inner === null) {
    throw new LinearError(`linear ${op} did not succeed`);
  }
  return map(inner);
}

function toTeam(n: unknown): Team {
  return {
    id: requireString(n, 'id'),
    key: requireString(n, 'key'),
    name: requireString(n, 'name'),
  };
}
function toLabel(n: unknown): Label {
  return { id: requireString(n, 'id'), name: requireString(n, 'name') };
}
function toCreatedIssue(n: unknown): CreatedIssue {
  return {
    id: requireString(n, 'id'),
    identifier: requireString(n, 'identifier'),
    url: requireString(n, 'url'),
  };
}
function toIssueMatch(n: unknown): IssueMatch {
  return {
    id: requireString(n, 'id'),
    identifier: requireString(n, 'identifier'),
    title: requireString(n, 'title'),
    url: requireString(n, 'url'),
  };
}

function optString(obj: unknown, path: string[]): string | null {
  const v = pick(obj, path);
  return typeof v === 'string' ? v : null;
}

function toIssueDetail(n: unknown): IssueDetail {
  const labels = asArray(pick(n, ['labels', 'nodes']))
    .map((l) => optString(l, ['name']))
    .filter((s): s is string => s !== null);
  return {
    id: requireString(n, 'id'),
    identifier: requireString(n, 'identifier'),
    title: requireString(n, 'title'),
    url: requireString(n, 'url'),
    state: optString(n, ['state', 'name']) ?? 'unknown',
    description: optString(n, ['description']) ?? '',
    assignee: optString(n, ['assignee', 'name']),
    project: optString(n, ['project', 'name']),
    milestone: optString(n, ['projectMilestone', 'name']),
    labels,
  };
}
