import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Identity, checkCrosspostsDrift, loadIdentities } from '../../src/routing/index.js';
import type { AgentId } from '../../src/types.js';

function mkId(agent: AgentId, primary?: string, crossposts?: Record<string, string>): Identity {
  const channels: { primary?: string[]; crossposts?: Record<string, string> } = {};
  if (primary) channels.primary = [primary];
  if (crossposts) channels.crossposts = crossposts;
  return { agent, continuation_timeout_days: 30, slack: { channels } };
}

describe('checkCrosspostsDrift (unit)', () => {
  it('returns [] when every crosspost matches the agent primary', () => {
    const ids = [
      mkId('harness', '#harness-engineering', {
        strategist: '#engineering',
        guardian: '#security',
      }),
      mkId('strategist', '#engineering'),
      mkId('guardian', '#security'),
    ];
    expect(checkCrosspostsDrift(ids)).toEqual([]);
  });

  it('flags a crosspost channel that diverges from the agent primary', () => {
    const ids = [
      mkId('harness', '#harness-engineering', { strategist: '#planning' }),
      mkId('strategist', '#engineering'),
    ];
    const issues = checkCrosspostsDrift(ids);
    expect(
      issues.some(
        (i) => i.includes('strategist') && i.includes('#planning') && i.includes('#engineering'),
      ),
    ).toBe(true);
  });

  it('flags a crosspost target that is not a loaded agent', () => {
    const ids = [mkId('harness', '#harness-engineering', { ghost: '#nowhere' })];
    expect(
      checkCrosspostsDrift(ids).some(
        (i) => i.includes('ghost') && i.includes('not a loaded agent'),
      ),
    ).toBe(true);
  });

  it('flags an agent with a Slack identity but no crosspost entry', () => {
    const ids = [
      mkId('harness', '#harness-engineering', { strategist: '#engineering' }),
      mkId('strategist', '#engineering'),
      mkId('guardian', '#security'), // has Slack, absent from crossposts
    ];
    expect(
      checkCrosspostsDrift(ids).some(
        (i) => i.includes('guardian') && i.includes('no Harness crosspost entry'),
      ),
    ).toBe(true);
  });
});

describe('crossposts drift — shipped identities', () => {
  it('the real identities/ are currently in sync (guards against future drift)', () => {
    const dir = fileURLToPath(new URL('../../../identities', import.meta.url));
    const { identities } = loadIdentities(dir);
    expect(identities.length).toBeGreaterThan(0);
    expect(checkCrosspostsDrift(identities)).toEqual([]);
  });
});
