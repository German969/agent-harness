// Prometheus metrics — every metric documented in ARCHITECTURE.md §2.12.
//
// Uses a fresh Registry (not the default global one) so tests can build isolated
// instances + /metrics scrape returns only what we own.

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export type MetricsRegistry = {
  registry: Registry;
  // Business metrics
  sessionTotal: Counter<string>;
  sessionDuration: Histogram<string>;
  sessionCost: Counter<string>;
  capProximity: Gauge<string>;
  webhookTotal: Counter<string>;
  signatureFailure: Counter<string>;
  mcpStatus: Gauge<string>;
  inFlight: Gauge<string>;
  pending: Gauge<string>;
  sqliteBytes: Gauge<string>;
};

export type MetricsOptions = {
  /** Include node process defaults (cpu, memory, event loop). Default true. */
  includeDefault?: boolean;
};

export function createMetrics(opts: MetricsOptions = {}): MetricsRegistry {
  const registry = new Registry();
  if (opts.includeDefault !== false) {
    collectDefaultMetrics({ register: registry });
  }

  const sessionTotal = new Counter({
    name: 'agent_session_total',
    help: 'Total sessions by agent + skill + outcome',
    labelNames: ['agent', 'skill', 'outcome'],
    registers: [registry],
  });

  const sessionDuration = new Histogram({
    name: 'agent_session_duration_seconds',
    help: 'Session duration in seconds, per agent + skill',
    labelNames: ['agent', 'skill'],
    // Buckets tuned to typical session lengths: 5s → 10min
    buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800],
    registers: [registry],
  });

  const sessionCost = new Counter({
    name: 'agent_session_cost_usd',
    help: 'Cumulative session cost in USD by agent',
    labelNames: ['agent'],
    registers: [registry],
  });

  const capProximity = new Gauge({
    name: 'agent_cost_cap_proximity',
    help: 'Fraction of monthly cap used, 0.0..1.0',
    labelNames: ['agent', 'scope'],
    registers: [registry],
  });

  const webhookTotal = new Counter({
    name: 'agent_webhook_total',
    help: 'Webhook ingestion by provider + outcome',
    labelNames: ['provider', 'outcome'],
    registers: [registry],
  });

  const signatureFailure = new Counter({
    name: 'webhook_signature_failure_total',
    help: 'Signature verification failures by provider',
    labelNames: ['provider'],
    registers: [registry],
  });

  const mcpStatus = new Gauge({
    name: 'mcp_server_status',
    help: '1 = healthy, 0 = down, per agent + server',
    labelNames: ['agent', 'server'],
    registers: [registry],
  });

  const inFlight = new Gauge({
    name: 'router_in_flight_sessions',
    help: 'Concurrent sessions currently executing',
    registers: [registry],
  });

  const pending = new Gauge({
    name: 'router_pending_sessions',
    help: 'Sessions waiting on a worktree acquisition',
    registers: [registry],
  });

  const sqliteBytes = new Gauge({
    name: 'sqlite_db_size_bytes',
    help: 'Router state DB size on disk (bytes)',
    registers: [registry],
  });

  return {
    registry,
    sessionTotal,
    sessionDuration,
    sessionCost,
    capProximity,
    webhookTotal,
    signatureFailure,
    mcpStatus,
    inFlight,
    pending,
    sqliteBytes,
  };
}

/** Return the Prometheus exposition text (what the `/metrics` endpoint serves). */
export async function scrape(m: MetricsRegistry): Promise<string> {
  return m.registry.metrics();
}
