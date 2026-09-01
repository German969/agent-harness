// Batcher tests — verify rate-limit-aware coalescing.
//
// Uses real setTimeout with short intervals; no fake timers (which would need
// vitest.useFakeTimers boilerplate) — the intervals are small enough (<200ms).

import { describe, expect, it } from 'vitest';
import { ReplyBatcher } from '../../src/reply/batcher.js';

describe('ReplyBatcher', () => {
  it('flushes the first chunk immediately', async () => {
    const flushed: string[] = [];
    const b = new ReplyBatcher({ intervalMs: 50, flush: async (t) => void flushed.push(t) });
    b.push('a');
    // Immediate microtask — but the flush is async; give it one turn.
    await new Promise((r) => setImmediate(r));
    expect(flushed).toEqual(['a']);
  });

  it('coalesces cumulative pushes within the interval — latest state wins', async () => {
    // Caller passes cumulative text on each push (as the reply streamer does).
    // Batcher replaces, so the delayed flush sends the latest state, not the
    // concatenation of intermediate states.
    const flushed: string[] = [];
    const b = new ReplyBatcher({ intervalMs: 80, flush: async (t) => void flushed.push(t) });
    b.push('a');
    await new Promise((r) => setImmediate(r));
    b.push('ab');
    b.push('abc');
    b.push('abcd');
    // Wait past the interval.
    await new Promise((r) => setTimeout(r, 120));
    // First flush ran immediately with 'a'; delayed flush picks up the latest.
    expect(flushed).toEqual(['a', 'abcd']);
  });

  it('regression: does NOT geometrically duplicate cumulative pushes', async () => {
    // Guards the streamer↔batcher contract: streamer sends cumulative text on
    // every push. If the batcher were appending, an N-chunk session would
    // produce a buffer with O(N^2) size and a garbled prefix. This test would
    // fail with the old `this.buffer += chunk` implementation.
    const flushed: string[] = [];
    const b = new ReplyBatcher({ intervalMs: 20, flush: async (t) => void flushed.push(t) });
    const cumulative = ['a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef'];
    for (const t of cumulative) {
      b.push(t);
      await new Promise((r) => setTimeout(r, 25));
    }
    await b.finalize('abcdef');
    for (const sent of flushed) {
      // Every flush must be a proper prefix of the final text — never a
      // duplicated concatenation.
      expect('abcdef'.startsWith(sent)).toBe(true);
    }
    expect(flushed[flushed.length - 1]).toBe('abcdef');
  });

  it('finalize sends immediately regardless of interval + is idempotent', async () => {
    const flushed: string[] = [];
    const b = new ReplyBatcher({ intervalMs: 500, flush: async (t) => void flushed.push(t) });
    b.push('a');
    await new Promise((r) => setImmediate(r));
    b.push('b');
    // finalize should fire NOW even though the 500ms window hasn't elapsed.
    await b.finalize('final text');
    expect(flushed).toEqual(['a', 'final text']);
    // A second finalize is a no-op.
    await b.finalize('ignored');
    expect(flushed).toEqual(['a', 'final text']);
  });

  it('reports flush errors via onError but keeps going', async () => {
    const errors: string[] = [];
    let call = 0;
    const b = new ReplyBatcher({
      intervalMs: 30,
      onError: (err) => errors.push(err.message),
      flush: async () => {
        call++;
        if (call === 1) throw new Error('boom');
      },
    });
    b.push('a');
    await new Promise((r) => setImmediate(r));
    expect(errors).toEqual(['boom']);
    // Next push should still trigger a fresh flush attempt.
    b.push('b');
    await new Promise((r) => setTimeout(r, 60));
    expect(call).toBeGreaterThanOrEqual(2);
  });

  it('push after finalize is ignored', async () => {
    const flushed: string[] = [];
    const b = new ReplyBatcher({ intervalMs: 50, flush: async (t) => void flushed.push(t) });
    await b.finalize('done');
    b.push('too late');
    await new Promise((r) => setTimeout(r, 80));
    expect(flushed).toEqual(['done']);
  });
});
