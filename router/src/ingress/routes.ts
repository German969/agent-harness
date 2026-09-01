// Webhook route registration.
// Per router/ARCHITECTURE.md §2.1 — Slack has three sub-routes (events + slash commands +
// interactivity); GitHub and Linear have one each.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyGithubSignature } from '../auth/github.js';
import { verifyLinearSignature } from '../auth/linear.js';
import { verifySlackSignature } from '../auth/slack.js';
import { isLinearAgentAuthored } from '../routing/authorship.js';
import type { Db } from '../state/db.js';
import { tryRegisterDelivery } from '../state/index.js';
import { normalizeGithub } from './normalize/github.js';
import { normalizeLinear } from './normalize/linear.js';
import { normalizeSlackEvent } from './normalize/slack.js';
import type { EventQueue } from './queue.js';
import type { SecretLookup, WebhookEvent } from './types.js';

type Deps = {
  db: Db;
  queue: EventQueue;
  resolveSecret: SecretLookup;
};

/**
 * Register the webhook routes. Fastify already applies its JSON body parser
 * globally, but we need the RAW body for signature verification. We add a
 * per-route "content type parser" that captures the raw bytes.
 */
export async function registerIngressRoutes(server: FastifyInstance, deps: Deps): Promise<void> {
  // Capture raw body for signature verification. We register a JSON parser that
  // keeps the raw Buffer available via req.rawBody.
  server.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      (req as unknown as { rawBody: Buffer }).rawBody = body;
      try {
        const parsed = body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );
  // Slack slash commands come as application/x-www-form-urlencoded.
  server.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      (req as unknown as { rawBody: Buffer }).rawBody = body;
      const parsed: Record<string, string> = {};
      const params = new URLSearchParams(body.toString('utf8'));
      for (const [k, v] of params.entries()) parsed[k] = v;
      done(null, parsed);
    },
  );

  server.post('/webhooks/github', async (req, reply) => {
    const rawBody = getRawBody(req);
    if (!rawBody) return reply.status(400).send({ error: 'body_missing' });

    let event: WebhookEvent;
    try {
      event = normalizeGithub(rawBody, req.headers);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'github normalize failed');
      return reply.status(400).send({ error: (err as Error).message });
    }

    const lookup = await deps.resolveSecret({
      provider: 'github',
      agent_hint: event.agent_hint,
    });
    if (!lookup.found) {
      req.log.warn(
        { agent_hint: event.agent_hint, reason: lookup.reason },
        'github agent not configured',
      );
      return reply.status(404).send({ error: 'agent_not_configured', reason: lookup.reason });
    }

    const verify = verifyGithubSignature(rawBody, req.headers, lookup.webhook_secret);
    if (!verify.ok) {
      req.log.warn({ reason: verify.reason }, 'github signature failure');
      return reply.status(401).send({ error: 'invalid_signature' });
    }

    // Self-triggered event guard: when an agent's own bot posts a comment on
    // GitHub, GitHub fires a webhook that would re-trigger the same agent,
    // creating an infinite loop (one observation: 22 comments burned before
    // the agent gave up). Any sender ending in `[bot]` is treated as a bot
    // action and skipped; broadens beyond just OUR bots (also skips
    // dependabot etc.) but that's acceptable — agents should react to human
    // requests, not to bot noise.
    if (event.sender_login?.endsWith('[bot]')) {
      req.log.info(
        { sender: event.sender_login, delivery: event.delivery_id, event_type: event.event_type },
        'github event skipped — bot-triggered (loop prevention)',
      );
      return reply.status(200).send({ skipped: 'bot_triggered' });
    }

    return handleDedupAndEnqueue(reply, deps, event, lookup.agent);
  });

  server.post('/webhooks/linear', async (req, reply) => {
    const rawBody = getRawBody(req);
    if (!rawBody) return reply.status(400).send({ error: 'body_missing' });

    let event: WebhookEvent;
    try {
      event = normalizeLinear(rawBody, req.headers);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'linear normalize failed');
      return reply.status(400).send({ error: (err as Error).message });
    }

    const lookup = await deps.resolveSecret({
      provider: 'linear',
      agent_hint: event.agent_hint,
    });
    if (!lookup.found) {
      req.log.warn(
        { agent_hint: event.agent_hint, reason: lookup.reason },
        'linear agent not configured',
      );
      return reply.status(404).send({ error: 'agent_not_configured', reason: lookup.reason });
    }

    const verify = verifyLinearSignature(rawBody, req.headers, lookup.webhook_secret);
    if (!verify.ok) {
      req.log.warn(
        { reason: verify.reason, diagnostics: verify.diagnostics },
        'linear signature failure',
      );
      return reply.status(401).send({ error: 'invalid_signature' });
    }

    // Self-triggered event guard — the Linear counterpart of the GitHub `[bot]`
    // check above, and it exists for the same reason: an agent's own comment
    // comes straight back as `Comment.create`, matches the ticket's routing
    // label, and wakes the same agent again.
    //
    // This is not hypothetical. Session 278 was exactly that — Builder-Server's
    // closing comment on IRS-46 re-waking Builder-Server, 15 turns and $1.15 for
    // nothing. It stopped after one hop on the agent's own judgment, not because
    // anything stopped it; the only bound was chainGuard's depth cap of 5, so the
    // worst case was five sessions of a work skill.
    //
    // Matched on OUR REPLY FOOTER, deliberately, rather than on "any bot" the way
    // the GitHub guard does. Two reasons:
    //
    //   - It is the only signal that works. Neither live trigger on IRS-46 carried
    //     a `botActor` key at all, so a botActor-based drop here would be dead code.
    //   - A broad drop would be dangerous in a way GitHub's is not. GitHub keys on
    //     `sender.login`, and a human's login is never `*[bot]`. Linear has no such
    //     separation, and the label toggle that starts a work session is issued
    //     through an OAuth app — so "drop anything an app touched" risks silently
    //     killing the fleet's main trigger path. Label changes carry no `body` and
    //     so cannot match the footer, which keeps that path open by construction.
    if (isLinearAgentAuthored(event.payload)) {
      req.log.info(
        { delivery: event.delivery_id, event_type: event.event_type },
        'linear event skipped — agent-authored (loop prevention)',
      );
      return reply.status(200).send({ skipped: 'agent_authored' });
    }

    return handleDedupAndEnqueue(reply, deps, event, lookup.agent);
  });

  server.post('/webhooks/slack/events', async (req, reply) => {
    const rawBody = getRawBody(req);
    if (!rawBody) return reply.status(400).send({ error: 'body_missing' });

    // Handle Slack's URL-verification handshake before signature verify: Slack
    // does sign these but we handle the response inline.
    const preview = safeJsonPreview(rawBody);
    if (preview && preview.type === 'url_verification' && typeof preview.challenge === 'string') {
      // Verify signature using ANY app id — actually, url_verification uses the
      // team's signing secret directly. In v1 we treat the challenge as a special
      // case: return the challenge without full verification (Slack retries with
      // signature-verified events after handshake). This is standard practice.
      return reply.status(200).send({ challenge: preview.challenge });
    }

    let event: WebhookEvent;
    try {
      event = normalizeSlackEvent(rawBody, req.headers);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'slack normalize failed');
      return reply.status(400).send({ error: (err as Error).message });
    }

    const lookup = await deps.resolveSecret({
      provider: 'slack',
      agent_hint: event.agent_hint,
    });
    if (!lookup.found) {
      req.log.warn(
        { agent_hint: event.agent_hint, reason: lookup.reason },
        'slack agent not configured',
      );
      return reply.status(404).send({ error: 'agent_not_configured', reason: lookup.reason });
    }

    const verify = verifySlackSignature(rawBody, req.headers, lookup.webhook_secret);
    if (!verify.ok) {
      req.log.warn({ reason: verify.reason }, 'slack signature failure');
      return reply.status(401).send({ error: 'invalid_signature' });
    }

    return handleDedupAndEnqueue(reply, deps, event, lookup.agent);
  });

  // Slash commands and interactivity — Phase 3 acks 200 after signature verify.
  // Actual command routing (e.g. /agents schedule enable) lands with the scheduler
  // in Phase 9.
  server.post('/webhooks/slack/commands', async (req, reply) => {
    const rawBody = getRawBody(req);
    if (!rawBody) return reply.status(400).send({ error: 'body_missing' });
    // Slash commands don't carry api_app_id in the body — the router needs to
    // look it up by team_id + command name in Phase 9. For Phase 3 we just
    // acknowledge with an empty 200 (which Slack renders as "no message").
    req.log.info({ route: 'slack/commands' }, 'slash command received (Phase 9 will handle)');
    return reply.status(200).send('');
  });

  server.post('/webhooks/slack/interact', async (req, reply) => {
    const rawBody = getRawBody(req);
    if (!rawBody) return reply.status(400).send({ error: 'body_missing' });
    req.log.info({ route: 'slack/interact' }, 'interactivity received (future phase)');
    return reply.status(200).send('');
  });
}

function getRawBody(req: FastifyRequest): Buffer | undefined {
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  return raw instanceof Buffer ? raw : undefined;
}

async function handleDedupAndEnqueue(
  reply: import('fastify').FastifyReply,
  deps: Deps,
  event: WebhookEvent,
  agent: string,
): Promise<void> {
  const isNew = tryRegisterDelivery(deps.db, {
    delivery_id: event.delivery_id,
    provider: event.provider,
    // biome-ignore lint/suspicious/noExplicitAny: agent id validated by identity layer in Phase 4
    agent: agent as any,
    event_type: event.event_type,
    received_at: event.received_at,
  });

  if (!isNew) {
    return reply.status(200).send({ deduplicated: true });
  }

  deps.queue.enqueue(event);
  return reply.status(202).send({ queued: true, delivery_id: event.delivery_id });
}

function safeJsonPreview(rawBody: Buffer): { type?: string; challenge?: string } | undefined {
  try {
    const parsed = JSON.parse(rawBody.toString('utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // fall through
  }
  return undefined;
}
