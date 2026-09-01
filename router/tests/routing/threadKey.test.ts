import { describe, expect, it } from 'vitest';
import type { WebhookEvent } from '../../src/ingress/types.js';
import { buildThreadKey } from '../../src/routing/index.js';

function ev(payload: unknown): WebhookEvent {
  return {
    provider: 'github',
    delivery_id: 'd',
    event_type: 'x',
    agent_hint: 'y',
    payload,
    received_at: 0,
  };
}

describe('buildThreadKey — Slack', () => {
  const slack = (payload: unknown): WebhookEvent => ({ ...ev(payload), provider: 'slack' });

  it('top-level message → slack:channel/ts', () => {
    const key = buildThreadKey(slack({ event: { channel: 'C123', ts: '1700000000.100' } }));
    expect(key).toBe('slack:C123/1700000000.100');
  });

  it('reply-in-thread → slack:channel/thread_ts', () => {
    const key = buildThreadKey(
      slack({ event: { channel: 'C123', ts: '1700000000.200', thread_ts: '1700000000.100' } }),
    );
    expect(key).toBe('slack:C123/1700000000.100');
  });

  it('missing channel → undefined', () => {
    expect(buildThreadKey(slack({ event: {} }))).toBeUndefined();
  });
});

describe('buildThreadKey — Linear', () => {
  const linear = (payload: unknown): WebhookEvent => ({ ...ev(payload), provider: 'linear' });

  it('direct issue event → linear:ENG-1234', () => {
    const key = buildThreadKey(linear({ data: { identifier: 'ENG-1234' } }));
    expect(key).toBe('linear:ENG-1234');
  });

  it('comment event → linear:<issue.identifier>', () => {
    const key = buildThreadKey(
      linear({ data: { issue: { identifier: 'ENG-5678' }, body: 'comment' } }),
    );
    expect(key).toBe('linear:ENG-5678');
  });

  it('missing identifier → undefined', () => {
    expect(buildThreadKey(linear({ data: {} }))).toBeUndefined();
  });
});

describe('buildThreadKey — GitHub', () => {
  it('PR event → github:<repo>/pr/<number>', () => {
    const key = buildThreadKey(
      ev({ repository: { full_name: 'org/repo' }, pull_request: { number: 42 } }),
    );
    expect(key).toBe('github:org/repo/pr/42');
  });

  it('issue event → github:<repo>/issue/<number>', () => {
    const key = buildThreadKey(ev({ repository: { full_name: 'org/repo' }, issue: { number: 7 } }));
    expect(key).toBe('github:org/repo/issue/7');
  });

  it('issue_comment on a PR → github:<repo>/pr/<number>', () => {
    const key = buildThreadKey(
      ev({
        repository: { full_name: 'org/repo' },
        issue: { number: 42, pull_request: { url: 'x' } },
      }),
    );
    expect(key).toBe('github:org/repo/pr/42');
  });

  it('missing repo → undefined', () => {
    expect(buildThreadKey(ev({}))).toBeUndefined();
  });

  // A CI payload names no `pull_request` node — it lists the PRs it ran against.
  // Without this the event fell to a bare repo key and continued whatever session
  // was last seen anywhere in the repo.
  it('workflow_run → the PR it ran against', () => {
    const key = buildThreadKey(
      ev({
        repository: { full_name: 'org/repo' },
        workflow_run: { pull_requests: [{ number: 42 }] },
      }),
    );
    expect(key).toBe('github:org/repo/pr/42');
  });

  it('check_suite and check_run resolve the same way', () => {
    const repository = { full_name: 'org/repo' };
    expect(
      buildThreadKey(ev({ repository, check_suite: { pull_requests: [{ number: 9 }] } })),
    ).toBe('github:org/repo/pr/9');
    expect(buildThreadKey(ev({ repository, check_run: { pull_requests: [{ number: 9 }] } }))).toBe(
      'github:org/repo/pr/9',
    );
  });

  // The defect: `github:<repo>` is not a thread, it is every event in the repo
  // sharing one key, so findContinuation linked unrelated work (281 continued 206
  // that way). No key at all is strictly better than one that cannot be right.
  it('no task scope → undefined, never a bare repo key', () => {
    expect(buildThreadKey(ev({ repository: { full_name: 'org/repo' } }))).toBeUndefined();
    expect(
      buildThreadKey(ev({ repository: { full_name: 'org/repo' }, workflow_run: {} })),
    ).toBeUndefined();
    expect(
      buildThreadKey(
        ev({ repository: { full_name: 'org/repo' }, workflow_run: { pull_requests: [] } }),
      ),
    ).toBeUndefined();
  });
});
