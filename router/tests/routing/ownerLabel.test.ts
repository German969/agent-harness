// HAR-13: the owner labels the agents' own PR hooks apply must resolve to that agent.
//
// Until HAR-13 none did. The hooks apply the handle form (`agent:harness-bot`,
// `agent:guardian-bot`, `agent:client-bot`, `agent:marketer-bot`) and the lookup
// knew only bare agent ids, so every configured owner label was ignored. These
// tests read the REAL identity files and the REAL settings.json hooks, so a label
// renamed in either place without the other fails here.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildRegistry, loadIdentities, ownerFromLabel } from '../../src/routing/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { identities, errors } = loadIdentities(join(repoRoot, 'identities'));
const registry = buildRegistry(identities);

/** Every `agent:*` label an agent's settings.json hooks apply, keyed by that agent. */
function configuredOwnerLabels(): Array<{ agent: string; label: string }> {
  const out: Array<{ agent: string; label: string }> = [];
  for (const agent of readdirSync(join(repoRoot, 'agents'), { withFileTypes: true })) {
    if (!agent.isDirectory()) continue;
    let settings: { hooks?: Record<string, Array<Record<string, unknown>>> };
    try {
      settings = JSON.parse(
        readFileSync(join(repoRoot, 'agents', agent.name, 'settings.json'), 'utf8'),
      );
    } catch {
      continue;
    }
    for (const hooks of Object.values(settings.hooks ?? {})) {
      for (const hook of hooks) {
        const labels = [
          ...(Array.isArray(hook.pr_labels) ? (hook.pr_labels as string[]) : []),
          ...(typeof hook.pr_label === 'string' ? [hook.pr_label] : []),
        ];
        for (const label of labels) {
          if (label.startsWith('agent:')) out.push({ agent: agent.name, label });
        }
      }
    }
  }
  return out;
}

describe('ownerFromLabel', () => {
  it('loads every identity file', () => {
    expect(errors).toEqual([]);
    expect(identities.length).toBe(7);
  });

  it.each(identities.map((id) => [id.agent, id.linear?.agent_handle] as const))(
    '%s: agent:<agent_handle> resolves to it',
    (agent, handle) => {
      expect(handle, `${agent} has no linear.agent_handle`).toBeTruthy();
      expect(ownerFromLabel(registry, `agent:${handle}`)).toBe(agent);
    },
  );

  it.each(identities.map((id) => [id.agent] as const))(
    '%s: the bare agent id still resolves',
    (agent) => {
      expect(ownerFromLabel(registry, `agent:${agent}`)).toBe(agent);
    },
  );

  it('every owner label a PR hook applies resolves to the agent that applies it', () => {
    const configured = configuredOwnerLabels();
    // Four agents open PRs with an owner label today. Without this floor, the loop
    // below would pass vacuously if the hook config stopped being found.
    expect(configured.length).toBeGreaterThanOrEqual(4);
    for (const { agent, label } of configured) {
      expect(ownerFromLabel(registry, label), `${agent} applies ${label}`).toBe(agent);
    }
  });

  it('does not strip -bot: agent:client resolves to nothing', () => {
    // Builder-Client's handle is `client-bot`; `client` is neither an id nor a handle.
    expect(ownerFromLabel(registry, 'agent:client')).toBeUndefined();
    expect(ownerFromLabel(registry, 'agent:client-bot')).toBe('builder-client');
  });

  it('rejects labels that are not owner labels', () => {
    for (const label of [
      'agent:',
      'agent:  ',
      'agent:nobody-bot',
      'guardian-bot',
      'router-change',
      'Agent:guardian',
    ]) {
      expect(ownerFromLabel(registry, label), label).toBeUndefined();
    }
  });

  it('tolerates whitespace around the name, as the old lookup did', () => {
    expect(ownerFromLabel(registry, 'agent: guardian-bot ')).toBe('guardian');
  });
});
