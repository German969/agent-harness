// Exit shim for the online half of the Linear label check (HAR-8). All logic lives
// in src/config/linearLabelSync.ts, where tsconfig, biome and the tests reach it.
//
//   tsx scripts/linear-labels-sync.ts --team IRS --agents strategist,platform [--conventions]
//       check (the default): exit 1 listing every label those agents route on that
//       the team does not have, or has only in a different case
//   ... --create
//       create the missing ones with their descriptions, then re-list to verify;
//       a second run is a no-op that says so. Never edits, renames or deletes.
//
// The source of truth is identities/*.yml (routing.linear_labels), LABEL_SKILLS and
// agents/linear-labels.yml, the same inputs validate:fleet checks offline.
// PROTOCOLS.md §5 is generated from them and is not read here.
//
// Env: LINEAR_API_KEY (a personal API key; read access is enough to check, create
// needs write).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoutingFacts } from '../src/config/linearLabelFacts.js';
import {
  graphqlLabelClient,
  syncLinearLabels,
  wantedLinearLabels,
} from '../src/config/linearLabelSync.js';
import { LABELS_PATH, parseLabelDescriptions } from '../src/config/linearLabels.js';
import { defaultGraphQL } from '../src/linear/linearClient.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const team = flag('--team');
const agents = (flag('--agents') ?? '').split(',').filter(Boolean);
const mode = args.includes('--create') ? 'create' : 'check';
const token = process.env.LINEAR_API_KEY;
if (!team || agents.length === 0 || !token) {
  console.error(
    'linear-labels: needs --team <KEY> --agents <a,b,…> [--conventions] [--create] and LINEAR_API_KEY',
  );
  process.exit(2);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { facts, errors } = loadRoutingFacts(repoRoot);
const { descriptions, problems } = parseLabelDescriptions(
  readFileSync(join(repoRoot, LABELS_PATH), 'utf-8'),
);
const scoped = descriptions
  ? wantedLinearLabels(descriptions, facts, agents, { conventions: args.includes('--conventions') })
  : undefined;
const all = [...errors, ...problems, ...(scoped?.problems ?? [])];
if (!scoped || all.length > 0) {
  console.error(`linear-labels: fix these first (pnpm validate:fleet):\n  - ${all.join('\n  - ')}`);
  process.exit(1);
}

try {
  const client = graphqlLabelClient(defaultGraphQL(token, 'https://api.linear.app/graphql'), team);
  const { code, out } = await syncLinearLabels(team, scoped.wanted, client, mode);
  (code === 0 ? console.log : console.error)(out);
  process.exit(code);
} catch (err) {
  console.error(`linear-labels: ${(err as Error).message}`);
  process.exit(1);
}
