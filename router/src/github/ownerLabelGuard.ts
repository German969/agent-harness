// Owner-label spoofing defence (HAR-21, router/ARCHITECTURE.md "PR spoofing defense").
//
// An `agent:<name>` label decides which agent a PR's events route to, and since
// HAR-13 the handle form (`agent:harness-bot`) really resolves. The classifier
// already refuses to route on a spoofed label (`spoofedOwnerLabel`); this module
// is the visible half: it takes the label off the PR and tells #agents-alerts.
//
// GitHub fans every PR event out to every installed App, so without a gate each
// App's delivery would try the same removal and post the same alert. Only the
// delivery to the App that OPENED the PR acts. That App can always edit labels on
// its own PR, and the payload's `installation.id` is its installation, so the
// token it mints is scoped to exactly this repository.
//
// The HTTP and secret surfaces are injectable, as in pullRequest.ts, so tests run
// the real decision and request shapes without a network.

import type { Logger } from 'pino';
import { mintInstallationToken } from '../auth/github-app.js';
import type { WebhookEvent } from '../ingress/types.js';
import type { AlertPoster } from '../observability/index.js';
import { type Registry, type SpoofedOwnerLabel, findSpoofedOwnerLabels } from '../routing/index.js';
import type { SecretProvider } from '../secrets/index.js';
import type { AgentId } from '../types.js';

export type RemoveLabelArgs = {
  /** The agent whose App removes the label: the PR's author. */
  agent: AgentId;
  installationId: number;
  /** `owner/name`. */
  repo: string;
  number: number;
  label: string;
};

/** Remove one label. Resolves with the HTTP status; rejects only on a transport
 *  or auth failure. */
export type LabelRemover = (args: RemoveLabelArgs) => Promise<{ status: number }>;

export type OwnerLabelGuardDeps = {
  registry: Registry;
  log: Logger;
  removeLabel?: LabelRemover | undefined;
  alertPoster?: AlertPoster | undefined;
};

export type OwnerLabelGuardOutcome =
  | { kind: 'none' }
  /** Spoofed labels exist, but this delivery is not the author App's. */
  | { kind: 'not_author_delivery' }
  | {
      kind: 'enforced';
      repo: string;
      number: number;
      results: Array<SpoofedOwnerLabel & { removed: boolean; detail: string }>;
    };

/**
 * Remove every spoofed owner label on this event's PR and alert once per label.
 * Never throws: a failed removal or alert is logged and reported in the outcome,
 * and the event still goes on to classification, which ignores the label anyway.
 */
export async function enforceOwnerLabels(
  event: WebhookEvent,
  deps: OwnerLabelGuardDeps,
): Promise<OwnerLabelGuardOutcome> {
  const found = findSpoofedOwnerLabels(deps.registry, event);
  if (!found) return { kind: 'none' };

  const deliveredTo = deps.registry.githubByAppId.get(event.agent_hint);
  const author = found.spoofed[0]?.author;
  if (!deliveredTo || deliveredTo !== author) return { kind: 'not_author_delivery' };

  const installationId = readInstallationId(event.payload);
  const results: Array<SpoofedOwnerLabel & { removed: boolean; detail: string }> = [];

  for (const hit of found.spoofed) {
    const { removed, detail } = await removeOne(deps, hit, found, installationId);
    results.push({ ...hit, removed, detail });
    await postSpoofAlert(deps, event, found, hit, removed, detail);
  }

  deps.log.warn(
    { repo: found.repo, number: found.number, results },
    'spoofed agent owner label on a PR',
  );
  return { kind: 'enforced', repo: found.repo, number: found.number, results };
}

async function removeOne(
  deps: OwnerLabelGuardDeps,
  hit: SpoofedOwnerLabel,
  pr: { repo: string; number: number },
  installationId: number | undefined,
): Promise<{ removed: boolean; detail: string }> {
  if (!deps.removeLabel) return { removed: false, detail: 'no label remover configured' };
  if (installationId === undefined) {
    return { removed: false, detail: 'event carries no installation id' };
  }
  try {
    const { status } = await deps.removeLabel({
      agent: hit.author,
      installationId,
      repo: pr.repo,
      number: pr.number,
      label: hit.label,
    });
    // 404: the label is already off the PR (an earlier event removed it, or a
    // person did). That is the state we want.
    if ((status >= 200 && status < 300) || status === 404) {
      return { removed: true, detail: `HTTP ${status}` };
    }
    return { removed: false, detail: `HTTP ${status}` };
  } catch (err) {
    return { removed: false, detail: (err as Error).message };
  }
}

async function postSpoofAlert(
  deps: OwnerLabelGuardDeps,
  event: WebhookEvent,
  pr: { repo: string; number: number },
  hit: SpoofedOwnerLabel,
  removed: boolean,
  detail: string,
): Promise<void> {
  if (!deps.alertPoster) return;
  const identity = deps.registry.byAgent.get(hit.author);
  const what = `${pr.repo}#${pr.number} was opened by ${hit.author} but carried ${hit.label}, which names ${hit.claimed}.`;
  const outcome = removed
    ? 'The label was removed.'
    : `The label could NOT be removed (${detail}); remove it by hand.`;
  const routing = `Routing ignores it either way, so the PR's events stay with ${hit.author}.`;
  try {
    await deps.alertPoster.post({
      agent: hit.author,
      channel: identity?.slack?.channels?.alerts ?? '#agents-alerts',
      level: removed ? 'warn' : 'error',
      title: 'owner_label_spoofed',
      body: `${what} ${outcome} ${routing}`,
      fields: {
        repo: pr.repo,
        pr: pr.number,
        label: hit.label,
        claimed: hit.claimed,
        author: hit.author,
        event_type: event.event_type,
        delivery_id: event.delivery_id,
      },
    });
  } catch (err) {
    deps.log.error(
      { repo: pr.repo, number: pr.number, err: (err as Error).message },
      'owner_label_spoofed alert failed to post',
    );
  }
}

function readInstallationId(payload: unknown): number | undefined {
  const id = (payload as { installation?: { id?: unknown } } | undefined)?.installation?.id;
  return typeof id === 'number' ? id : undefined;
}

/** Minimal injectable HTTP surface for the default remover. */
export type DeleteHttp = (url: string, token: string) => Promise<{ status: number }>;

/**
 * The production remover: resolve the author App's private key from its identity's
 * `secrets:` block, mint an installation token, and DELETE the label.
 */
export function buildLabelRemover(
  registry: Registry,
  secretProvider: SecretProvider,
  opts: { baseUrl?: string; http?: DeleteHttp; mint?: typeof mintInstallationToken } = {},
): LabelRemover {
  const baseUrl = opts.baseUrl ?? 'https://api.github.com';
  const http = opts.http ?? defaultDelete;
  const mint = opts.mint ?? mintInstallationToken;
  return async ({ agent, installationId, repo, number, label }) => {
    const identity = registry.byAgent.get(agent);
    const rawAppId = identity?.github?.app_id;
    const appId = typeof rawAppId === 'number' ? rawAppId : Number(rawAppId);
    if (!Number.isFinite(appId)) throw new Error(`${agent} has no numeric github.app_id`);
    const keyRef = identity?.secrets?.github_app_private_key;
    if (!keyRef) throw new Error(`${agent} has no github_app_private_key secret`);
    const privateKey = await secretProvider.getSecret(keyRef);
    const token = await mint({ appId, privateKey, installationId });
    const url = `${baseUrl}/repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`;
    return http(url, token);
  };
}

const defaultDelete: DeleteHttp = async (url, token) => {
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  return { status: res.status };
};
