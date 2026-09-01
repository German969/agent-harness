import { describe, expect, it } from 'vitest';
import { resolveReplyTarget } from '../../src/consumer/replyTarget.js';
import type { WebhookEvent } from '../../src/ingress/types.js';

function evt(provider: 'slack' | 'linear' | 'github', payload: unknown): WebhookEvent {
  return {
    provider,
    delivery_id: 'd',
    event_type: 'x',
    agent_hint: 'x',
    payload,
    received_at: Date.now(),
  };
}

describe('resolveReplyTarget', () => {
  describe('slack', () => {
    it('builds a target with channel + thread_ts + token', () => {
      const t = resolveReplyTarget(
        evt('slack', { event: { channel: 'C-planning', ts: '1234.567' } }),
        { SLACK_BOT_TOKEN: 'xoxb-abc' },
      );
      expect(t).toEqual({
        provider: 'slack',
        channel: 'C-planning',
        thread_ts: '1234.567',
        token: 'xoxb-abc',
      });
    });

    it('uses thread_ts when set (reply inside a thread)', () => {
      const t = resolveReplyTarget(
        evt('slack', {
          event: { channel: 'C', ts: '999.9', thread_ts: '111.1' },
        }),
        { SLACK_BOT_TOKEN: 'xoxb' },
      );
      expect(t?.provider === 'slack' && t.thread_ts).toBe('111.1');
    });

    it('returns undefined when the token is missing', () => {
      const t = resolveReplyTarget(evt('slack', { event: { channel: 'C-x', ts: '1.0' } }), {});
      expect(t).toBeUndefined();
    });

    it('returns undefined when no channel present', () => {
      const t = resolveReplyTarget(evt('slack', { event: {} }), {
        SLACK_BOT_TOKEN: 'xoxb',
      });
      expect(t).toBeUndefined();
    });
  });

  describe('linear', () => {
    it('builds a target from comment event → data.issue.id', () => {
      const t = resolveReplyTarget(evt('linear', { data: { issue: { id: 'issue-uuid' } } }), {
        LINEAR_TOKEN: 'lin_api_xxx',
      });
      expect(t).toEqual({
        provider: 'linear',
        issue_id: 'issue-uuid',
        token: 'lin_api_xxx',
      });
    });

    it('builds a target from direct issue event → data.id', () => {
      const t = resolveReplyTarget(evt('linear', { data: { id: 'direct-id' } }), {
        LINEAR_TOKEN: 'l',
      });
      expect(t?.provider === 'linear' && t.issue_id).toBe('direct-id');
    });

    it('returns undefined when no issue reference found', () => {
      const t = resolveReplyTarget(evt('linear', { data: {} }), {
        LINEAR_TOKEN: 'l',
      });
      expect(t).toBeUndefined();
    });
  });

  describe('github', () => {
    it('builds a target from an issue event', () => {
      const t = resolveReplyTarget(
        evt('github', {
          repository: { full_name: 'acme/core' },
          issue: { number: 42 },
        }),
        { GITHUB_APP_INSTALLATION_TOKEN: 'ghs_xxx' },
      );
      expect(t).toEqual({
        provider: 'github',
        owner: 'acme',
        repo: 'core',
        issue_number: 42,
        token: 'ghs_xxx',
      });
    });

    it('reads pull_request.number when there is no issue', () => {
      const t = resolveReplyTarget(
        evt('github', {
          repository: { full_name: 'o/r' },
          pull_request: { number: 99 },
        }),
        { GITHUB_APP_INSTALLATION_TOKEN: 't' },
      );
      expect(t?.provider === 'github' && t.issue_number).toBe(99);
    });

    it('falls back to GITHUB_TOKEN if _APP_INSTALLATION_TOKEN is missing', () => {
      const t = resolveReplyTarget(
        evt('github', {
          repository: { full_name: 'o/r' },
          issue: { number: 1 },
        }),
        { GITHUB_TOKEN: 'ghp_fallback' },
      );
      expect(t?.provider === 'github' && t.token).toBe('ghp_fallback');
    });

    it('returns undefined for push events (no issue/pr number)', () => {
      const t = resolveReplyTarget(evt('github', { repository: { full_name: 'o/r' } }), {
        GITHUB_TOKEN: 't',
      });
      expect(t).toBeUndefined();
    });
  });
});
