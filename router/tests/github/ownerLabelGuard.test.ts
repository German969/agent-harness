// HAR-21: an `agent:*` owner label that names a different agent from the fleet App
// that opened the PR is spoofed. Routing ignores it, the author App's delivery
// removes it, and #agents-alerts hears about it.

import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type LabelRemover,
  type RemoveLabelArgs,
  buildLabelRemover,
  enforceOwnerLabels,
} from '../../src/github/ownerLabelGuard.js';
import type { WebhookEvent } from '../../src/ingress/types.js';
import { MemoryAlertPoster } from '../../src/observability/index.js';
import {
  type Registry,
  buildRegistry,
  classify,
  spoofedOwnerLabel,
} from '../../src/routing/index.js';
import type { Identity } from '../../src/routing/schema.js';
import type { SecretProvider } from '../../src/secrets/index.js';
import { type Db, applyMigrations, openDb } from '../../src/state/index.js';

const identities: Identity[] = [
  {
    agent: 'harness',
    continuation_timeout_days: 30,
    github: { app_slug: 'harness-bot', app_id: 100, bot_username: 'harness-bot[bot]' },
    linear: { agent_handle: 'harness-bot' },
    secrets: { github_app_private_key: 'GITHUB_APP_PRIVATE_KEY_harness' },
  },
  {
    agent: 'guardian',
    continuation_timeout_days: 30,
    github: { app_slug: 'guardian-bot', app_id: 200, bot_username: 'guardian-bot[bot]' },
    linear: { agent_handle: 'guardian-bot' },
    secrets: { github_app_private_key: 'GITHUB_APP_PRIVATE_KEY_guardian' },
  },
];

const log = pino({ level: 'silent' });
let registry: Registry;
let db: Db;
let alerts: MemoryAlertPoster;
let calls: RemoveLabelArgs[];
let status: number;
const remover: LabelRemover = async (args) => {
  calls.push(args);
  return { status };
};

beforeEach(() => {
  registry = buildRegistry(identities);
  db = openDb({ path: ':memory:' });
  applyMigrations(db);
  alerts = new MemoryAlertPoster();
  calls = [];
  status = 200;
});

/** A PR event as the App with `appId` receives it. */
function prEvent(opts: {
  appId: string;
  author: string;
  labels: string[];
  eventType?: string;
}): WebhookEvent {
  return {
    provider: 'github',
    delivery_id: 'd-1',
    event_type: opts.eventType ?? 'pull_request.labeled',
    agent_hint: opts.appId,
    payload: {
      installation: { id: 777 },
      repository: { full_name: 'German969/dev-team' },
      pull_request: {
        number: 90,
        user: { login: opts.author },
        labels: opts.labels.map((name) => ({ name })),
      },
    },
    received_at: Date.now(),
  };
}

describe('spoofedOwnerLabel', () => {
  it('flags a label naming another agent on a PR another fleet App opened', () => {
    expect(spoofedOwnerLabel(registry, 'agent:harness-bot', 'guardian-bot[bot]')).toEqual({
      label: 'agent:harness-bot',
      claimed: 'harness',
      author: 'guardian',
    });
  });

  it("accepts the author App's own label, by handle or bare id", () => {
    expect(spoofedOwnerLabel(registry, 'agent:harness-bot', 'harness-bot[bot]')).toBeUndefined();
    expect(spoofedOwnerLabel(registry, 'agent:harness', 'harness-bot[bot]')).toBeUndefined();
  });

  it('accepts any owner label on a PR a person opened (the owner relabelling is legitimate)', () => {
    expect(spoofedOwnerLabel(registry, 'agent:harness-bot', 'German969')).toBeUndefined();
  });

  it('accepts any owner label on a PR a third-party bot opened', () => {
    expect(spoofedOwnerLabel(registry, 'agent:guardian', 'dependabot[bot]')).toBeUndefined();
  });

  it('ignores labels that are not owner labels, and a missing author', () => {
    expect(spoofedOwnerLabel(registry, 'router-change', 'guardian-bot[bot]')).toBeUndefined();
    expect(spoofedOwnerLabel(registry, 'agent:harness-bot', undefined)).toBeUndefined();
  });
});

describe('classify ignores a spoofed owner label', () => {
  it("routes the PR's events to the App that opened it, not the label's agent", () => {
    // Guardian opened the PR; someone labelled it agent:harness-bot. Without the
    // check Harness's delivery would take this event.
    const asHarness = classify(
      prEvent({ appId: '100', author: 'guardian-bot[bot]', labels: ['agent:harness-bot'] }),
      { registry, db },
    );
    expect(asHarness).toEqual({ route: 'unmatched', reason: 'github_duplicate_delivery' });

    const asGuardian = classify(
      prEvent({ appId: '200', author: 'guardian-bot[bot]', labels: ['agent:harness-bot'] }),
      { registry, db },
    );
    expect(asGuardian).toMatchObject({ route: 'agent', agent: 'guardian' });
  });

  it('still honours an owner label on a PR a person opened', () => {
    const result = classify(
      prEvent({ appId: '100', author: 'German969', labels: ['agent:harness-bot'] }),
      { registry, db },
    );
    expect(result).toMatchObject({ route: 'agent', agent: 'harness' });
  });
});

describe('enforceOwnerLabels', () => {
  it("removes a spoofed label through the author App's delivery and alerts", async () => {
    const out = await enforceOwnerLabels(
      prEvent({ appId: '200', author: 'guardian-bot[bot]', labels: ['agent:harness-bot', 'bug'] }),
      { registry, log, removeLabel: remover, alertPoster: alerts },
    );

    expect(calls).toEqual([
      {
        agent: 'guardian',
        installationId: 777,
        repo: 'German969/dev-team',
        number: 90,
        label: 'agent:harness-bot',
      },
    ]);
    expect(out).toMatchObject({ kind: 'enforced', results: [{ removed: true }] });
    expect(alerts.messages).toHaveLength(1);
    expect(alerts.messages[0]).toMatchObject({
      title: 'owner_label_spoofed',
      level: 'warn',
      agent: 'guardian',
      fields: { label: 'agent:harness-bot', claimed: 'harness', author: 'guardian', pr: 90 },
    });
  });

  it("does nothing on the other Apps' copies of the same event", async () => {
    const out = await enforceOwnerLabels(
      prEvent({ appId: '100', author: 'guardian-bot[bot]', labels: ['agent:harness-bot'] }),
      { registry, log, removeLabel: remover, alertPoster: alerts },
    );
    expect(out).toEqual({ kind: 'not_author_delivery' });
    expect(calls).toEqual([]);
    expect(alerts.messages).toEqual([]);
  });

  it('leaves legitimate labels alone', async () => {
    for (const event of [
      prEvent({ appId: '200', author: 'guardian-bot[bot]', labels: ['agent:guardian-bot'] }),
      prEvent({ appId: '100', author: 'German969', labels: ['agent:guardian-bot'] }),
    ]) {
      const out = await enforceOwnerLabels(event, {
        registry,
        log,
        removeLabel: remover,
        alertPoster: alerts,
      });
      expect(out).toEqual({ kind: 'none' });
    }
    expect(calls).toEqual([]);
    expect(alerts.messages).toEqual([]);
  });

  it('treats 404 as already removed', async () => {
    status = 404;
    const out = await enforceOwnerLabels(
      prEvent({ appId: '200', author: 'guardian-bot[bot]', labels: ['agent:harness-bot'] }),
      { registry, log, removeLabel: remover, alertPoster: alerts },
    );
    expect(out).toMatchObject({ kind: 'enforced', results: [{ removed: true }] });
  });

  it('still alerts, at error level, when the removal fails', async () => {
    const failing: LabelRemover = async () => {
      throw new Error('auth failed');
    };
    const out = await enforceOwnerLabels(
      prEvent({ appId: '200', author: 'guardian-bot[bot]', labels: ['agent:harness-bot'] }),
      { registry, log, removeLabel: failing, alertPoster: alerts },
    );
    expect(out).toMatchObject({
      kind: 'enforced',
      results: [{ removed: false, detail: 'auth failed' }],
    });
    expect(alerts.messages[0]).toMatchObject({ level: 'error', title: 'owner_label_spoofed' });
    expect(alerts.messages[0]?.body).toContain('could NOT be removed');
  });
});

describe('buildLabelRemover', () => {
  it("mints the author App's token and DELETEs the URL-encoded label", async () => {
    const secrets: SecretProvider = {
      kind: 'env',
      getSecret: async (name) => `pem-for-${name}`,
    } as unknown as SecretProvider;
    const minted: unknown[] = [];
    const deleted: Array<{ url: string; token: string }> = [];
    const remove = buildLabelRemover(registry, secrets, {
      mint: async (req) => {
        minted.push(req);
        return 'ghs_test';
      },
      http: async (url, token) => {
        deleted.push({ url, token });
        return { status: 200 };
      },
    });

    const res = await remove({
      agent: 'guardian',
      installationId: 777,
      repo: 'German969/dev-team',
      number: 90,
      label: 'agent:harness-bot',
    });

    expect(res).toEqual({ status: 200 });
    expect(minted).toEqual([
      { appId: 200, privateKey: 'pem-for-GITHUB_APP_PRIVATE_KEY_guardian', installationId: 777 },
    ]);
    expect(deleted).toEqual([
      {
        url: 'https://api.github.com/repos/German969/dev-team/issues/90/labels/agent%3Aharness-bot',
        token: 'ghs_test',
      },
    ]);
  });
});
