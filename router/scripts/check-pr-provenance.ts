// Exit shim for the PR provenance gate. All logic lives in src/config/prProvenance.ts
// so it is covered by tsconfig, biome and the test suite — `scripts/` is outside all
// three, which is the wrong place for the code that IS a required check (Copilot, #62).
//
// Inputs, all optional so this is runnable by hand:
//   PR_BODY           the pull request description
//   PR_COMMITS_FILE   path to a file of the branch's commit messages
//   PR_COMMITS        the same, inline
//
// The workflow runs this from a BASE-BRANCH checkout, so `agents/` below is the base
// branch's agent list. A PR that adds a new agent directory cannot use that persona
// until it merges — the right trade, since the alternative lets a PR define the set of
// names its own gate accepts.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProvenance } from '../src/config/prProvenance.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const agentsDir = join(repoRoot, 'agents');

const personas = new Set(
  readdirSync(agentsDir).filter(
    (name) => !name.startsWith('.') && statSync(join(agentsDir, name)).isDirectory(),
  ),
);

const { code, out } = checkProvenance(process.env, {
  personas,
  readFile: (p) => readFileSync(p, 'utf-8'),
});

(code === 0 ? console.log : console.error)(out);
process.exit(code);
