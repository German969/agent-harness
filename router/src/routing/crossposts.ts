// Cross-identity consistency: Harness's `slack.channels.crossposts` map DUPLICATES
// each agent's own `slack.channels.primary`. Harness crossposts a heads-up to an
// affected agent's primary channel; if that agent later moves its primary and this
// map isn't updated, the heads-up silently lands in the wrong channel. There is no
// CI test gate on identity edits, so this runs at router boot and logs any drift it
// finds — turning a silent stale map into a visible warning in `logs router`.

import type { Identity } from './schema.js';

/**
 * Return a list of human-readable drift issues between Harness's crossposts map and
 * the loaded agent identities. Empty array = in sync. Never throws — a stale map is
 * a warning, not a boot failure.
 */
export function checkCrosspostsDrift(identities: readonly Identity[]): string[] {
  const primary = new Map<string, string | undefined>();
  for (const id of identities) primary.set(id.agent, id.slack?.channels?.primary?.[0]);

  const harness = identities.find((i) => i.agent === 'harness');
  const crossposts = harness?.slack?.channels?.crossposts;
  if (!crossposts) return [];

  const issues: string[] = [];

  // Every crosspost target must be a known agent, and its channel must equal that
  // agent's own primary channel (the single source of truth).
  for (const [agent, channel] of Object.entries(crossposts)) {
    if (!primary.has(agent)) {
      issues.push(`crosspost target "${agent}" is not a loaded agent identity`);
      continue;
    }
    const prim = primary.get(agent);
    if (prim === undefined) {
      issues.push(`crosspost target "${agent}" has no primary Slack channel to compare against`);
    } else if (prim !== channel) {
      issues.push(`crosspost for "${agent}" is "${channel}" but its identity primary is "${prim}"`);
    }
  }

  // Any agent with a Slack identity but no crosspost entry would never receive a
  // Harness heads-up — flag it so a newly added agent isn't silently skipped.
  for (const id of identities) {
    if (id.agent === 'harness') continue;
    if (id.slack && !(id.agent in crossposts)) {
      issues.push(`agent "${id.agent}" has a Slack identity but no Harness crosspost entry`);
    }
  }

  return issues;
}
