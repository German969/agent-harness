// GitHub reply client — issue comment create + edit (also serves PR comments).
//
// Batch at 500ms. GitHub's rate limit is 5000/hr per token; batching keeps us
// well under budget even for chatty sessions.

import { ReplyBatcher } from './batcher.js';
import type { FetchLike, ReplyClient, ReplyTarget } from './types.js';

const GITHUB_API = 'https://api.github.com';

export type GitHubClientOptions = {
  target: Extract<ReplyTarget, { provider: 'github' }>;
  fetch?: FetchLike | undefined;
  onError?: ((err: Error) => void) | undefined;
};

export class GitHubReplyClient implements ReplyClient {
  readonly provider = 'github' as const;
  private commentId: number | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly batcher: ReplyBatcher;

  constructor(private readonly opts: GitHubClientOptions) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.batcher = new ReplyBatcher({
      intervalMs: 500,
      flush: (text) => this.postOrEdit(text),
      ...(opts.onError ? { onError: opts.onError } : {}),
    });
  }

  async send(text: string): Promise<void> {
    this.batcher.push(text);
  }

  async finalize(text: string): Promise<void> {
    await this.batcher.finalize(text);
  }

  private async postOrEdit(text: string): Promise<void> {
    const { owner, repo, issue_number, token } = this.opts.target;
    const isCreate = this.commentId === undefined;
    const url = isCreate
      ? `${GITHUB_API}/repos/${owner}/${repo}/issues/${issue_number}/comments`
      : `${GITHUB_API}/repos/${owner}/${repo}/issues/comments/${this.commentId}`;

    const res = await this.fetchImpl(url, {
      method: isCreate ? 'POST' : 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'dev-team-router',
      },
      body: JSON.stringify({ body: text }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`github ${url} → HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    if (isCreate) {
      const json = (await res.json()) as { id?: number };
      if (typeof json.id === 'number') {
        this.commentId = json.id;
      }
    }
  }
}
