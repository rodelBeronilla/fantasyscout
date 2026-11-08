// Before the Playwright run: put the fixture data build where `astro preview` serves it, so the
// pages read /data/latest.json exactly as they do behind the Worker. The fixture is a real
// export of the dbt sample (fs-export build --engine duckdb --store local --build-id fixture).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, 'tests', 'fixtures', 'data');
const to = join(root, 'dist', 'data');

// `--clean` (the posttest script) removes the copy again: the 77 MB engine must not end up in
// the dist artifact the Worker job and the deploy read (static assets are capped at 25 MiB each).
if (process.argv.includes('--clean')) {
  rmSync(to, { recursive: true, force: true });
  console.log(`fixture data removed from ${to}`);
  process.exit(0);
}
if (!existsSync(join(root, 'dist'))) {
  console.error('dist/ is missing: run `npm run build` first');
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
// The Worker answers /data/current/<page file> from the build latest.json names (#436); the preview
// has no Worker, so the copy puts those files there too and the pages read them the same way.
const build = JSON.parse(readFileSync(join(to, 'latest.json'), 'utf8')).build_id;
for (const kind of ['board', 'streamers', 'schedule', 'transactions', 'team_weeks', 'minutes', 'dim_team.json']) {
  const source = join(to, 'builds', build, kind);
  if (!existsSync(source)) continue;
  mkdirSync(join(to, 'current'), { recursive: true });
  cpSync(source, join(to, 'current', kind), { recursive: true });
}
console.log(`fixture data copied to ${to}`);
execFileSync(process.execPath, [join(root, 'scripts', 'vendor-duckdb.mjs'), join('dist', 'data')], { stdio: 'inherit' });
