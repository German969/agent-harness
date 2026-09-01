// Linear reply client — GraphQL commentCreate / commentUpdate.
//
// Batch at 200ms. Linear's rate limit is generous; this batching is just to
// avoid burning API budget on redundant edits during heavy streams.

import { ReplyBatcher } from './batcher.js';
import type { FetchLike, ReplyClient, ReplyTarget } from './types.js';

const LINEAR_GRAPHQL = 'https://api.linear.app/graphql';

const CREATE_COMMENT = `
  mutation CommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) { success comment { id } }
  }
`;

const UPDATE_COMMENT = `
  mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
    commentUpdate(id: $id, input: $input) { success }
  }
`;

export type LinearClientOptions = {
  target: Extract<ReplyTarget, { provider: 'linear' }>;
  fetch?: FetchLike | undefined;
  onError?: ((err: Error) => void) | undefined;
};

export class LinearReplyClient implements ReplyClient {
  readonly provider = 'linear' as const;
  private commentId: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly batcher: ReplyBatcher;

  constructor(private readonly opts: LinearClientOptions) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.batcher = new ReplyBatcher({
      intervalMs: 200,
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
    const isCreate = this.commentId === undefined;
    const query = isCreate ? CREATE_COMMENT : UPDATE_COMMENT;
    const variables = isCreate
      ? { input: { issueId: this.opts.target.issue_id, body: text } }
      : { id: this.commentId, input: { body: text } };

    const res = await this.fetchImpl(LINEAR_GRAPHQL, {
      method: 'POST',
      headers: {
        Authorization: this.opts.target.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      throw new Error(`linear graphql → HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      data?: {
        commentCreate?: { success: boolean; comment?: { id: string } };
        commentUpdate?: { success: boolean };
      };
      errors?: Array<{ message: string }>;
    };
    if (json.errors && json.errors.length > 0) {
      throw new Error(`linear graphql → ${json.errors.map((e) => e.message).join('; ')}`);
    }
    if (isCreate && json.data?.commentCreate?.comment?.id) {
      this.commentId = json.data.commentCreate.comment.id;
    }
  }
}
