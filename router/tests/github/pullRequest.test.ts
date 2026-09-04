// The PR-open call `create_pr: true` promised and never made.

import { describe, expect, it } from 'vitest';
import {
  type GithubHttp,
  PullRequestClient,
  PullRequestError,
  parseGithubRemote,
} from '../../src/github/pullRequest.js';

type Call = { method: string; path: string; body?: unknown };

function fake(responses: Array<{ status: number; json: unknown }>): {
  http: GithubHttp;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const http: GithubHttp = async (method, path, body) => {
    calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
    return responses[i++] ?? { status: 500, json: { message: 'no response scripted' } };
  };
  return { http, calls };
}

const ARGS = {
  owner: 'German969',
  repo: 'chatbots-marketing',
  head: 'agent/marketer-bot/launch',
  base: 'main',
  title: '[marketer] campaign-lead: Q4 launch',
};

describe('PullRequestClient.open', () => {
  it('opens the PR and applies labels', async () => {
    const { http, calls } = fake([
      { status: 201, json: { number: 7, html_url: 'https://github.com/o/r/pull/7' } },
      { status: 200, json: [{ name: 'agent:marketer-bot' }] },
    ]);
    const res = await new PullRequestClient(http).open({
      ...ARGS,
      body: 'draft',
      labels: ['agent:marketer-bot'],
    });

    expect(res).toEqual({ number: 7, url: 'https://github.com/o/r/pull/7', reused: false });
    expect(calls[0]?.path).toBe('/repos/German969/chatbots-marketing/pulls');
    expect(calls[0]?.body).toEqual({
      title: ARGS.title,
      head: ARGS.head,
      base: 'main',
      body: 'draft',
    });
    // The owner label is what makes the GitHub classifier route this PR's later
    // events back to the agent, so it goes on its own request rather than being
    // dropped when the create call does not accept it.
    expect(calls[1]?.path).toBe('/repos/German969/chatbots-marketing/issues/7/labels');
    expect(calls[1]?.body).toEqual({ labels: ['agent:marketer-bot'] });
  });

  it('reuses the existing PR when one is already open for the branch', async () => {
    // A SessionEnd hook can run again on the same branch. GitHub answers the
    // second POST with 422; treating that as failure would turn a landed PR into
    // a hook error and an alert nobody should get.
    const { http, calls } = fake([
      {
        status: 422,
        json: {
          message: 'Validation Failed',
          errors: [
            { message: 'A pull request already exists for German969:agent/marketer-bot/launch.' },
          ],
        },
      },
      { status: 200, json: [{ number: 7, html_url: 'https://github.com/o/r/pull/7' }] },
    ]);
    const res = await new PullRequestClient(http).open(ARGS);

    expect(res.reused).toBe(true);
    expect(res.number).toBe(7);
    expect(calls[1]?.method).toBe('GET');
    expect(calls[1]?.path).toContain('head=German969%3Aagent%2Fmarketer-bot%2Flaunch');
  });

  it('throws with the API message when the PR genuinely cannot be opened', async () => {
    // One scripted response per client: the fake advances, so a second .open()
    // on the same one would assert against "no response scripted" instead.
    await expect(
      new PullRequestClient(fake([{ status: 404, json: { message: 'Not Found' } }]).http).open(
        ARGS,
      ),
    ).rejects.toBeInstanceOf(PullRequestError);
    await expect(
      new PullRequestClient(fake([{ status: 404, json: { message: 'Not Found' } }]).http).open(
        ARGS,
      ),
    ).rejects.toThrow(/Not Found/);
  });

  it('reports a label failure without losing the PR', async () => {
    // The PR is the deliverable. A 403 on labels is worth surfacing, not worth
    // discarding the PR that did open.
    const { http } = fake([
      { status: 201, json: { number: 9, html_url: 'https://github.com/o/r/pull/9' } },
      { status: 403, json: { message: 'Resource not accessible by integration' } },
    ]);
    const res = await new PullRequestClient(http).open({ ...ARGS, labels: ['agent:marketer-bot'] });

    expect(res.number).toBe(9);
    expect(res.labelError).toContain('403');
    expect(res.labelError).toContain('Resource not accessible');
  });
});

describe('parseGithubRemote', () => {
  it.each([
    ['git@github.com:German969/dev-team.git', 'German969', 'dev-team'],
    ['git@github.com:German969/dev-team', 'German969', 'dev-team'],
    ['ssh://git@github.com/German969/dev-team.git', 'German969', 'dev-team'],
    ['https://github.com/German969/chatbots.git', 'German969', 'chatbots'],
    ['https://github.com/German969/chatbots', 'German969', 'chatbots'],
  ])('parses %s', (url, owner, repo) => {
    expect(parseGithubRemote(url)).toEqual({ owner, repo });
  });

  it('returns undefined for a non-GitHub remote', () => {
    // A local bare origin is what every test repo in this suite uses, and the
    // handler must say so rather than posting a PR request at a file path.
    expect(parseGithubRemote('/tmp/some/bare-origin.git')).toBeUndefined();
  });
});
