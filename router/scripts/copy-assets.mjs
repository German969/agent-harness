// Post-build asset copy. tsc only emits .js/.d.ts/.map; non-TS files need
// explicit copy so the built artifact (dist/) is fully self-contained.

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const assets = [
  { from: 'src/state/migrations', to: 'dist/state/migrations', pattern: /\.sql$/ },
];

for (const a of assets) {
  const fromAbs = join(ROOT, a.from);
  const toAbs = join(ROOT, a.to);
  if (!existsSync(fromAbs)) {
    console.warn(`[copy-assets] skip: ${a.from} does not exist`);
    continue;
  }
  mkdirSync(toAbs, { recursive: true });
  cpSync(fromAbs, toAbs, {
    recursive: true,
    filter: (src) => {
      // Allow directories; allow files matching the pattern.
      if (src.endsWith('/') || !src.includes('.')) return true;
      return a.pattern.test(src);
    },
  });
  console.log(`[copy-assets] copied ${a.from} → ${a.to}`);
}
