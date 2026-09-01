import { createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventQueue } from '../../src/ingress/queue.js';
import { registerIngressRoutes } from '../../src/ingress/routes.js';
import type { SecretLookup, WebhookEvent } from '../../src/ingress/types.js';
import { renderFooter } from '../../src/reply/footer.js';
import { type Db, applyMigrations, openDb } from '../../src/state/index.js';

// ---------------------------------------------------------------------------
// Test rig: fresh server + fresh DB + fresh queue per test
// ---------------------------------------------------------------------------
type Rig = {
  server: FastifyInstance;
  db: Db;
  queue: EventQueue;
  captured: WebhookEvent[];
};

async function buildRig(secret: string, agent: string, agentHint = '999'): Promise<Rig> {
  const db = openDb({ path: ':memory:' });
  applyMigrations(db);

  const queue = new EventQueue();
  const captured: WebhookEvent[] = [];
  queue.onEvent(async (e) => {
    captured.push(e);
  });

  const resolveSecret: SecretLookup = async ({ agent_hint }) => {
    if (agent_hint === agentHint) return { found: true, agent, webhook_secret: secret };
    return { found: false, reason: 'no_match' };
  };

  const server = Fastify({ logger: false });
  await registerIngressRoutes(server, { db, queue, resolveSecret });
  await server.ready();

  return { server, db, queue, captured };
}

// ---------------------------------------------------------------------------
// GitHub route
// ---------------------------------------------------------------------------
describe('POST /webhooks/github', () => {
  const secret = 'gh-secret';
  let rig: Rig;

  beforeEach(async () => {
    rig = await buildRig(secret, 'guardian', '999');
  });
  afterEach(async () => {
    await rig.server.close();
  });

  function ghSign(body: string): string {
    return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  }

  it('accepts a valid signed webhook (202 queued)', async () => {
    const body = JSON.stringify({
      action: 'opened',
      installation: { app_id: 999 },
    });
    const res = await rig.server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'gh-del-1',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': ghSign(body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ queued: true, delivery_id: 'gh-del-1' });

    await new Promise((r) => setImmediate(r));
    expect(rig.captured).toHaveLength(1);
    expect(rig.captured[0]?.event_type).toBe('pull_request.opened');
  });

  it('rejects an invalid signature (401)', async () => {
    const body = JSON.stringify({ action: 'opened', installation: { app_id: 999 } });
    const res = await rig.server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'gh-del-2',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(rig.captured).toHaveLength(0);
  });

  it('duplicate delivery_id → 200 with {deduplicated:true}, no re-enqueue', async () => {
    const body = JSON.stringify({ action: 'opened', installation: { app_id: 999 } });
    const headers = {
      'content-type': 'application/json',
      'x-github-delivery': 'gh-del-dup',
      'x-github-event': 'pull_request',
      'x-hub-signature-256': ghSign(body),
    };

    const first = await rig.server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers,
      payload: body,
    });
    expect(first.statusCode).toBe(202);

    const second = await rig.server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers,
      payload: body,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ deduplicated: true });

    await new Promise((r) => setImmediate(r));
    expect(rig.captured).toHaveLength(1);
  });

  it('unknown agent → 404 with agent_not_configured', async () => {
    const body = JSON.stringify({ action: 'opened', installation: { app_id: 777 } });
    const res = await rig.server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'gh-del-3',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': ghSign(body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'agent_not_configured' });
  });

  it('missing headers → 400', async () => {
    const res = await rig.server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(400);
  });

  it('skips events triggered by our own bots (loop prevention)', async () => {
    const body = JSON.stringify({
      action: 'created',
      installation: { app_id: 999 },
      sender: { login: 'dev-team-harness[bot]', type: 'Bot' },
      comment: { body: 'hi from a bot' },
    });
    const res = await rig.server.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'gh-bot-1',
        'x-github-event': 'issue_comment',
        'x-hub-signature-256': ghSign(body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ skipped: 'bot_triggered' });
    // Nothing should have been enqueued.
    await new Promise((r) => setImmediate(r));
    expect(rig.captured).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Linear route
// ---------------------------------------------------------------------------
describe('POST /webhooks/linear', () => {
  const secret = 'linear-secret';
  let rig: Rig;
  beforeEach(async () => {
    rig = await buildRig(secret, 'strategist', 'wh-abc');
  });
  afterEach(async () => await rig.server.close());

  function linSign(body: string): string {
    return createHmac('sha256', secret).update(body).digest('hex');
  }

  it('accepts a valid signed webhook (202)', async () => {
    const body = JSON.stringify({ webhookId: 'wh-abc', type: 'Issue', action: 'create' });
    const res = await rig.server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': linSign(body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
  });

  it('rejects a tampered body (401)', async () => {
    const original = JSON.stringify({ webhookId: 'wh-abc', type: 'Issue', action: 'create' });
    const tampered = JSON.stringify({ webhookId: 'wh-abc', type: 'Issue', action: 'delete' });
    const res = await rig.server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': linSign(original),
      },
      payload: tampered,
    });
    expect(res.statusCode).toBe(401);
  });

  // Loop prevention. Session 278 was Builder-Server's own closing comment on
  // IRS-46 waking Builder-Server again through the ticket's routing label —
  // 15 turns and $1.15 for nothing, bounded only by chainGuard's depth cap of 5.
  it('skips a comment carrying our own reply footer (200 agent_authored)', async () => {
    const body = JSON.stringify({
      webhookId: 'wh-abc',
      type: 'Comment',
      action: 'create',
      data: {
        body: `Done.${renderFooter({ agent: 'builder-server', durationMs: 1000, costUsd: 1 })}`,
      },
    });
    const res = await rig.server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: { 'content-type': 'application/json', 'linear-signature': linSign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ skipped: 'agent_authored' });
    await new Promise((r) => setImmediate(r));
    expect(rig.captured).toHaveLength(0);
  });

  it('lets a human comment through', async () => {
    const body = JSON.stringify({
      webhookId: 'wh-abc',
      type: 'Comment',
      action: 'create',
      data: { body: 'Can you also handle the retry case?' },
    });
    const res = await rig.server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: { 'content-type': 'application/json', 'linear-signature': linSign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
  });

  // The trigger path this guard must NOT break. A label toggle is issued through
  // an OAuth app, so a "drop anything an app touched" rule would silently kill
  // the fleet's main way of starting work. Label events carry no `body`, so they
  // cannot match the footer.
  it('lets a label change through even though an app issued it', async () => {
    const body = JSON.stringify({
      webhookId: 'wh-abc',
      type: 'Issue',
      action: 'update',
      data: { labels: [{ name: 'backend' }], title: 'M1: @app/llm provider adapters' },
    });
    const res = await rig.server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: { 'content-type': 'application/json', 'linear-signature': linSign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
  });

  it('unknown Linear webhookId → 404 with agent_not_configured + reason', async () => {
    const body = JSON.stringify({ webhookId: 'wh-UNKNOWN', type: 'Issue', action: 'create' });
    const res = await rig.server.inject({
      method: 'POST',
      url: '/webhooks/linear',
      headers: {
        'content-type': 'application/json',
        'linear-signature': linSign(body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'agent_not_configured', reason: 'no_match' });
  });
});

// ---------------------------------------------------------------------------
// Slack routes
// ---------------------------------------------------------------------------
describe('POST /webhooks/slack/events', () => {
  const secret = 'slack-secret';
  let rig: Rig;
  beforeEach(async () => {
    rig = await buildRig(secret, 'marketer', 'A0999');
  });
  afterEach(async () => await rig.server.close());

  function slackSign(body: string, ts: string): string {
    const base = `v0:${ts}:${body}`;
    return `v0=${createHmac('sha256', secret).update(base).digest('hex')}`;
  }

  it('handles the url_verification handshake before signature verify', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'chal-abc' });
    const res = await rig.server.inject({
      method: 'POST',
      url: '/webhooks/slack/events',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ challenge: 'chal-abc' });
  });

  it('accepts a valid signed event (202)', async () => {
    const body = JSON.stringify({
      api_app_id: 'A0999',
      event: { type: 'app_mention' },
      event_id: 'Ev-1',
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await rig.server.inject({
      method: 'POST',
      url: '/webhooks/slack/events',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': slackSign(body, ts),
        'x-slack-request-timestamp': ts,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
  });

  it('unknown Slack app_id → 404 with agent_not_configured + reason', async () => {
    const body = JSON.stringify({
      api_app_id: 'A0-UNKNOWN',
      event: { type: 'app_mention' },
      event_id: 'Ev-x',
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await rig.server.inject({
      method: 'POST',
      url: '/webhooks/slack/events',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': slackSign(body, ts),
        'x-slack-request-timestamp': ts,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'agent_not_configured', reason: 'no_match' });
  });

  it('rejects a stale timestamp — replay-attack guard (401)', async () => {
    const body = JSON.stringify({
      api_app_id: 'A0999',
      event: { type: 'app_mention' },
      event_id: 'Ev-2',
    });
    const oldTs = String(Math.floor((Date.now() - 6 * 60 * 1000) / 1000));
    const res = await rig.server.inject({
      method: 'POST',
      url: '/webhooks/slack/events',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': slackSign(body, oldTs),
        'x-slack-request-timestamp': oldTs,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Slack slash commands (Phase 3 acks 200)
// ---------------------------------------------------------------------------
describe('POST /webhooks/slack/commands', () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = await buildRig('unused', 'unused');
  });
  afterEach(async () => await rig.server.close());

  it('acks 200 (full handling comes in Phase 9)', async () => {
    const res = await rig.server.inject({
      method: 'POST',
      url: '/webhooks/slack/commands',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'command=%2Fagents&text=list',
    });
    expect(res.statusCode).toBe(200);
  });
});
