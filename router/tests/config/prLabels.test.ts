// HAR-13: the GitHub PR label registry, its agreement with the hooks, and the
// online check. The cross-check runs against the REAL registry and the REAL
// settings.json of every agent, so drift in either fails here as well as in
// validate:fleet.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type LabelClient,
  type LabelSpec,
  MAX_DESCRIPTION,
  REGISTRY_PATH,
  crossCheckLabels,
  declaredPrLabels,
  parseLabelRegistry,
  restLabelClient,
  syncRepoLabels,
} from '../../src/config/prLabels.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const realRegistryText = readFileSync(join(repoRoot, REGISTRY_PATH), 'utf-8');

function realSettings(): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const dir = join(repoRoot, 'agents');
  for (const agent of readdirSync(dir)) {
    if (!statSync(join(dir, agent)).isDirectory()) continue;
    out.set(agent, JSON.parse(readFileSync(join(dir, agent, 'settings.json'), 'utf-8')));
  }
  return out;
}

const spec = (description = 'x'): LabelSpec => ({ color: 'aabbcc', description });

describe('the real registry', () => {
  it('parses cleanly', () => {
    const { registry, problems } = parseLabelRegistry(realRegistryText);
    expect(problems).toEqual([]);
    expect(registry?.get('dev-team')?.size).toBe(6);
  });

  it('agrees with every agent hook, both ways', () => {
    const { registry } = parseLabelRegistry(realRegistryText);
    const declared = declaredPrLabels(realSettings());
    // The six dev-team labels from the ticket, plus the two marketing owner labels.
    expect(new Set(declared.map((d) => d.label)).size).toBe(8);
    expect(crossCheckLabels(declared, registry as never)).toEqual([]);
  });
});

describe('parseLabelRegistry', () => {
  it('rejects bad colours, long or missing descriptions, and unknown keys', () => {
    const long = 'x'.repeat(MAX_DESCRIPTION + 1);
    const { problems } = parseLabelRegistry(`version: 1
repos:
  dev-team:
    a: { color: "#aabbcc", description: ok }
    b: { color: "aabbcc", description: "${long}" }
    c: { color: "aabbcc" }
    d: { color: "aabbcc", description: ok, colour: red }
extra: 1
`);
    expect(problems.join('\n')).toMatch(/'a'.*6 hex digits/);
    expect(problems.join('\n')).toMatch(/'b' description is 101 characters/);
    expect(problems.join('\n')).toMatch(/'c' has no `description`/);
    expect(problems.join('\n')).toMatch(/'d' has unknown key `colour`/);
    expect(problems.join('\n')).toMatch(/unknown top-level key `extra`/);
  });

  it('rejects a missing or empty repos map and a wrong version', () => {
    expect(parseLabelRegistry('version: 2\nrepos: {}\n').problems.join('\n')).toMatch(
      /version.*must be 1[\s\S]*non-empty/,
    );
    expect(parseLabelRegistry('[').problems[0]).toMatch(/could not parse/);
  });
});

describe('declaredPrLabels + crossCheckLabels', () => {
  const settings = new Map<string, unknown>([
    [
      'harness',
      {
        hooks: {
          SessionEnd: [
            {
              command: 'git_commit_if_changed',
              repo: 'dev-team',
              create_pr: true,
              pr_labels: ['agent:harness-bot'],
              auto_apply_conditional_labels: { 'router/**': 'router-change' },
            },
          ],
        },
      },
    ],
    [
      'guardian',
      {
        hooks: {
          SessionEnd: [
            { repo: 'dev-team', create_pr: true, pr_label: 'agent:guardian-bot' },
            // Label fields on a hook that opens no PR reach no PR, so they must not
            // count: a registry entry for 'dead' would otherwise look applied.
            { command: 'git_commit', repo: 'dev-team', pr_label: 'dead' },
            { repo: 'dev-team', create_pr: false, pr_labels: ['also-dead'] },
          ],
        },
      },
    ],
  ]);

  it('reads pr_labels, pr_label and the conditional-label values', () => {
    expect(declaredPrLabels(settings).map((d) => d.label)).toEqual([
      'agent:harness-bot',
      'router-change',
      'agent:guardian-bot',
    ]);
  });

  it('fails a hook label the registry does not list', () => {
    const registry = new Map([['dev-team', new Map([['agent:harness-bot', spec()]])]]);
    const problems = crossCheckLabels(declaredPrLabels(settings), registry);
    expect(problems.join('\n')).toMatch(/harness: .*'router-change' on repo 'dev-team'/);
    expect(problems.join('\n')).toMatch(/guardian: .*'agent:guardian-bot'/);
  });

  it('fails a registry label no hook applies', () => {
    const registry = new Map([
      [
        'dev-team',
        new Map([
          ['agent:harness-bot', spec()],
          ['router-change', spec()],
          ['agent:guardian-bot', spec()],
          ['stale', spec()],
        ]),
      ],
    ]);
    expect(crossCheckLabels(declaredPrLabels(settings), registry)).toEqual([
      expect.stringMatching(/'stale' on 'dev-team' is applied by no agent's PR hook/),
    ]);
  });

  it('keys by repo: the right label on the wrong repo still fails', () => {
    const registry = new Map([
      [
        'other-repo',
        new Map([
          ['agent:harness-bot', spec()],
          ['router-change', spec()],
          ['agent:guardian-bot', spec()],
        ]),
      ],
    ]);
    expect(crossCheckLabels(declaredPrLabels(settings), registry).length).toBe(6);
  });
});

/** An in-memory repo's label list. `dropCreates` simulates a token without write. */
function fakeClient(initial: string[], dropCreates = false) {
  const labels = new Set(initial);
  const created: string[] = [];
  const client: LabelClient = {
    list: async () => [...labels],
    create: async (name) => {
      created.push(name);
      if (!dropCreates) labels.add(name);
    },
  };
  return { client, created };
}

describe('syncRepoLabels', () => {
  const wanted = new Map([
    ['agent:harness-bot', spec()],
    ['urgent', spec()],
  ]);

  it('check: fails naming each missing label, and creates nothing', async () => {
    const { client, created } = fakeClient(['urgent']);
    const r = await syncRepoLabels('o/dev-team', wanted, client, 'check');
    expect(r.code).toBe(1);
    expect(r.out).toContain("'agent:harness-bot'");
    expect(r.out).not.toContain("'urgent'");
    expect(created).toEqual([]);
  });

  it('check: passes when every label exists', async () => {
    const { client } = fakeClient(['agent:harness-bot', 'urgent', 'unrelated']);
    expect((await syncRepoLabels('o/dev-team', wanted, client, 'check')).code).toBe(0);
  });

  it('create: creates only the missing ones, and verifies by re-listing', async () => {
    const { client, created } = fakeClient(['urgent']);
    const r = await syncRepoLabels('o/dev-team', wanted, client, 'create');
    expect(created).toEqual(['agent:harness-bot']);
    expect(r.code).toBe(0);
  });

  it('create: a second run is a no-op', async () => {
    const { client, created } = fakeClient(['agent:harness-bot', 'urgent']);
    const r = await syncRepoLabels('o/dev-team', wanted, client, 'create');
    expect(created).toEqual([]);
    expect(r.code).toBe(0);
  });

  it('create: fails if GitHub still does not list them afterwards', async () => {
    const { client } = fakeClient([], true);
    const r = await syncRepoLabels('o/dev-team', wanted, client, 'create');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/still not listed/);
  });
});

describe('restLabelClient', () => {
  it('pages past 100 labels', async () => {
    const pages = [Array.from({ length: 100 }, (_, i) => ({ name: `l${i}` })), [{ name: 'last' }]];
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      return new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200 });
    }) as unknown as typeof fetch;
    const names = await restLabelClient('o', 'r', 't', fetchFn).list();
    expect(names).toHaveLength(101);
    expect(urls).toHaveLength(2);
  });

  it('throws on an HTTP error rather than reporting an empty repo', async () => {
    const fetchFn = (async () => new Response('', { status: 403 })) as unknown as typeof fetch;
    await expect(restLabelClient('o', 'r', 't', fetchFn).list()).rejects.toThrow(/HTTP 403/);
  });

  it('posts name, colour and description when creating', async () => {
    let body: unknown;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response('{}', { status: 201 });
    }) as unknown as typeof fetch;
    await restLabelClient('o', 'r', 't', fetchFn).create('urgent', {
      color: 'b60205',
      description: 'd',
    });
    expect(body).toEqual({ name: 'urgent', color: 'b60205', description: 'd' });
  });
});
