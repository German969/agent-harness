import { describe, expect, it } from 'vitest';
import { MemoryAlertPoster, NoopAlertPoster } from '../../src/observability/alerts.js';

describe('AlertPoster implementations', () => {
  it('MemoryAlertPoster buffers messages for inspection', async () => {
    const p = new MemoryAlertPoster();
    await p.post({
      agent: 'strategist',
      channel: '#agents-alerts',
      level: 'warn',
      title: 't',
      body: 'b',
    });
    expect(p.messages).toHaveLength(1);
    expect(p.kind).toBe('memory');
    p.clear();
    expect(p.messages).toHaveLength(0);
  });

  it('NoopAlertPoster discards silently', async () => {
    const p = new NoopAlertPoster();
    await p.post({
      agent: 'strategist',
      channel: '#agents-alerts',
      level: 'error',
      title: 't',
      body: 'b',
    });
    expect(p.kind).toBe('noop');
  });
});
