// The online half of the Linear label registry (HAR-8): do the labels the fleet
// routes on actually exist in the Linear workspace?
//
// validate:fleet (check 9) proves the identity files, LABEL_SKILLS and
// agents/linear-labels.yml agree with each other, offline. None of that says the
// labels exist in Linear. On 2026-09-10 five of ~51 declared routing labels did,
// and label routing was dead for five agents with nothing reporting it. This
// module is the check that would have said so, and the `--create` that fixes it.
//
// Source of truth is the same as check 9's: `routing.linear_labels` in
// identities/*.yml says which labels route, LABEL_SKILLS which modifiers matter,
// and agents/linear-labels.yml carries the descriptions. PROTOCOLS.md §5 is a
// generated view of those, never an input.
//
// Labels are team-scoped in Linear, and a workspace label (no team) is visible to
// every team, so a label counts as present when it is on the team or on no team.
// Creating never edits, renames or deletes: an existing label may be on live
// tickets, and Linear has no undo for a delete.
//
// Lives in src/ because tsconfig and biome do not cover scripts/.

import type { LinearGraphQL } from '../linear/linearClient.js';
import type { LabelDescriptions, RoutingFacts } from './linearLabels.js';

/** A label as listed: its name, and the key of its team (undefined for a workspace label). */
export type ListedLabel = { name: string; team?: string | undefined };

export type LinearLabelClient = {
  list(): Promise<ListedLabel[]>;
  create(name: string, description: string): Promise<void>;
};

/**
 * The labels one team needs, label → description: the routing labels the given
 * agents declare, the modifiers in those agents' LABEL_SKILLS, and, when asked for,
 * the convention labels (severity, status). Scoped by agent because an agent that
 * is not running yet has no use for its labels, and every extra one crowds a
 * picker people use daily.
 */
export function wantedLinearLabels(
  d: LabelDescriptions,
  facts: RoutingFacts,
  agents: readonly string[],
  opts: { conventions: boolean },
): { wanted: Map<string, string>; problems: string[] } {
  const wanted = new Map<string, string>();
  const problems: string[] = [];
  for (const agent of agents) {
    const declared = facts.declared.get(agent);
    if (!declared) {
      problems.push(`no identity file declares an agent named '${agent}'`);
      continue;
    }
    for (const label of declared) {
      const description = d.routing.get(label);
      // check 9 fails the same gap offline; repeated here so this never creates a
      // label with no description.
      if (description === undefined) problems.push(`${agent}: '${label}' has no description`);
      else wanted.set(label, description);
    }
    for (const label of facts.labelSkills.get(agent)?.keys() ?? []) {
      const description = d.modifiers.get(label);
      if (description !== undefined) wanted.set(label, description);
    }
  }
  if (opts.conventions)
    for (const [label, description] of d.conventions) wanted.set(label, description);
  return { wanted, problems };
}

export async function syncLinearLabels(
  team: string,
  wanted: ReadonlyMap<string, string>,
  client: LinearLabelClient,
  mode: 'check' | 'create',
): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const visible = async () =>
    (await client.list()).filter((l) => l.team === undefined || l.team === team);

  // Linear will not hold two labels that differ only in case, and the router
  // matches names exactly, so `Blocker` for `blocker` is neither present nor
  // creatable. A human renames it; nothing here does.
  const classify = (labels: ListedLabel[]) => {
    const exact = new Set(labels.map((l) => l.name));
    const byLower = new Map(labels.map((l) => [l.name.toLowerCase(), l.name]));
    const missing: string[] = [];
    const miscased: string[] = [];
    for (const name of [...wanted.keys()].sort()) {
      if (exact.has(name)) continue;
      const other = byLower.get(name.toLowerCase());
      if (other === undefined) missing.push(name);
      else miscased.push(`'${name}' exists as '${other}'`);
    }
    return { missing, miscased };
  };

  let { missing, miscased } = classify(await visible());
  if (missing.length > 0 && mode === 'create') {
    for (const name of missing) {
      await client.create(name, wanted.get(name) as string);
      lines.push(`created '${name}'`);
    }
    // Verify by reading back, not by trusting the writes.
    ({ missing, miscased } = classify(await visible()));
  }

  if (miscased.length > 0) {
    lines.push(
      `${miscased.length} label(s) on ${team} differ from the registry only in case, and the router matches names exactly: ${miscased.join(', ')}`,
      'Rename them in Linear by hand. They are not created or renamed here, because a label may be on live tickets.',
    );
  }
  if (missing.length > 0) {
    lines.push(
      `${missing.length} label(s) the fleet routes on are missing from ${team}: ${missing.map((m) => `'${m}'`).join(', ')}`,
      mode === 'check'
        ? 'Run the linear-labels workflow with mode=create, or create them by hand from agents/linear-labels.yml.'
        : 'They were created but are still not listed — check the key can write labels.',
    );
  }
  if (missing.length > 0 || miscased.length > 0) return { code: 1, out: lines.join('\n') };
  lines.push(
    mode === 'create' && lines.length === 0
      ? `nothing to create: all ${wanted.size} label(s) already exist on ${team}`
      : `all ${wanted.size} label(s) the fleet routes on exist on ${team}`,
  );
  return { code: 0, out: lines.join('\n') };
}

/** A client over Linear's GraphQL API for one team, by key (`IRS`). */
export function graphqlLabelClient(gql: LinearGraphQL, team: string): LinearLabelClient {
  const run = async (query: string, variables: Record<string, unknown>) => {
    const res = await gql(query, variables);
    if (res.errors && res.errors.length > 0) {
      throw new Error(`linear graphql: ${res.errors.map((e) => e.message).join('; ')}`);
    }
    return res.data as Record<string, unknown>;
  };
  let teamId: string | undefined;
  return {
    async list() {
      // Every label in the workspace, paginated: a team's label list alone omits
      // workspace labels such as the built-in Bug / Feature / Improvement.
      const out: ListedLabel[] = [];
      let after: string | null = null;
      for (;;) {
        const data = await run(
          `query Labels($after: String) {
            issueLabels(first: 250, after: $after) {
              nodes { name team { key } }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { after },
        );
        const page = data.issueLabels as {
          nodes: Array<{ name: string; team: { key: string } | null }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
        out.push(...page.nodes.map((n) => ({ name: n.name, team: n.team?.key })));
        if (!page.pageInfo.hasNextPage) return out;
        after = page.pageInfo.endCursor;
      }
    },
    async create(name, description) {
      if (teamId === undefined) {
        // issueLabelCreate wants the team's UUID; passing the key fails with a
        // generic "Argument Validation Error" that names neither field nor reason.
        const data = await run('query { teams { nodes { id key } } }', {});
        const teams = (data.teams as { nodes: Array<{ id: string; key: string }> }).nodes;
        teamId = teams.find((t) => t.key === team)?.id;
        if (teamId === undefined) throw new Error(`no Linear team with key '${team}'`);
      }
      const data = await run(
        `mutation Create($input: IssueLabelCreateInput!) {
          issueLabelCreate(input: $input) { success }
        }`,
        { input: { teamId, name, description } },
      );
      if (!(data.issueLabelCreate as { success: boolean }).success) {
        throw new Error(`creating label '${name}' on ${team}: Linear reported no success`);
      }
    },
  };
}
