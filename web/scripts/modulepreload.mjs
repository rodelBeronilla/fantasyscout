// After `astro build`: give every page a <link rel="modulepreload"> for each module its scripts and
// islands import, so the browser fetches them with the page instead of in waves (#563).
//
// An island loads its component chunk and the React runtime once the page runs, and the component
// chunk then imports the shared chunks it needs (react, ui, data, league-value...): a second round
// trip that a slow phone pays before the page's data can paint. The imports are static and known at
// build time, so they can all start with the HTML. Run from web/: `node scripts/modulepreload.mjs`.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = process.argv[2] ?? join(here, '..', 'dist');
const assets = join(dist, '_astro');

// The page attributes that name a module: an island's component and renderer, and module scripts.
const ENTRY = /(?:component-url|renderer-url|before-hydration-url)="([^"]+\.js)"|<script type="module" src="([^"]+\.js)"/g;
// A chunk's static imports (`import ... from "./x.js"` or `import "./x.js"`); `import("./x.js")`
// is a dynamic import and is left to load when it is asked for.
const STATIC_IMPORT = /(?:\bfrom|\bimport)\s*["']\.\/([^"']+\.js)["']/g;

const graph = new Map();
function importsOf(file) {
  if (!graph.has(file)) {
    const path = join(assets, file);
    const code = existsSync(path) ? readFileSync(path, 'utf8') : '';
    graph.set(file, [...code.matchAll(STATIC_IMPORT)].map((m) => m[1]));
  }
  return graph.get(file);
}

function closure(entries) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    stack.push(...importsOf(file));
  }
  return seen;
}

function* pages(dir, top = true) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      // The dbt docs and the copied data are not this site's pages.
      if (top && (name === 'docs' || name === 'data' || name === '_astro')) continue;
      yield* pages(path, false);
    } else if (name.endsWith('.html')) yield path;
  }
}

let changed = 0;
let links = 0;
for (const page of pages(dist)) {
  const html = readFileSync(page, 'utf8');
  const urls = [...html.matchAll(ENTRY)].map((m) => m[1] ?? m[2]).filter((u) => u.includes('/_astro/'));
  if (!urls.length) continue;
  const prefix = urls[0].slice(0, urls[0].indexOf('/_astro/') + '/_astro/'.length);
  const files = closure(urls.map((u) => u.slice(u.indexOf('/_astro/') + '/_astro/'.length)));
  const tags = [...files]
    .sort()
    .map((f) => `${prefix}${f}`)
    .filter((href) => !html.includes(`rel="modulepreload" href="${href}"`))
    .map((href) => `<link rel="modulepreload" href="${href}">`);
  if (!tags.length) continue;
  writeFileSync(page, html.replace('</head>', `${tags.join('')}</head>`));
  changed += 1;
  links += tags.length;
}
console.log(`modulepreload: ${links} link(s) on ${changed} page(s)`);
