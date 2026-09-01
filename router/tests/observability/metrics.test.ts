import { describe, expect, it } from 'vitest';
import { createMetrics, scrape } from '../../src/observability/metrics.js';

describe('createMetrics', () => {
  it('produces a registry with all documented metrics', async () => {
    const m = createMetrics({ includeDefault: false });
    const text = await scrape(m);
    for (const name of [
      'agent_session_total',
      'agent_session_duration_seconds',
      'agent_session_cost_usd',
      'agent_cost_cap_proximity',
      'agent_webhook_total',
      'webhook_signature_failure_total',
      'mcp_server_status',
      'router_in_flight_sessions',
      'router_pending_sessions',
      'sqlite_db_size_bytes',
    ]) {
      expect(text).toContain(`# HELP ${name}`);
    }
  });

  it('counter increments per label combo', async () => {
    const m = createMetrics({ includeDefault: false });
    m.sessionTotal.inc({ agent: 'strategist', skill: 'pjm', outcome: 'completed' });
    m.sessionTotal.inc({ agent: 'strategist', skill: 'pjm', outcome: 'completed' });
    m.sessionTotal.inc({ agent: 'marketer', skill: '', outcome: 'failed' });
    const text = await scrape(m);
    expect(text).toMatch(
      /agent_session_total\{agent="strategist",skill="pjm",outcome="completed"\}\s+2/,
    );
    expect(text).toMatch(/agent_session_total\{agent="marketer",skill="",outcome="failed"\}\s+1/);
  });

  it('histogram observes durations into buckets', async () => {
    const m = createMetrics({ includeDefault: false });
    m.sessionDuration.observe({ agent: 'guardian', skill: 'qa' }, 45); // 45s
    const text = await scrape(m);
    expect(text).toMatch(/agent_session_duration_seconds_bucket\{.*le="60"/);
    expect(text).toMatch(/agent_session_duration_seconds_count\{.*guardian.*qa.*\}\s+1/);
  });

  it('gauge tracks current value', async () => {
    const m = createMetrics({ includeDefault: false });
    m.capProximity.set({ agent: 'marketer', scope: 'monthly' }, 0.85);
    m.inFlight.set(3);
    const text = await scrape(m);
    expect(text).toMatch(/agent_cost_cap_proximity\{agent="marketer",scope="monthly"\}\s+0\.85/);
    expect(text).toMatch(/router_in_flight_sessions\s+3/);
  });

  it('includes default node metrics when includeDefault is true', async () => {
    const m = createMetrics({ includeDefault: true });
    const text = await scrape(m);
    // process_ prefix is emitted by prom-client's default collector.
    expect(text).toMatch(/process_cpu_user_seconds_total/);
  });
});
