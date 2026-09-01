import { describe, expect, it } from 'vitest';
import { extractInitialMessage } from '../../src/consumer/extractMessage.js';
import type { WebhookEvent } from '../../src/ingress/types.js';

function evt(
  provider: 'slack' | 'linear' | 'github',
  event_type: string,
  payload: unknown,
): WebhookEvent {
  return {
    provider,
    delivery_id: 'd-1',
    event_type,
    agent_hint: 'x',
    payload,
    received_at: Date.now(),
  };
}

describe('extractInitialMessage', () => {
  it('slack: reads event.text from app_mention', () => {
    const msg = extractInitialMessage(
      evt('slack', 'app_mention', { event: { text: '<@U-STRAT> plan Q4' } }),
    );
    expect(msg).toBe('<@U-STRAT> plan Q4');
  });

  it('slack: strips a leading self-mention when slackBotUserId is provided', () => {
    const msg = extractInitialMessage(
      evt('slack', 'app_mention', { event: { text: '<@U-STRAT> plan Q4' } }),
      { slackBotUserId: 'U-STRAT' },
    );
    expect(msg).toBe('plan Q4');
  });

  it('slack: strips leading self-mention with trailing colon / comma', () => {
    const msg = extractInitialMessage(
      evt('slack', 'app_mention', { event: { text: '<@U-STRAT>: hi' } }),
      { slackBotUserId: 'U-STRAT' },
    );
    expect(msg).toBe('hi');
  });

  it('slack: leaves non-self mentions in place', () => {
    const msg = extractInitialMessage(
      evt('slack', 'app_mention', { event: { text: '<@U-STRAT> ping <@U-OTHER>' } }),
      { slackBotUserId: 'U-STRAT' },
    );
    expect(msg).toBe('ping <@U-OTHER>');
  });

  it('slack: does not strip when botUserId does not match', () => {
    const msg = extractInitialMessage(
      evt('slack', 'app_mention', { event: { text: '<@U-STRAT> plan Q4' } }),
      { slackBotUserId: 'U-OTHER' },
    );
    expect(msg).toBe('<@U-STRAT> plan Q4');
  });

  it('slack: falls back to a description when text is missing', () => {
    const msg = extractInitialMessage(evt('slack', 'app_mention', { event: {} }));
    expect(msg).toBe('slack app_mention');
  });

  it('linear: prefers data.body when present', () => {
    const msg = extractInitialMessage(
      evt('linear', 'Comment', { data: { body: 'please refine ENG-42' } }),
    );
    expect(msg).toBe('please refine ENG-42');
  });

  it('linear: falls through body → description → title', () => {
    expect(extractInitialMessage(evt('linear', 'Issue', { data: { title: 'Bug in login' } }))).toBe(
      'Bug in login',
    );
    expect(
      extractInitialMessage(
        evt('linear', 'Issue', { data: { description: 'longer', title: 'short' } }),
      ),
    ).toBe('longer');
  });

  it('github issue_comment: reads comment.body', () => {
    const msg = extractInitialMessage(
      evt('github', 'issue_comment', { comment: { body: '@server-bot please implement' } }),
    );
    expect(msg).toBe('@server-bot please implement');
  });

  it('github pull_request_review: reads review.body', () => {
    const msg = extractInitialMessage(
      evt('github', 'pull_request_review', { review: { body: 'looks good' } }),
    );
    expect(msg).toBe('looks good');
  });

  it('github pull_request.opened: combines title + body', () => {
    const msg = extractInitialMessage(
      evt('github', 'pull_request', {
        pull_request: { title: 'Add auth', body: 'closes ENG-42' },
      }),
    );
    expect(msg).toBe('Add auth\n\ncloses ENG-42');
  });

  it('github issues.opened: combines title + body', () => {
    const msg = extractInitialMessage(
      evt('github', 'issues', { issue: { title: 'Bug', body: 'repro:' } }),
    );
    expect(msg).toBe('Bug\n\nrepro:');
  });

  it('fallback for unknown shapes', () => {
    const msg = extractInitialMessage(evt('github', 'push', { commits: [] }));
    expect(msg).toBe('github push');
  });

  it('github PR review comment: prepends PR-context header (repo + number + refs)', () => {
    const msg = extractInitialMessage(
      evt('github', 'pull_request_review_comment.created', {
        repository: { full_name: 'German969/chatbots' },
        pull_request: {
          number: 6,
          head: { ref: 'feat/m0', sha: 'abcdef1234567' },
          base: { ref: 'main' },
        },
        comment: { body: 'this export is dangling' },
      }),
    );
    expect(msg).toContain('[PR context] German969/chatbots #6');
    expect(msg).toContain('head feat/m0 (abcdef1)');
    expect(msg).toContain('base main');
    expect(msg).toContain('refs/pull/6/head');
    expect(msg).toContain('this export is dangling'); // original body preserved, after the header
  });

  it('github issue_comment on a PR: header from issue.number even without pull_request node', () => {
    const msg = extractInitialMessage(
      evt('github', 'issue_comment.created', {
        repository: { full_name: 'German969/chatbots' },
        issue: { number: 6, pull_request: {} },
        comment: { body: 'please address the review' },
      }),
    );
    expect(msg).toContain('[PR context] German969/chatbots #6');
    expect(msg).toContain('please address the review');
  });

  it('github issue_comment on a plain issue: no PR-context header', () => {
    const msg = extractInitialMessage(
      evt('github', 'issue_comment.created', {
        repository: { full_name: 'German969/chatbots' },
        issue: { number: 9, body: 'a bug' },
        comment: { body: 'not a PR' },
      }),
    );
    expect(msg).toBe('not a PR');
  });
});
