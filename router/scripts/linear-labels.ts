// Writes the generated label tables into agents/PROTOCOLS.md §5 (HAR-19).
//
//   tsx scripts/linear-labels.ts           rewrite the block in place
//   tsx scripts/linear-labels.ts --check   exit 1 if the block is out of date
//
// validate:fleet runs the same check; this script is how you fix what it reports.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoutingFacts } from '../src/config/linearLabelFacts.js';
import {
  LABELS_PATH,
  PROTOCOLS_PATH,
  crossCheckLinearLabels,
  parseLabelDescriptions,
  renderLabelTables,
  withGeneratedBlock,
} from '../src/config/linearLabels.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { facts, errors } = loadRoutingFacts(repoRoot);
const { descriptions, problems } = parseLabelDescriptions(
  readFileSync(join(repoRoot, LABELS_PATH), 'utf-8'),
);
const all = [
  ...errors,
  ...problems,
  ...(descriptions ? crossCheckLinearLabels(descriptions, facts) : []),
];
if (!descriptions || all.length > 0) {
  console.error(
    `linear-labels: fix these first — the table would be wrong:\n  - ${all.join('\n  - ')}`,
  );
  process.exit(1);
}

const path = join(repoRoot, PROTOCOLS_PATH);
const current = readFileSync(path, 'utf-8');
const next = withGeneratedBlock(current, renderLabelTables(descriptions, facts));
if (process.argv.includes('--check')) {
  if (next !== current) {
    console.error(`${PROTOCOLS_PATH}: out of date — run \`pnpm labels:protocols\``);
    process.exit(1);
  }
  console.log(`${PROTOCOLS_PATH}: label tables up to date`);
} else {
  writeFileSync(path, next);
  console.log(
    next === current
      ? `${PROTOCOLS_PATH}: already up to date`
      : `${PROTOCOLS_PATH}: label tables rewritten`,
  );
}
