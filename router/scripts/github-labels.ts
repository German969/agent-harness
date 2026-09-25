// Exit shim for the online half of the PR label check (HAR-13). All logic lives in
// src/config/prLabels.ts, where tsconfig, biome and the tests reach it.
//
//   tsx scripts/github-labels.ts            check: fail if a registry label is missing
//   tsx scripts/github-labels.ts --create   create the missing ones, then re-check
//
// Env: GITHUB_TOKEN, and GITHUB_REPOSITORY as `owner/name` (both set in Actions).
// Only the registry entries for the repo named in GITHUB_REPOSITORY are checked;
// the others belong to other repos and are reported as not checked here.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REGISTRY_PATH,
  parseLabelRegistry,
  restLabelClient,
  syncRepoLabels,
} from '../src/config/prLabels.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mode = process.argv.includes('--create') ? 'create' : 'check';

const token = process.env.GITHUB_TOKEN;
const [owner, name] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
if (!token || !owner || !name) {
  console.error('github-labels: needs GITHUB_TOKEN and GITHUB_REPOSITORY=owner/name');
  process.exit(2);
}

const { registry, problems } = parseLabelRegistry(
  readFileSync(join(repoRoot, REGISTRY_PATH), 'utf-8'),
);
if (!registry || problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}

for (const other of registry.keys()) {
  if (other !== name) console.log(`not checked here: labels for '${other}'`);
}
const wanted = registry.get(name);
if (!wanted) {
  console.error(`${REGISTRY_PATH} lists no labels for '${name}'`);
  process.exit(1);
}

try {
  const { code, out } = await syncRepoLabels(
    `${owner}/${name}`,
    wanted,
    restLabelClient(owner, name, token),
    mode,
  );
  (code === 0 ? console.log : console.error)(out);
  process.exit(code);
} catch (err) {
  console.error(`github-labels: ${(err as Error).message}`);
  process.exit(1);
}
