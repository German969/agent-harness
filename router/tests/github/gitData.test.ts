import { describe, expect, it } from 'vitest';
import { GitDataClient, GitDataError, type GitDataHttp } from '../../src/github/gitData.js';

type Call = { method: string; path: string; body?: unknown };

/** Scripted GitHub Git Data API modeling a tiny repo on `main`. Records calls. */
function makeFake(opts: { treeNodes?: unknown[]; truncated?: boolean; refStatus?: number } = {}): {
  http: GitDataHttp;
  calls: Call[];
} {
  const calls: Call[] = [];
  const treeNodes = opts.treeNodes ?? [
    { path: 'docs/big.md', type: 'blob', sha: 'BLOB_BIG', mode: '100644' },
    { path: 'keep.md', type: 'blob', sha: 'BLOB_KEEP', mode: '100644' },
  ];
  const http: GitDataHttp = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path.endsWith('/git/ref/heads/main')) {
      if (opts.refStatus && opts.refStatus >= 300) {
        return { status: opts.refStatus, json: { message: 'Not Found' } };
      }
      return { status: 200, json: { object: { sha: 'COMMIT_0' } } };
    }
    if (method === 'GET' && path.endsWith('/git/commits/COMMIT_0')) {
      return { status: 200, json: { tree: { sha: 'TREE_0' } } };
    }
    if (method === 'GET' && path.includes('/git/trees/TREE_0')) {
      return { status: 200, json: { tree: treeNodes, truncated: opts.truncated ?? false } };
    }
    if (method === 'POST' && path.endsWith('/git/trees')) {
      return { status: 201, json: { sha: 'TREE_1' } };
    }
    if (method === 'POST' && path.endsWith('/git/commits')) {
      return { status: 201, json: { sha: 'COMMIT_1' } };
    }
    if (method === 'PATCH' && path.endsWith('/git/refs/heads/main')) {
      return { status: 200, json: { object: { sha: 'COMMIT_1' } } };
    }
    return { status: 404, json: { message: `unexpected ${method} ${path}` } };
  };
  return { http, calls };
}

const REPO = { owner: 'German969', repo: 'chatbots', branch: 'main', message: 'chore: move' };

describe('GitDataClient.moveFile', () => {
  it('renames via blob SHA without transferring content', async () => {
    const { http, calls } = makeFake();
    const client = new GitDataClient(http);
    const res = await client.moveFile({
      ...REPO,
      from: 'docs/big.md',
      to: 'docs/legacy/big.md',
    });

    expect(res).toEqual({
      commitSha: 'COMMIT_1',
      treeSha: 'TREE_1',
      branch: 'main',
      applied: 1,
    });

    const createTree = calls.find((c) => c.method === 'POST' && c.path.endsWith('/git/trees'));
    const entries = (createTree?.body as { tree: Array<Record<string, unknown>> }).tree;
    // New path points at the existing blob SHA — no `content` field anywhere.
    expect(entries).toContainEqual({
      path: 'docs/legacy/big.md',
      mode: '100644',
      type: 'blob',
      sha: 'BLOB_BIG',
    });
    // Old path deleted (sha: null).
    expect(entries).toContainEqual({
      path: 'docs/big.md',
      mode: '100644',
      type: 'blob',
      sha: null,
    });
    expect(JSON.stringify(calls)).not.toContain('content');
    // base_tree preserves untouched files.
    expect((createTree?.body as { base_tree: string }).base_tree).toBe('TREE_0');
  });

  it('commits onto the current head as parent and moves the ref', async () => {
    const { http, calls } = makeFake();
    await new GitDataClient(http).moveFile({ ...REPO, from: 'docs/big.md', to: 'a.md' });
    const commit = calls.find((c) => c.method === 'POST' && c.path.endsWith('/git/commits'));
    expect((commit?.body as { parents: string[] }).parents).toEqual(['COMMIT_0']);
    expect((commit?.body as { tree: string }).tree).toBe('TREE_1');
    const patch = calls.find((c) => c.method === 'PATCH');
    expect((patch?.body as { sha: string }).sha).toBe('COMMIT_1');
  });

  it('throws when the source path does not exist', async () => {
    const { http } = makeFake();
    await expect(
      new GitDataClient(http).moveFile({ ...REPO, from: 'nope.md', to: 'x.md' }),
    ).rejects.toThrow(/path not found: nope\.md/);
  });
});

describe('GitDataClient.deleteFile', () => {
  it('deletes a path via a null-SHA tree entry', async () => {
    const { http, calls } = makeFake();
    await new GitDataClient(http).deleteFile({ ...REPO, path: 'keep.md' });
    const createTree = calls.find((c) => c.method === 'POST' && c.path.endsWith('/git/trees'));
    const entries = (createTree?.body as { tree: Array<Record<string, unknown>> }).tree;
    expect(entries).toEqual([{ path: 'keep.md', mode: '100644', type: 'blob', sha: null }]);
  });

  it('throws when the deleted path does not exist', async () => {
    const { http } = makeFake();
    await expect(new GitDataClient(http).deleteFile({ ...REPO, path: 'ghost.md' })).rejects.toThrow(
      /path not found/,
    );
  });
});

describe('GitDataClient.applyFileOps', () => {
  it('applies move + delete + upsert in a single commit', async () => {
    const { http, calls } = makeFake();
    const res = await new GitDataClient(http).applyFileOps({
      ...REPO,
      ops: [
        { kind: 'move', from: 'docs/big.md', to: 'docs/legacy/big.md' },
        { kind: 'delete', path: 'keep.md' },
        { kind: 'upsert', path: 'NEW.md', content: '# new\n' },
      ],
    });
    expect(res.applied).toBe(3);
    const createTree = calls.find((c) => c.method === 'POST' && c.path.endsWith('/git/trees'));
    const entries = (createTree?.body as { tree: Array<Record<string, unknown>> }).tree;
    // upsert carries content; move/delete carry sha.
    expect(entries).toContainEqual({
      path: 'NEW.md',
      mode: '100644',
      type: 'blob',
      content: '# new\n',
    });
    expect(entries.filter((e) => 'sha' in e && e.sha === null)).toHaveLength(2); // old move path + delete
    // exactly one commit + one ref update regardless of op count.
    expect(
      calls.filter((c) => c.method === 'POST' && c.path.endsWith('/git/commits')),
    ).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('rejects an empty op list', async () => {
    const { http } = makeFake();
    await expect(new GitDataClient(http).applyFileOps({ ...REPO, ops: [] })).rejects.toThrow(
      /no file ops/,
    );
  });

  it('does not fetch the tree when no op needs an existing blob (upsert only)', async () => {
    const { http, calls } = makeFake();
    await new GitDataClient(http).applyFileOps({
      ...REPO,
      ops: [{ kind: 'upsert', path: 'ONLY.md', content: 'x' }],
    });
    expect(calls.some((c) => c.path.includes('/git/trees/TREE_0'))).toBe(false);
  });
});

describe('GitDataClient error surfacing', () => {
  it('wraps a non-2xx response with status + GitHub message', async () => {
    const { http } = makeFake({ refStatus: 404 });
    const err = await new GitDataClient(http)
      .moveFile({ ...REPO, from: 'a', to: 'b' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GitDataError);
    expect((err as GitDataError).status).toBe(404);
    expect((err as GitDataError).message).toContain('Not Found');
  });
});

describe('replyToReviewComment', () => {
  function rig(status = 201) {
    const calls: Call[] = [];
    const http: GitDataHttp = async (method, path, body) => {
      calls.push({ method, path, body });
      if (status >= 300) return { status, json: { message: 'Not Found' } };
      return {
        status,
        json: { id: 999, html_url: 'https://github.com/o/r/pull/11#discussion_r999' },
      };
    };
    return { client: new GitDataClient(http), calls };
  }

  // The reason this lives here at all: the pinned MCP github server has no reply
  // tool, so an addressed review comment could only be answered somewhere other
  // than the thread the reviewer is reading.
  it('posts to the review comment’s replies endpoint', async () => {
    const { client, calls } = rig();
    const res = await client.replyToReviewComment({
      owner: 'o',
      repo: 'r',
      pullNumber: 11,
      commentId: 3885419155,
      body: 'Fixed in f7a8031.',
    });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/repos/o/r/pulls/11/comments/3885419155/replies',
        body: { body: 'Fixed in f7a8031.' },
      },
    ]);
    expect(res).toEqual({ id: 999, url: 'https://github.com/o/r/pull/11#discussion_r999' });
  });

  it('raises GitDataError on a failure status', async () => {
    const { client } = rig(404);
    await expect(
      client.replyToReviewComment({
        owner: 'o',
        repo: 'r',
        pullNumber: 11,
        commentId: 1,
        body: 'x',
      }),
    ).rejects.toBeInstanceOf(GitDataError);
  });
});

describe('listCheckRuns', () => {
  function rig(json: unknown, status = 200) {
    const calls: Call[] = [];
    const http: GitDataHttp = async (method, path, body) => {
      calls.push({ method, path, body });
      return { status, json };
    };
    return { client: new GitDataClient(http), calls };
  }

  // The endpoint matters: the MCP server's get_pull_request_status reads
  // /commits/{sha}/status, the legacy commit-status API, which reports nothing
  // for GitHub Actions. check-runs is what actually answers "did CI pass".
  it('reads the check-runs endpoint and flattens the result', async () => {
    const { client, calls } = rig({
      check_runs: [
        {
          name: 'lint · typecheck · test · build',
          status: 'completed',
          conclusion: 'failure',
          html_url: 'https://github.com/o/r/runs/1',
        },
        { name: 'db migrations gate', status: 'completed', conclusion: 'success' },
      ],
    });
    const runs = await client.listCheckRuns({ owner: 'o', repo: 'r', ref: 'abc123' });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/repos/o/r/commits/abc123/check-runs' });
    expect(runs).toEqual([
      {
        name: 'lint · typecheck · test · build',
        status: 'completed',
        conclusion: 'failure',
        url: 'https://github.com/o/r/runs/1',
      },
      { name: 'db migrations gate', status: 'completed', conclusion: 'success', url: '' },
    ]);
  });

  it('returns [] when the payload carries no check_runs array', async () => {
    const { client } = rig({});
    await expect(client.listCheckRuns({ owner: 'o', repo: 'r', ref: 'x' })).resolves.toEqual([]);
  });

  it('raises GitDataError on a failure status', async () => {
    const { client } = rig({ message: 'Forbidden' }, 403);
    await expect(client.listCheckRuns({ owner: 'o', repo: 'r', ref: 'x' })).rejects.toBeInstanceOf(
      GitDataError,
    );
  });
});
