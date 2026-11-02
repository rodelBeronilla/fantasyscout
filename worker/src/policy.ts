/**
 * The security headers and cache rules the site is served with, in one place for both servers (#442):
 *
 *   - the Worker sets them on what it serves itself (/data/, the player pages, sign-in, the sitemap);
 *   - scripts/csp-hashes.mjs writes them into web/dist/_headers, which the static-asset layer applies
 *     to the pages and bundles it serves without invoking the Worker (wrangler.toml run_worker_first).
 *
 * No imports, and only syntax Node can strip: the script loads this file directly.
 */

/** Hashes of the small scripts and style rules Astro inlines into every page. */
export interface InlineHashes {
  scripts: string[];
  styles: string[];
}

const quoted = (hashes: string[]): string => hashes.map((h) => `'${h}'`).join(' ');

/** The pages' policy: their own files, the inlined bits by hash, and Cloudflare's analytics beacon. */
export function pagePolicy(hashes: InlineHashes): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com ${quoted(hashes.scripts)}`.trim(),
    `style-src 'self' ${quoted(hashes.styles)}`.trim(),
    "img-src 'self' data: blob:",
    "font-src 'self'",
    // DuckDB-WASM fetches its Parquet reader as an extension from the DuckDB extension repository;
    // Data Health reads the open data-incident issues from GitHub's public API (#418).
    "connect-src 'self' blob: https://cloudflareinsights.com https://extensions.duckdb.org https://api.github.com",
    "worker-src 'self' blob:",
    'frame-src https://public.tableau.com',
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

// The generated dbt docs site is a single page of inline scripts and styles (an AngularJS app)
// that reads manifest.json and catalog.json next to it. It gets its own policy under /docs/.
export const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** Rendered notebooks are static pages with inline styles and images; no script may run. */
export const NOTEBOOK_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Every response's headers besides its Content-Security-Policy. */
export const STATIC_HEADERS: Readonly<Record<string, string>> = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  // No other site's window keeps a handle on ours, and no other site embeds our files (#435). The
  // sign-ins are full-page redirects, not pop-ups, so the opener policy costs nothing.
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

/** Astro's bundles are named by their content hash, so a browser may keep each one for a year. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Cloudflare rejects a _headers line longer than this. */
export const HEADERS_LINE_LIMIT = 2000;

/**
 * The static-asset layer's _headers file: the security headers on every page, the docs' own
 * policy under /docs/ (the "!" line drops the page policy that the first rule set), and a year's
 * cache for the content-hashed bundles under /_astro/.
 */
export function headersFile(hashes: InlineHashes): string {
  const lines = [
    '# Written by worker/scripts/csp-hashes.mjs from worker/src/policy.ts at every test, dry run and deploy.',
    '/*',
    `  Content-Security-Policy: ${pagePolicy(hashes)}`,
    ...Object.entries(STATIC_HEADERS).map(([name, value]) => `  ${name}: ${value}`),
    '/docs/*',
    '  ! Content-Security-Policy',
    `  Content-Security-Policy: ${DOCS_CSP}`,
    '/_astro/*',
    `  Cache-Control: ${IMMUTABLE}`,
  ];
  const long = lines.find((line) => line.length > HEADERS_LINE_LIMIT);
  if (long) throw new Error(`a _headers line is ${long.length} characters, over Cloudflare's ${HEADERS_LINE_LIMIT}: ${long.slice(0, 80)}...`);
  return lines.join('\n') + '\n';
}
