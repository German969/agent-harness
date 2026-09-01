import { describe, expect, it } from 'vitest';
import { normalizeGithub } from '../../src/ingress/normalize/github.js';
import { normalizeLinear } from '../../src/ingress/normalize/linear.js';
import { normalizeSlackEvent } from '../../src/ingress/normalize/slack.js';

describe('normalizeGithub', () => {
  it('extracts delivery_id, event_type (with action), app_id', () => {
    const body = Buffer.from(
      JSON.stringify({
        action: 'opened',
        pull_request: { number: 42 },
        installation: { id: 12345, app_id: 999 },
      }),
    );
    const event = normalizeGithub(body, {
      'x-github-delivery': 'del-abc-123',
      'x-github-event': 'pull_request',
    });
    expect(event).toMatchObject({
      provider: 'github',
      delivery_id: 'del-abc-123',
      event_type: 'pull_request.opened',
      agent_hint: '999',
    });
    expect(event.payload).toMatchObject({ pull_request: { number: 42 } });
  });

  it('falls back to header for app_id when payload lacks it', () => {
    const body = Buffer.from(JSON.stringify({ action: 'push' }));
    const event = normalizeGithub(body, {
      'x-github-delivery': 'del-2',
      'x-github-event': 'push',
      'x-github-hook-installation-target-id': '888',
    });
    expect(event.agent_hint).toBe('888');
  });

  it("returns 'unknown' when no app_id can be found", () => {
    const body = Buffer.from(JSON.stringify({}));
    const event = normalizeGithub(body, {
      'x-github-delivery': 'del-3',
      'x-github-event': 'ping',
    });
    expect(event.agent_hint).toBe('unknown');
  });

  it('handles no-action events (event_type = event name only)', () => {
    const body = Buffer.from(JSON.stringify({ zen: 'wisdom' }));
    const event = normalizeGithub(body, {
      'x-github-delivery': 'del-4',
      'x-github-event': 'ping',
    });
    expect(event.event_type).toBe('ping');
  });

  it('throws when required headers are missing', () => {
    const body = Buffer.from('{}');
    expect(() => normalizeGithub(body, {})).toThrow('missing_x_github_delivery');
  });

  it('throws when body is not JSON', () => {
    expect(() =>
      normalizeGithub(Buffer.from('not json'), {
        'x-github-delivery': 'x',
        'x-github-event': 'ping',
      }),
    ).toThrow('body_not_json');
  });
});

describe('normalizeLinear', () => {
  const linearBody = (over: Record<string, unknown> = {}) =>
    Buffer.from(
      JSON.stringify({
        webhookId: 'wh-abc-123',
        webhookTimestamp: 1700000000000,
        type: 'Issue',
        action: 'create',
        data: { id: 'issue-1', title: 'test' },
        ...over,
      }),
    );

  it('keeps webhookId as the agent hint and builds type.action', () => {
    const event = normalizeLinear(linearBody(), {});
    expect(event).toMatchObject({
      provider: 'linear',
      event_type: 'Issue.create',
      // The hint identifies WHICH WEBHOOK signed this, so ingress can pick the secret.
      agent_hint: 'wh-abc-123',
    });
  });

  it('prefers the per-delivery Linear-Delivery header as delivery_id', () => {
    const event = normalizeLinear(linearBody(), { 'linear-delivery': 'del-999' });
    expect(event.delivery_id).toBe('del-999');
  });

  // The bug this replaces: delivery_id WAS webhookId, which is stable per webhook.
  // The second delivery collided in webhook_deliveries and was dropped as a duplicate,
  // so the whole Linear surface worked exactly once.
  it('gives two deliveries from the same webhook distinct delivery_ids', () => {
    const first = normalizeLinear(linearBody(), {});
    const second = normalizeLinear(
      linearBody({ webhookTimestamp: 1700000000001, data: { id: 'issue-2' } }),
      {},
    );

    expect(first.agent_hint).toBe(second.agent_hint); // same webhook
    expect(first.delivery_id).not.toBe(second.delivery_id); // different delivery
    expect(first.delivery_id).not.toBe('wh-abc-123');
  });

  it('distinguishes two events emitted in the same millisecond', () => {
    const ts = 1700000000000;
    const a = normalizeLinear(linearBody({ webhookTimestamp: ts, data: { id: 'x' } }), {});
    const b = normalizeLinear(linearBody({ webhookTimestamp: ts, data: { id: 'y' } }), {});
    expect(a.delivery_id).not.toBe(b.delivery_id);
  });

  it('still yields a usable id when timestamp and entity id are absent', () => {
    const event = normalizeLinear(
      Buffer.from(JSON.stringify({ webhookId: 'wh-1', type: 'Issue', action: 'create' })),
      {},
    );
    expect(event.delivery_id).toContain('wh-1');
    expect(event.delivery_id).not.toBe('wh-1');
  });

  it('throws when webhookId is missing', () => {
    const body = Buffer.from(JSON.stringify({ type: 'Issue', action: 'create' }));
    expect(() => normalizeLinear(body, {})).toThrow('missing_webhookId');
  });
});

describe('normalizeSlackEvent', () => {
  it('extracts event_id, api_app_id, nested event.type', () => {
    const body = Buffer.from(
      JSON.stringify({
        token: 'xxx',
        team_id: 'T012',
        api_app_id: 'A0999',
        event: { type: 'app_mention', user: 'U01', text: '<@BOT> hi' },
        event_id: 'Ev-abc-1',
        event_time: 1700_000_000,
      }),
    );
    const event = normalizeSlackEvent(body, {});
    expect(event).toMatchObject({
      provider: 'slack',
      delivery_id: 'Ev-abc-1',
      event_type: 'app_mention',
      agent_hint: 'A0999',
    });
  });

  it('throws when event_id is missing', () => {
    const body = Buffer.from(JSON.stringify({ api_app_id: 'A0', event: { type: 'x' } }));
    expect(() => normalizeSlackEvent(body, {})).toThrow('missing_event_id');
  });
});
