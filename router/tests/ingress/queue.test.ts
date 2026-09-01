import { describe, expect, it, vi } from 'vitest';
import { EventQueue } from '../../src/ingress/queue.js';
import type { WebhookEvent } from '../../src/ingress/types.js';

function fixture(id: string): WebhookEvent {
  return {
    provider: 'github',
    delivery_id: id,
    event_type: 'pull_request.opened',
    agent_hint: '999',
    payload: {},
    received_at: Date.now(),
  };
}

describe('EventQueue', () => {
  it('starts empty', () => {
    const q = new EventQueue();
    expect(q.size()).toBe(0);
  });

  it('accepts events without a consumer', () => {
    const q = new EventQueue();
    q.enqueue(fixture('a'));
    q.enqueue(fixture('b'));
    expect(q.size()).toBe(2);
  });

  it('drains buffered events when a consumer is attached', async () => {
    const q = new EventQueue();
    q.enqueue(fixture('a'));
    q.enqueue(fixture('b'));

    const seen: string[] = [];
    const consumer = vi.fn(async (e: WebhookEvent) => {
      seen.push(e.delivery_id);
    });
    q.onEvent(consumer);

    // Give the microtask queue a tick
    await new Promise((r) => setImmediate(r));

    expect(seen).toEqual(['a', 'b']);
    expect(q.size()).toBe(0);
  });

  it('delivers new events to the attached consumer', async () => {
    const q = new EventQueue();
    const seen: string[] = [];
    q.onEvent(async (e) => {
      seen.push(e.delivery_id);
    });

    q.enqueue(fixture('x'));
    q.enqueue(fixture('y'));

    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual(['x', 'y']);
  });

  it('consumer errors do not stop the queue', async () => {
    const q = new EventQueue();
    const seen: string[] = [];
    q.onEvent(async (e) => {
      if (e.delivery_id === 'a') throw new Error('boom');
      seen.push(e.delivery_id);
    });

    q.enqueue(fixture('a'));
    q.enqueue(fixture('b'));

    // Silence the console.error the queue emits on consumer failure.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await new Promise((r) => setImmediate(r));
    spy.mockRestore();

    expect(seen).toEqual(['b']);
  });
});
