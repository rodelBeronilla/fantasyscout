// Astro inlines a few small scripts (its island loader) and one style rule into every page.
// The Worker's Content-Security-Policy stays at 'self' by listing their SHA-256 hashes, which
// this script collects from the built pages into src/csp-hashes.json before every test, dry
// run and deploy. Run from worker/: `node scripts/csp-hashes.mjs [path/to/web/dist]`.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = process.argv[2] ?? join(here, '..', '..', 'web', 'dist');
const out = join(here, '..', 'src', 'csp-hashes.json');

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* htmlFiles(path);
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
  for (const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
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
