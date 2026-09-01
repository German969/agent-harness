// Content-free file operations via the GitHub Git Data API.
//
// Renaming or deleting a file through the high-level Contents API
// (`create_or_update_file` / `delete_file`) requires the file's full content as
// a request parameter — impossible past the MCP token cap (~40KB) and wasteful
// for any large file. The Git Data API works on blob SHAs instead: a rename
// builds a new tree that points the new path at the *existing* blob SHA and
// drops the old path, then commits it. No file content ever moves. This unblocks
// agent-driven refactors that remove/move code, incl. large files (followups
// #12 delete/rename gap, #13 large-file content-transfer wall).

/** Minimal injectable HTTP surface — real impl uses fetch; tests pass a fake. */
export type GitDataHttp = (
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
) => Promise<{ status: number; json: unknown }>;

export type FileOp =
  | { kind: 'move'; from: string; to: string }
  | { kind: 'delete'; path: string }
  | { kind: 'upsert'; path: string; content: string };

export type ApplyOpsRequest = {
  owner: string;
  repo: string;
  branch: string;
  message: string;
  ops: FileOp[];
};

export type ApplyOpsResult = {
  commitSha: string;
  treeSha: string;
  branch: string;
  applied: number;
};

export class GitDataError extends Error {
  override readonly name = 'GitDataError';
  constructor(
    message: string,
    public readonly status?: number,
    public readonly path?: string,
  ) {
    super(message);
  }
}

type TreeEntry = {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string | null;
  content?: string;
};

export class GitDataClient {
  constructor(private readonly http: GitDataHttp) {}

  static fromToken(token: string, baseUrl = 'https://api.github.com'): GitDataClient {
    return new GitDataClient(defaultHttp(token, baseUrl));
  }

  moveFile(args: {
    owner: string;
    repo: string;
    branch: string;
    from: string;
    to: string;
    message: string;
  }): Promise<ApplyOpsResult> {
    return this.applyFileOps({
      owner: args.owner,
      repo: args.repo,
      branch: args.branch,
      message: args.message,
      ops: [{ kind: 'move', from: args.from, to: args.to }],
    });
  }

  deleteFile(args: {
    owner: string;
    repo: string;
    branch: string;
    path: string;
    message: string;
  }): Promise<ApplyOpsResult> {
    return this.applyFileOps({
      owner: args.owner,
      repo: args.repo,
      branch: args.branch,
      message: args.message,
      ops: [{ kind: 'delete', path: args.path }],
    });
  }

  async applyFileOps(req: ApplyOpsRequest): Promise<ApplyOpsResult> {
    if (req.ops.length === 0) throw new GitDataError('no file ops supplied');
    const base = `/repos/${req.owner}/${req.repo}`;

    // 1. Current branch head → base commit → base tree.
    const ref = await this.get(`${base}/git/ref/heads/${req.branch}`);
    const headSha = readString(ref, ['object', 'sha']);
    if (!headSha) throw new GitDataError(`branch not found: ${req.branch}`, undefined, req.branch);
    const commit = await this.get(`${base}/git/commits/${headSha}`);
    const baseTreeSha = readString(commit, ['tree', 'sha']);
    if (!baseTreeSha) throw new GitDataError('base commit has no tree', undefined, headSha);

    // 2. Only fetch the (metadata-only) recursive tree when an op needs an
    //    existing path's blob SHA + mode (move source, delete target).
    const needsExisting = req.ops.some((o) => o.kind === 'move' || o.kind === 'delete');
    const existing = needsExisting ? await this.readTree(base, baseTreeSha) : new Map();

    // 3. Build the new tree entries from the ops.
    const entries: TreeEntry[] = [];
    for (const op of req.ops) {
      if (op.kind === 'move') {
        const src = existing.get(op.from);
        if (!src) throw new GitDataError(`path not found: ${op.from}`, undefined, op.from);
        entries.push({ path: op.to, mode: src.mode, type: 'blob', sha: src.sha });
        entries.push({ path: op.from, mode: src.mode, type: 'blob', sha: null });
      } else if (op.kind === 'delete') {
        const src = existing.get(op.path);
        if (!src) throw new GitDataError(`path not found: ${op.path}`, undefined, op.path);
        entries.push({ path: op.path, mode: src.mode, type: 'blob', sha: null });
      } else {
        entries.push({
          path: op.path,
          mode: '100644',
          type: 'blob',
          sha: null,
          content: op.content,
        });
      }
    }

    // 4. New tree (base_tree keeps everything not mentioned) → commit → move ref.
    const tree = await this.post(`${base}/git/trees`, {
      base_tree: baseTreeSha,
      tree: entries.map((e) =>
        e.content !== undefined
          ? { path: e.path, mode: e.mode, type: e.type, content: e.content }
          : { path: e.path, mode: e.mode, type: e.type, sha: e.sha },
      ),
    });
    const newTreeSha = readString(tree, ['sha']);
    if (!newTreeSha) throw new GitDataError('createTree returned no sha');

    const newCommit = await this.post(`${base}/git/commits`, {
      message: req.message,
      tree: newTreeSha,
      parents: [headSha],
    });
    const newCommitSha = readString(newCommit, ['sha']);
    if (!newCommitSha) throw new GitDataError('createCommit returned no sha');

    await this.patch(`${base}/git/refs/heads/${req.branch}`, { sha: newCommitSha });

    return {
      commitSha: newCommitSha,
      treeSha: newTreeSha,
      branch: req.branch,
      applied: req.ops.length,
    };
  }

  private async readTree(
    base: string,
    treeSha: string,
  ): Promise<Map<string, { sha: string; mode: string }>> {
    const tree = await this.get(`${base}/git/trees/${treeSha}?recursive=1`);
    const out = new Map<string, { sha: string; mode: string }>();
    const rec = tree as { tree?: unknown; truncated?: unknown };
    if (Array.isArray(rec.tree)) {
      for (const node of rec.tree) {
        const n = node as { path?: unknown; sha?: unknown; mode?: unknown; type?: unknown };
        if (n.type === 'blob' && typeof n.path === 'string' && typeof n.sha === 'string') {
          out.set(n.path, { sha: n.sha, mode: typeof n.mode === 'string' ? n.mode : '100644' });
        }
      }
    }
    // A truncated tree may be missing paths we need; callers get a clear
    // "path not found" if so, but flag the underlying cause.
    if (rec.truncated === true) {
      out.set('__truncated__', { sha: '', mode: '' });
    }
    return out;
  }

  /**
   * Reply inside an existing PR review thread.
   *
   * Not git-data, but it belongs on this client because it needs the same App
   * token: the pinned `@modelcontextprotocol/server-github` has no reply tool at
   * all. Its entire PR-comment surface is `add_issue_comment` (a NEW top-level
   * comment) and `create_pull_request_review` (a NEW thread). An agent that fixed
   * exactly what a reviewer asked could therefore only say so somewhere else on
   * the page, leaving the thread itself looking untouched — which is what
   * happened to Copilot's comment on chatbots#11: fixed in `f7a8031`, explained
   * in a top-level comment, and still showing unanswered where a reviewer looks.
   */
  async replyToReviewComment(args: {
    owner: string;
    repo: string;
    pullNumber: number;
    commentId: number;
    body: string;
  }): Promise<{ id: number; url: string }> {
    const json = await this.post(
      `/repos/${args.owner}/${args.repo}/pulls/${args.pullNumber}/comments/${args.commentId}/replies`,
      { body: args.body },
    );
    return {
      id: readNumber(json, ['id']) ?? 0,
      url: readString(json, ['html_url']) ?? '',
    };
  }

  /**
   * Read the CI result for a commit.
   *
   * The pinned MCP github server's only CI tool, `get_pull_request_status`, calls
   * `/commits/{sha}/status` — the legacy Commit Statuses API. GitHub Actions
   * publishes CHECK RUNS, not statuses, so that endpoint reports nothing useful
   * for an Actions-based repo even when it is permitted; against this App it also
   * 403s outright. Builder-Server hit that on four sessions of chatbots#11, said
   * "I have no way to see whether CI passed", and asked a human to paste the
   * result — then left the PR red because it could not see red.
   *
   * `/commits/{ref}/check-runs` is the endpoint that answers the question, and it
   * needs `checks: read`, which the fleet's Apps already hold.
   */
  async listCheckRuns(args: {
    owner: string;
    repo: string;
    ref: string;
  }): Promise<Array<{ name: string; status: string; conclusion: string | null; url: string }>> {
    const json = await this.get(
      `/repos/${args.owner}/${args.repo}/commits/${encodeURIComponent(args.ref)}/check-runs`,
    );
    const runs = (json as { check_runs?: unknown })?.check_runs;
    if (!Array.isArray(runs)) return [];
    return runs.map((run) => ({
      name: readString(run, ['name']) ?? '(unnamed)',
      status: readString(run, ['status']) ?? 'unknown',
      conclusion: readString(run, ['conclusion']) ?? null,
      url: readString(run, ['html_url']) ?? '',
    }));
  }

  private async get(path: string): Promise<unknown> {
    return this.request('GET', path);
  }
  private async post(path: string, body: unknown): Promise<unknown> {
    return this.request('POST', path, body);
  }
  private async patch(path: string, body: unknown): Promise<unknown> {
    return this.request('PATCH', path, body);
  }

  private async request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const { status, json } = await this.http(method, path, body);
    if (status < 200 || status >= 300) {
      const msg = readString(json, ['message']) ?? `HTTP ${status}`;
      throw new GitDataError(`github git-data ${method} ${path} failed: ${msg}`, status, path);
    }
    return json;
  }
}

function defaultHttp(token: string, baseUrl: string): GitDataHttp {
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

function readString(obj: unknown, path: string[]): string | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function readNumber(obj: unknown, path: string[]): number | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'number' ? cur : undefined;
}
