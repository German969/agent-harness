// Opening a pull request from a SessionEnd hook.
//
// `create_pr: true` has been a documented option on `git_commit_if_changed` since
// it was written, and the handler's own comment deferred the call to "Phase 6d":
// it returned `{ create_pr: true, ... }` as side-effect data for "downstream
// orchestration" to dispatch. Nothing anywhere consumed that data. Four agents
// configure the flag; none has ever opened a PR.
//
// Small and REST-direct rather than routed through the GitHub MCP: the MCP servers
// are spawned for the model's tool calls and torn down with the session, while this
// runs in the SessionEnd phase after the model is done. A `fetch` with the App
// installation token the session already holds is the whole requirement.
//
// The HTTP surface is injectable for the same reason gitData.ts injects one —
// tests exercise the real request shapes and the real error branches without a
// network.

import type { Logger } from 'pino';

/** Minimal injectable HTTP surface — real impl uses fetch; tests pass a fake. */
export type GithubHttp = (
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
) => Promise<{ status: number; json: unknown }>;

export type OpenPullRequestArgs = {
  owner: string;
  repo: string;
  /** Branch carrying the commits. */
  head: string;
  /** Branch to merge into. */
  base: string;
  title: string;
  body?: string | undefined;
  labels?: readonly string[] | undefined;
};

export type OpenPullRequestResult = {
  number: number;
  url: string;
  /** True when the PR already existed and was reused rather than created. */
  reused: boolean;
  /** Labels that could not be applied. The PR is the deliverable; a label is not
   *  worth failing it, but a silently dropped one is how an owner label goes
   *  missing and the classifier stops routing the PR's events. */
  labelError?: string;
};

export class PullRequestError extends Error {
  override readonly name = 'PullRequestError';
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export class PullRequestClient {
  constructor(private readonly http: GithubHttp) {}

  static fromToken(token: string, baseUrl = 'https://api.github.com'): PullRequestClient {
    return new PullRequestClient(defaultHttp(token, baseUrl));
  }

  /**
   * Open a PR for `head` → `base`, then apply labels.
   *
   * Idempotent on the one collision that actually happens: a SessionEnd hook can
   * run again on the same branch (a resumed session, a second session on the same
   * task), and GitHub answers the second POST with 422 "A pull request already
   * exists". That is success, not failure — the existing PR is looked up and
   * returned, so a retry never turns a landed PR into a hook error.
   */
  async open(args: OpenPullRequestArgs): Promise<OpenPullRequestResult> {
    const { owner, repo, head, base, title, body, labels } = args;
    const created = await this.http('POST', `/repos/${owner}/${repo}/pulls`, {
      title,
      head,
      base,
      ...(body !== undefined ? { body } : {}),
    });

    let number: number | undefined;
    let url: string | undefined;
    let reused = false;

    if (created.status >= 200 && created.status < 300) {
      number = readNumber(created.json, 'number');
      url = readString(created.json, 'html_url');
    } else if (created.status === 422 && mentionsExistingPr(created.json)) {
      const existing = await this.findOpenPr(owner, repo, head);
      if (existing) {
        number = existing.number;
        url = existing.url;
        reused = true;
      }
    }

    if (number === undefined || url === undefined) {
      throw new PullRequestError(
        `github: could not open a PR for ${owner}/${repo} ${head} -> ${base}: ${describe(created.json)}`,
        created.status,
      );
    }

    const result: OpenPullRequestResult = { number, url, reused };
    if (labels && labels.length > 0) {
      const applied = await this.http('POST', `/repos/${owner}/${repo}/issues/${number}/labels`, {
        labels: [...labels],
      });
      if (applied.status < 200 || applied.status >= 300) {
        result.labelError = `labels ${labels.join(', ')} not applied (${applied.status}): ${describe(applied.json)}`;
      }
    }
    return result;
  }

  private async findOpenPr(
    owner: string,
    repo: string,
    head: string,
  ): Promise<{ number: number; url: string } | undefined> {
    // `head` on the list endpoint wants `owner:branch`.
    const res = await this.http(
      'GET',
      `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`,
    );
    if (res.status < 200 || res.status >= 300 || !Array.isArray(res.json)) return undefined;
    const first = res.json[0];
    const number = readNumber(first, 'number');
    const url = readString(first, 'html_url');
    return number !== undefined && url !== undefined ? { number, url } : undefined;
  }
}

/** GitHub says this several ways across versions; match on the stable substring. */
function mentionsExistingPr(json: unknown): boolean {
  return describe(json).toLowerCase().includes('pull request already exists');
}

function describe(json: unknown): string {
  if (typeof json === 'string') return json;
  if (json && typeof json === 'object') {
    const message = readString(json, 'message') ?? '';
    const errors = (json as { errors?: unknown }).errors;
    const detail = Array.isArray(errors)
      ? errors
          .map((e) => readString(e, 'message') ?? '')
          .filter(Boolean)
          .join('; ')
      : '';
    return [message, detail].filter(Boolean).join(' — ') || JSON.stringify(json);
  }
  return String(json);
}

function readString(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

function readNumber(obj: unknown, key: string): number | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'number' ? v : undefined;
}

function defaultHttp(token: string, baseUrl: string): GithubHttp {
  return async (method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: res.status, json };
  };
}

/**
 * `owner/repo` from a git remote URL — both the SSH (`git@github.com:o/r.git`)
 * and HTTPS (`https://github.com/o/r`) forms the fleet uses.
 */
export function parseGithubRemote(url: string): { owner: string; repo: string } | undefined {
  const trimmed = url.trim().replace(/\.git$/, '');
  const ssh = /^(?:ssh:\/\/)?git@[^:/]+[:/]([^/]+)\/(.+)$/.exec(trimmed);
  if (ssh?.[1] && ssh[2]) return { owner: ssh[1], repo: ssh[2] };
  const https = /^https?:\/\/[^/]+\/([^/]+)\/(.+)$/.exec(trimmed);
  if (https?.[1] && https[2]) return { owner: https[1], repo: https[2] };
  return undefined;
}
