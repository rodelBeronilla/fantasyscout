// Mirror what the deploy puts in the data bucket: the DuckDB-WASM engine under
// <root>/vendor/duckdb-wasm/<version>/, so the SQL console works against `astro preview`
// (dist/data) and `astro dev` (public/data) exactly as it does behind the Worker.
//
//   node scripts/vendor-duckdb.mjs dist/data
//   node scripts/vendor-duckdb.mjs public/data
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/vendor-duckdb.mjs <data root>');
  process.exit(1);
}
const pkg = join(root, 'node_modules', '@duckdb', 'duckdb-wasm');
const { version } = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
const out = join(root, target, 'vendor', 'duckdb-wasm', version);
mkdirSync(out, { recursive: true });
for (const f of ['duckdb-mvp.wasm', 'duckdb-eh.wasm', 'duckdb-browser-mvp.worker.js', 'duckdb-browser-eh.worker.js']) {
  copyFileSync(join(pkg, 'dist', f), join(out, f));
}
console.log(`DuckDB-WASM ${version} copied to ${out}`);
