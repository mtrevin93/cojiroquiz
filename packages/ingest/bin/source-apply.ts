/** Usage: node bin/source-apply.ts <database.db> <bundleDir>   (local databases only) */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openDb } from '@cojiro/db';
import { applyBundle } from '../src/source-apply.ts';
import type { Bundle } from '../src/source-prepare.ts';

const [dbPath, bundleDir, flag] = process.argv.slice(2);
if (!dbPath || !bundleDir) {
  console.error('Usage: node bin/source-apply.ts <database.db> <bundleDir> [--game-names]');
  process.exit(1);
}
const bundle = JSON.parse(await readFile(join(bundleDir, 'bundle.json'), 'utf8')) as Bundle;
const report = applyBundle(openDb(dbPath), bundle, Date.now(), { gameNamesOnly: flag === '--game-names' });
console.log(JSON.stringify({ ...report, conflicts: report.conflicts, unmatched: report.unmatched.map((u) => u.id) }, null, 1));
