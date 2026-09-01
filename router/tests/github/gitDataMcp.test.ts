import { describe, expect, it } from 'vitest';
import { GitDataClient, type GitDataHttp } from '../../src/github/gitData.js';
import { runApplyFileOps, runDeleteFile, runMoveFile } from '../../src/github/gitDataMcp.js';

/** Scripted Git Data API on `feature`; records calls so we can assert none fire. */
function makeClient(opts: { failRef?: boolean } = {}): { client: GitDataClient; calls: string[] } {
  const calls: string[] = [];
  const http: GitDataHttp = async (method, path) => {
    calls.push(`${method} ${path}`);
    if (path.includes('/git/ref/heads/')) {
      if (opts.failRef) return { status: 404, json: { message: 'Not Found' } };
      return { status: 200, json: { object: { sha: 'C0' } } };
    }
    if (path.includes('/git/commits/C0')) return { status: 200, json: { tree: { sha: 'T0' } } };
    if (path.includes('/git/trees/T0')) {
      return {
        status: 200,
        json: { tree: [{ path: 'docs/big.md', type: 'blob', sha: 'B1', mode: '100644' }] },
      };
    }
    if (method === 'POST' && path.endsWith('/git/trees'))
      return { status: 201, json: { sha: 'T1' } };
    if (method === 'POST' && path.endsWith('/git/commits'))
      return { status: 201, json: { sha: 'C1' } };
    if (method === 'PATCH') return { status: 200, json: {} };
    return { status: 404, json: { message: 'unexpected' } };
  };
  return { client: new GitDataClient(http), calls };
}

const REPO = { owner: 'German969', repo: 'chatbots', branch: 'feature', message: 'move' };

describe('runMoveFile', () => {
  it('moves a file and reports the commit', async () => {
    const { client } = makeClient();
    const r = await runMoveFile(client, {
      ...REPO,
      from_path: 'docs/big.md',
      to_path: 'docs/legacy/big.md',
    });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toContain('docs/legacy/big.md');
    expect(r.content[0]?.text).toContain('C1');
  });

  it('surfaces a GitHub error as an error result (not a throw)', async () => {
    const { client } = makeClient({ failRef: true });
    const r = await runMoveFile(client, { ...REPO, from_path: 'a', to_path: 'b' });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain('Not Found');
  });
});

describe('protected-branch guard', () => {
  for (const branch of ['main', 'Master', 'staging', 'production', 'prod', 'release']) {
    it(`refuses to write to "${branch}" and makes no API calls`, async () => {
      const { client, calls } = makeClient();
      const r = await runMoveFile(client, { ...REPO, branch, from_path: 'a', to_path: 'b' });
      expect(r.isError).toBe(true);
      expect(r.content[0]?.text).toContain('protected branch');
      expect(calls).toHaveLength(0); // short-circuits before any network call
    });
  }

  it('also guards delete + apply_file_ops', async () => {
    const { client } = makeClient();
    const del = await runDeleteFile(client, { ...REPO, branch: 'main', path: 'x' });
    const apply = await runApplyFileOps(client, {
      ...REPO,
      branch: 'main',
      ops: [{ op: 'delete', path: 'x' }],
    });
    expect(del.isError).toBe(true);
    expect(apply.isError).toBe(true);
  });
});

describe('runApplyFileOps validation', () => {
  it('rejects a move op missing "to"', async () => {
    const { client } = makeClient();
    const r = await runApplyFileOps(client, { ...REPO, ops: [{ op: 'move', from: 'a' }] });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain('requires "from" and "to"');
  });

  it('rejects an upsert missing content', async () => {
    const { client } = makeClient();
    const r = await runApplyFileOps(client, { ...REPO, ops: [{ op: 'upsert', path: 'a' }] });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain('requires "path" and "content"');
  });

  it('applies a valid delete op', async () => {
    const { client } = makeClient();
    const r = await runApplyFileOps(client, {
      ...REPO,
      ops: [{ op: 'delete', path: 'docs/big.md' }],
    });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toContain('1 file op');
  });
});
