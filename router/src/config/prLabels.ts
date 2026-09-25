// The GitHub PR label registry: agents/github-pr-labels.yml (HAR-13).
//
// The labels a router-opened PR gets are declared in each agent's create_pr hook
// (`pr_labels`, `pr_label`, and the values of `auto_apply_conditional_labels`), and
// until HAR-13 none of the six targeting dev-team existed on the repo. GitHub does
// not create a label on first use from the REST call the router makes, so an owner
// label that is not there is an owner label the PR never gets.
//
// The registry is the sidecar that carries what the hooks cannot: each label's
// description and colour, which the `--create` mode needs. Owner decision on HAR-8:
// descriptions live in a separate file, not in the identity or settings schema.
//
// Two checks, split by what they need:
//   - offline (validate:fleet): the registry and the hooks agree, both ways. A label a
//     hook applies with no registry entry cannot be created; a registry entry no hook
//     applies is the next PROTOCOLS §5 — a second list that drifts (HAR-19).
//   - online (scripts/github-labels.ts, in the github-labels workflow): every registry
//     label for the repo the workflow runs in exists on GitHub. `--create` adds the
//     missing ones and never edits or deletes an existing label, which may already be
//     on live PRs.
//
// Lives in src/ because tsconfig and biome do not cover scripts/.

import { load } from 'js-yaml';

export const REGISTRY_PATH = 'agents/github-pr-labels.yml';

/** GitHub's own limits: colour is 6 hex digits without `#`; description ≤ 100 chars. */
const COLOR = /^[0-9a-f]{6}$/i;
export const MAX_DESCRIPTION = 100;

export type LabelSpec = { color: string; description: string };
/** repo name → label name → spec. */
export type LabelRegistry = Map<string, Map<string, LabelSpec>>;

/** One label one agent's hook applies, and the repo that hook opens PRs on. */
export type DeclaredLabel = { agent: string; repo: string; label: string };

/** Parse and shape-check the registry. `registry` is undefined when it is unusable. */
export function parseLabelRegistry(text: string): {
  registry?: LabelRegistry;
  problems: string[];
} {
  const problems: string[] = [];
  const at = (msg: string) => problems.push(`${REGISTRY_PATH}: ${msg}`);

  let doc: unknown;
  try {
    doc = load(text);
  } catch (err) {
    return { problems: [`${REGISTRY_PATH}: could not parse — ${(err as Error).message}`] };
  }
  if (!isRecord(doc)) return { problems: [`${REGISTRY_PATH}: top level must be a mapping`] };
  for (const key of Object.keys(doc)) {
    if (key !== 'version' && key !== 'repos') at(`unknown top-level key \`${key}\``);
  }
  if (doc.version !== 1) at('`version` must be 1');
  if (!isRecord(doc.repos) || Object.keys(doc.repos).length === 0) {
    at('`repos` must be a non-empty mapping of repo name → labels');
    return { problems };
  }

  const registry: LabelRegistry = new Map();
  for (const [repo, labels] of Object.entries(doc.repos)) {
    if (!isRecord(labels) || Object.keys(labels).length === 0) {
      at(`repo '${repo}' must map to a non-empty mapping of label → { color, description }`);
      continue;
    }
    const specs = new Map<string, LabelSpec>();
    for (const [label, raw] of Object.entries(labels)) {
      const where = `'${repo}' → '${label}'`;
      if (!isRecord(raw)) {
        at(`${where} must be a mapping with \`color\` and \`description\``);
        continue;
      }
      for (const key of Object.keys(raw)) {
        if (key !== 'color' && key !== 'description') at(`${where} has unknown key \`${key}\``);
      }
      const { color, description } = raw;
      if (typeof color !== 'string' || !COLOR.test(color)) {
        at(`${where} needs \`color\` as 6 hex digits without '#' (quote it in YAML)`);
      }
      if (typeof description !== 'string' || description.trim() === '') {
        at(`${where} has no \`description\``);
      } else if (description.length > MAX_DESCRIPTION) {
        at(
          `${where} description is ${description.length} characters; GitHub rejects more than ${MAX_DESCRIPTION}`,
        );
      }
      if (typeof color === 'string' && typeof description === 'string') {
        specs.set(label, { color, description });
      }
    }
    registry.set(repo, specs);
  }
  return { registry, problems };
}

/**
 * Every label an agent's PR hooks apply. `settingsByAgent` is each agent's parsed
 * settings.json. Only hooks with `create_pr: true` count: that is the only shape
 * `git_commit_if_changed` reads labels from, so a label field anywhere else reaches
 * no PR and must not make the cross-check pass. Every event is scanned, not just
 * SessionEnd, so a PR hook moved to another event is still seen.
 */
export function declaredPrLabels(settingsByAgent: ReadonlyMap<string, unknown>): DeclaredLabel[] {
  const out: DeclaredLabel[] = [];
  for (const [agent, settings] of settingsByAgent) {
    const hooks = isRecord(settings) && isRecord(settings.hooks) ? settings.hooks : {};
    for (const entries of Object.values(hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const hook of entries) {
        if (!isRecord(hook) || hook.create_pr !== true) continue;
        const labels = [
          ...(Array.isArray(hook.pr_labels) ? hook.pr_labels : []),
          ...(hook.pr_label !== undefined ? [hook.pr_label] : []),
          ...(isRecord(hook.auto_apply_conditional_labels)
            ? Object.values(hook.auto_apply_conditional_labels)
            : []),
        ].filter((l): l is string => typeof l === 'string');
        if (labels.length === 0) continue;
        const repo = typeof hook.repo === 'string' ? hook.repo : '(no repo)';
        for (const label of labels) out.push({ agent, repo, label });
      }
    }
  }
  return out;
}

/** The offline check: hooks and registry agree in both directions. */
export function crossCheckLabels(declared: DeclaredLabel[], registry: LabelRegistry): string[] {
  const problems: string[] = [];
  const used = new Set<string>();
  for (const { agent, repo, label } of declared) {
    used.add(`${repo}\0${label}`);
    if (!registry.get(repo)?.has(label)) {
      problems.push(
        `${agent}: its PR hook applies '${label}' on repo '${repo}', which ${REGISTRY_PATH} does not list — nothing can create it`,
      );
    }
  }
  for (const [repo, labels] of registry) {
    for (const label of labels.keys()) {
      if (!used.has(`${repo}\0${label}`)) {
        problems.push(
          `${REGISTRY_PATH}: '${label}' on '${repo}' is applied by no agent's PR hook — remove it, or it drifts like PROTOCOLS §5 (HAR-19)`,
        );
      }
    }
  }
  return problems;
}

/** The subset of the GitHub labels API the online check needs. */
export type LabelClient = {
  list(): Promise<string[]>;
  create(name: string, spec: LabelSpec): Promise<void>;
};

/**
 * The online check for one repo. `mode: 'check'` reports missing labels; `'create'`
 * creates them and then re-lists, so success means GitHub now has them — not that
 * the create calls returned. Never edits or deletes an existing label.
 */
export async function syncRepoLabels(
  repo: string,
  wanted: ReadonlyMap<string, LabelSpec>,
  client: LabelClient,
  mode: 'check' | 'create',
): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const existing = new Set(await client.list());
  let missing = [...wanted.keys()].filter((name) => !existing.has(name)).sort();

  if (missing.length > 0 && mode === 'create') {
    for (const name of missing) {
      await client.create(name, wanted.get(name) as LabelSpec);
      lines.push(`created '${name}'`);
    }
    const after = new Set(await client.list());
    missing = missing.filter((name) => !after.has(name));
  }

  if (missing.length > 0) {
    lines.push(
      `${missing.length} label(s) the agents apply are missing from ${repo}: ${missing.map((m) => `'${m}'`).join(', ')}`,
      mode === 'check'
        ? 'Run the github-labels workflow with mode=create, or create them by hand from agents/github-pr-labels.yml.'
        : 'They were created but are still not listed — check the token has issues: write.',
    );
    return { code: 1, out: lines.join('\n') };
  }
  lines.push(`all ${wanted.size} label(s) the agents apply exist on ${repo}`);
  return { code: 0, out: lines.join('\n') };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A `LabelClient` over the GitHub REST API. `fetchFn` is injectable so the paging
 * and error handling are tested without a network. Lists 100 per page until a short
 * page, because a repo past 30 labels would otherwise look like it is missing some.
 */
export function restLabelClient(
  owner: string,
  repo: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): LabelClient {
  const base = `https://api.github.com/repos/${owner}/${repo}/labels`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  return {
    async list() {
      const names: string[] = [];
      for (let page = 1; ; page++) {
        const res = await fetchFn(`${base}?per_page=100&page=${page}`, { headers });
        if (!res.ok) throw new Error(`listing labels on ${owner}/${repo}: HTTP ${res.status}`);
        const batch = (await res.json()) as Array<{ name: string }>;
        names.push(...batch.map((l) => l.name));
        if (batch.length < 100) return names;
      }
    },
    async create(name, spec) {
      const res = await fetchFn(base, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ name, color: spec.color, description: spec.description }),
      });
      if (!res.ok) {
        throw new Error(`creating label '${name}' on ${owner}/${repo}: HTTP ${res.status}`);
      }
    },
  };
}
