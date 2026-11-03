// Astro inlines a few small scripts (its island loader) and one style rule into every page.
// The Content-Security-Policy stays at 'self' by listing their SHA-256 hashes, which this script
// collects from the built pages into src/csp-hashes.json before every test, dry run and deploy.
// It also writes the build's _headers file from src/policy.ts, so the static-asset layer serves
// pages and bundles with the same headers the Worker sets on what it serves (#442). Node strips
// policy.ts's types on load. Run from worker/: `node scripts/csp-hashes.mjs [path/to/web/dist]`.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { headersFile } from '../src/policy.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dist = process.argv[2] ?? join(here, '..', '..', 'web', 'dist');
const out = join(here, '..', 'src', 'csp-hashes.json');

// The file is generated, not committed (#412): a committed copy went stale whenever the site's
// inline scripts changed. Without a site build there is nothing to hash, so it is written empty
// (the policy then allows no inline script) and the typecheck still finds it.
if (!existsSync(dist)) {
  writeFileSync(out, JSON.stringify({ scripts: [], styles: [] }, null, 2) + '\n');
  console.warn(`${dist} is missing: wrote empty hashes to ${out}; build the site first for a deployable policy`);
  process.exit(0);
}

// The generated dbt docs under dist/docs have their own policy (worker/src/index.ts); skip them.
function* htmlFiles(dir, top = true) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (top && (name === 'docs' || name === 'data')) continue;
      yield* htmlFiles(path, false);
    }
    else if (name.endsWith('.html')) yield path;
  }
}

const hash = (text) => `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;
const scripts = new Set();
const styles = new Set();
let pages = 0;
for (const file of htmlFiles(dist)) {
  pages += 1;
  const html = readFileSync(file, 'utf8');
  for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script\b[^>]*>/gi)) {
    const open = m[0].slice(0, m[0].indexOf('>') + 1);
    if (!/\ssrc=/.test(open) && m[1].trim()) scripts.add(hash(m[1]));
  }
  for (const m of html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)) {
    if (m[1].trim()) styles.add(hash(m[1]));
  }
}
const result = { scripts: [...scripts].sort(), styles: [...styles].sort() };
writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(`${pages} pages: ${result.scripts.length} inline script hash(es), ${result.styles.length} inline style hash(es) -> ${out}`);
writeFileSync(join(dist, '_headers'), headersFile(result));
console.log(`security headers and the bundles' cache rule -> ${join(dist, '_headers')}`);
