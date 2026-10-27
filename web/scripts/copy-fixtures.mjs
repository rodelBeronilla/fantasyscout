// Before the Playwright run: put the fixture data build where `astro preview` serves it, so the
// pages read /data/latest.json exactly as they do behind the Worker. The fixture is a real
// export of the dbt sample (fs-export build --engine duckdb --store local --build-id fixture).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, 'tests', 'fixtures', 'data');
const to = join(root, 'dist', 'data');

if (!existsSync(join(root, 'dist'))) {
  console.error('dist/ is missing: run `npm run build` first');
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log(`fixture data copied to ${to}`);
execFileSync(process.execPath, [join(root, 'scripts', 'vendor-duckdb.mjs'), join('dist', 'data')], { stdio: 'inherit' });
