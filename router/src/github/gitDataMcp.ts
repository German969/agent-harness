// In-process MCP server exposing the Git Data client (content-free move/delete)
// to agents as `mcp__github_gitdata__*`. Registered by the Anthropic SDK adapter
// per session, authed with that session's GitHub App installation token.
//
// Safety: these tools commit directly to the branch they're given (createTree →
// createCommit → updateRef). That would let an agent bypass the PR-only
// discipline the Bash push-gates enforce, so the handlers HARD-REFUSE protected
// branches. Agents commit to a feature branch and open a PR, same as everywhere.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from 'pino';
import { z } from 'zod';
import { type FileOp, type GitDataClient, GitDataError } from './gitData.js';

export const GITHUB_GITDATA_SERVER = 'github_gitdata';

const PROTECTED_BRANCHES = new Set(['main', 'master', 'staging', 'production', 'prod', 'release']);

/** Tool result shape (structurally a CallToolResult). */
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}
function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Returns an error result if the branch is protected, else undefined. */
function protectedBranchError(branch: string): ToolResult | undefined {
  if (PROTECTED_BRANCHES.has(branch.trim().toLowerCase())) {
    return fail(
      `🛑 git-data tools refuse to write to protected branch "${branch}". Commit to a feature branch and open a PR.`,
    );
  }
  return undefined;
}

function errorText(err: unknown): string {
  if (err instanceof GitDataError) {
    return err.status ? `${err.message} (HTTP ${err.status})` : err.message;
  }
  return (err as Error).message ?? String(err);
}

// ---------------------------------------------------------------------------
// Handler logic — pure + testable (the MCP tools are thin wrappers over these).
// ---------------------------------------------------------------------------

export type MoveArgs = {
  owner: string;
  repo: string;
  branch: string;
  from_path: string;
  to_path: string;
  message: string;
};

export async function runMoveFile(
  client: GitDataClient,
  args: MoveArgs,
  log?: Logger,
): Promise<ToolResult> {
  const guard = protectedBranchError(args.branch);
  if (guard) return guard;
  try {
    const r = await client.moveFile({
      owner: args.owner,
      repo: args.repo,
      branch: args.branch,
      from: args.from_path,
      to: args.to_path,
      message: args.message,
    });
    log?.info({ ...r, from: args.from_path, to: args.to_path }, 'git-data: move_file');
    return ok(`Moved ${args.from_path} → ${args.to_path} on ${r.branch} (commit ${r.commitSha}).`);
  } catch (err) {
    return fail(`move_file failed: ${errorText(err)}`);
  }
}

export type DeleteArgs = {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  message: string;
};

export async function runDeleteFile(
  client: GitDataClient,
  args: DeleteArgs,
  log?: Logger,
): Promise<ToolResult> {
  const guard = protectedBranchError(args.branch);
  if (guard) return guard;
  try {
    const r = await client.deleteFile({
      owner: args.owner,
      repo: args.repo,
      branch: args.branch,
      path: args.path,
      message: args.message,
    });
    log?.info({ ...r, path: args.path }, 'git-data: delete_file');
    return ok(`Deleted ${args.path} on ${r.branch} (commit ${r.commitSha}).`);
  } catch (err) {
    return fail(`delete_file failed: ${errorText(err)}`);
  }
}

export type ApplyArgs = {
  owner: string;
  repo: string;
  branch: string;
  message: string;
  ops: Array<{
    op: 'move' | 'delete' | 'upsert';
    from?: string | undefined;
    to?: string | undefined;
    path?: string | undefined;
    content?: string | undefined;
  }>;
};

export async function runApplyFileOps(
  client: GitDataClient,
  args: ApplyArgs,
  log?: Logger,
): Promise<ToolResult> {
  const guard = protectedBranchError(args.branch);
  if (guard) return guard;

  const ops: FileOp[] = [];
  for (const [i, o] of args.ops.entries()) {
    if (o.op === 'move') {
      if (!o.from || !o.to) return fail(`ops[${i}]: move requires "from" and "to"`);
      ops.push({ kind: 'move', from: o.from, to: o.to });
    } else if (o.op === 'delete') {
      if (!o.path) return fail(`ops[${i}]: delete requires "path"`);
      ops.push({ kind: 'delete', path: o.path });
    } else if (o.op === 'upsert') {
      if (!o.path || o.content === undefined)
        return fail(`ops[${i}]: upsert requires "path" and "content"`);
      ops.push({ kind: 'upsert', path: o.path, content: o.content });
    } else {
      return fail(`ops[${i}]: unknown op "${(o as { op: string }).op}"`);
    }
  }

  try {
    const r = await client.applyFileOps({
      owner: args.owner,
      repo: args.repo,
      branch: args.branch,
      message: args.message,
      ops,
    });
    log?.info({ ...r, ops: ops.length }, 'git-data: apply_file_ops');
    return ok(`Applied ${r.applied} file op(s) on ${r.branch} in one commit (${r.commitSha}).`);
  } catch (err) {
    return fail(`apply_file_ops failed: ${errorText(err)}`);
  }
}

// ---------------------------------------------------------------------------
// MCP server assembly.
// ---------------------------------------------------------------------------

const repoShape = {
  owner: z.string().describe('Repository owner (user or org).'),
  repo: z.string().describe('Repository name.'),
  branch: z
    .string()
    .describe('Feature branch to commit to. Protected branches (main/staging/…) are refused.'),
  message: z.string().describe('Commit message.'),
};

/**
 * Build the in-process Git Data MCP server around a GitDataClient. The adapter
 * constructs the client from the session's installation token; tests pass a
 * client backed by a fake HTTP layer.
 */
export function buildGitDataMcpServer(client: GitDataClient, log?: Logger) {
  return createSdkMcpServer({
    name: GITHUB_GITDATA_SERVER,
    version: '0.1.0',
    tools: [
      tool(
        'move_file',
        'Rename/move a file with NO content transfer (works for files past the read/write size cap). Reuses the existing blob SHA.',
        { ...repoShape, from_path: z.string(), to_path: z.string() },
        async (args) => runMoveFile(client, args, log),
      ),
      tool(
        'delete_file',
        'Delete a file via the Git Data API (no content transfer).',
        { ...repoShape, path: z.string() },
        async (args) => runDeleteFile(client, args, log),
      ),
      tool(
        'apply_file_ops',
        'Apply multiple move/delete/upsert operations in a SINGLE commit. ops: [{op:"move",from,to}|{op:"delete",path}|{op:"upsert",path,content}].',
        {
          ...repoShape,
          ops: z
            .array(
              z.object({
                op: z.enum(['move', 'delete', 'upsert']),
                from: z.string().optional(),
                to: z.string().optional(),
                path: z.string().optional(),
                content: z.string().optional(),
              }),
            )
            .describe('Ordered list of file operations applied in one commit.'),
        },
        async (args) => runApplyFileOps(client, args, log),
      ),
      tool(
        'reply_to_review_comment',
        'Reply INSIDE an existing PR review thread, so the reviewer sees the answer where they asked. comment_id is the inline review comment id from get_pull_request_comments. Use this after addressing a review comment — a new top-level comment leaves the thread itself looking unanswered.',
        {
          owner: z.string().describe('Repository owner (user or org).'),
          repo: z.string().describe('Repository name.'),
          pull_number: z.number().int().positive().describe('Pull request number.'),
          comment_id: z
            .number()
            .int()
            .positive()
            .describe('Id of the inline review comment being replied to.'),
          body: z
            .string()
            .describe('Reply text — say what changed and name the commit that changed it.'),
        },
        async (args) => runReplyToReviewComment(client, args, log),
      ),
      tool(
        'get_check_runs',
        'Read CI results for a commit or branch (GitHub Actions check runs). Use this to find out whether CI passed — `get_pull_request_status` reads the legacy commit-status API, which reports nothing for Actions and 403s for this App.',
        {
          owner: z.string().describe('Repository owner (user or org).'),
          repo: z.string().describe('Repository name.'),
          ref: z.string().describe('Commit SHA, branch, or tag to read CI results for.'),
        },
        async (args) => runGetCheckRuns(client, args, log),
      ),
    ],
  });
}

async function runGetCheckRuns(
  client: GitDataClient,
  args: { owner: string; repo: string; ref: string },
  log?: Logger,
): Promise<ToolResult> {
  try {
    const runs = await client.listCheckRuns(args);
    log?.info({ ...args, count: runs.length }, 'git-data: read check runs');
    if (runs.length === 0) {
      return ok(`No check runs for ${args.ref}. CI may not have started yet.`);
    }
    const lines = runs.map(
      (r) => `${r.conclusion ?? r.status}\t${r.name}${r.url ? `\t${r.url}` : ''}`,
    );
    const failing = runs.filter(
      (r) => r.conclusion && !['success', 'neutral', 'skipped'].includes(r.conclusion),
    );
    const verdict = runs.some((r) => r.status !== 'completed')
      ? 'STILL RUNNING'
      : failing.length > 0
        ? `FAILING (${failing.map((r) => r.name).join(', ')})`
        : 'ALL PASSED';
    return ok(`${verdict}\n${lines.join('\n')}`);
  } catch (err) {
    return fail(errorText(err));
  }
}

async function runReplyToReviewComment(
  client: GitDataClient,
  args: { owner: string; repo: string; pull_number: number; comment_id: number; body: string },
  log?: Logger,
): Promise<ToolResult> {
  try {
    const res = await client.replyToReviewComment({
      owner: args.owner,
      repo: args.repo,
      pullNumber: args.pull_number,
      commentId: args.comment_id,
      body: args.body,
    });
    log?.info(
      { owner: args.owner, repo: args.repo, pr: args.pull_number, comment: args.comment_id },
      'git-data: replied to review comment',
    );
    return ok(`Replied in thread on comment ${args.comment_id}: ${res.url}`);
  } catch (err) {
    return fail(errorText(err));
  }
}
