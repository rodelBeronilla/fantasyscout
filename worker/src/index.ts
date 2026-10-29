/**
 * FantasyScout edge Worker.
 *
 *   /data/<key>                 -> object <key> from the R2 bucket, with Range support for DuckDB-WASM
 *   /auth/yahoo/*, /api/yahoo/* -> the Yahoo Fantasy league import (yahoo.ts)
 *   /*                          -> static files from the Astro build (assets binding)
 *
 * Every response carries the security headers below. The data it serves is public and exported;
 * its only secrets are the Yahoo app's client id and secret, for the optional league import.
 */

import cspHashes from './csp-hashes.json';
import { handleYahoo, type YahooEnv } from './yahoo';

export interface Env extends YahooEnv {
  ASSETS: Fetcher;
  DATA: R2Bucket;
}

const DATA_PREFIX = '/data/';
/** The two pointers the export rewrites; everything under builds/ is immutable. */
const POINTER_KEYS = new Set(['latest.json', 'builds.json']);
/** Player pages are addressed by league and id but rendered by one page. */
export const PLAYER_PATH = /^\/p\/(wnba|nba)\/[^/]+\/?$/;

// Hashes of the small scripts and the one style rule Astro inlines into every page, collected
// from the build by scripts/csp-hashes.mjs. Cloudflare's own analytics beacon is allowed too.
const quoted = (hashes: string[]) => hashes.map((h) => `'${h}'`).join(' ');
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com ${quoted(cspHashes.scripts)}`.trim(),
  `style-src 'self' ${quoted(cspHashes.styles)}`.trim(),
  "img-src 'self' data: blob:",
  "font-src 'self'",
  // DuckDB-WASM fetches its Parquet reader as an extension from the DuckDB extension repository.
  "connect-src 'self' blob: https://cloudflareinsights.com https://extensions.duckdb.org",
  "worker-src 'self' blob:",
  'frame-src https://public.tableau.com',
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

// The generated dbt docs site is a single page of inline scripts and styles (an AngularJS app)
// that reads manifest.json and catalog.json next to it. It gets its own policy under /docs/.
const DOCS_CSP = [
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

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CSP,
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  json: 'application/json; charset=utf-8',
  parquet: 'application/vnd.apache.parquet',
  csv: 'text/csv; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  // The DuckDB-WASM engine lives in the bucket under vendor/ (too large for a static asset).
  wasm: 'application/wasm',
  js: 'text/javascript; charset=utf-8',
  // Rendered notebooks live under builds/<id>/notebooks/.
  html: 'text/html; charset=utf-8',
};

/** Rendered notebooks are static pages with inline styles and images; no script may run. */
const NOTEBOOK_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
const NOTEBOOK_PATH = /^\/data\/builds\/[^/]+\/notebooks\/[^/]+\.html$/;

function withSecurityHeaders(response: Response, pathname = '/'): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    out.headers.set(name, value);
  }
  if (pathname === '/docs' || pathname.startsWith('/docs/')) {
    out.headers.set('content-security-policy', DOCS_CSP);
  }
  if (NOTEBOOK_PATH.test(pathname)) {
    out.headers.set('content-security-policy', NOTEBOOK_CSP);
  }
  return out;
}

function contentTypeFor(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export type ByteRange = { offset: number; length?: number } | { suffix: number };

/**
 * Parse a single-range `Range` header into an R2 range.
 * Absent, malformed, multi-range and empty-suffix values return undefined, which serves the whole object.
 */
export function parseRange(header: string | null): ByteRange | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, startText = '', endText = ''] = match;
  if (startText === '' && endText === '') return undefined;
  if (startText === '') {
    const suffix = Number(endText);
    return suffix > 0 ? { suffix } : undefined;
  }
  const offset = Number(startText);
  if (endText === '') return { offset };
  const end = Number(endText);
  return end < offset ? undefined : { offset, length: end - offset + 1 };
}

/** Resolve the byte window actually served so the 206 response can describe it. */
export function contentRange(range: ByteRange, size: number): { start: number; end: number } {
  if ('suffix' in range) {
    return { start: Math.max(0, size - range.suffix), end: size - 1 };
  }
  const end = range.length === undefined ? size - 1 : Math.min(size - 1, range.offset + range.length - 1);
  return { start: range.offset, end };
}

function isSafeKey(key: string): boolean {
  if (key === '' || key.startsWith('/')) return false;
  return key.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

async function serveData(request: Request, env: Env, rawKey: string): Promise<Response> {
  let key: string;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    return text(400, 'Bad Request');
  }
  if (!isSafeKey(key)) return text(404, 'Not Found');

  const range = parseRange(request.headers.get('range'));
  let object: R2Object | R2ObjectBody | null;
  try {
    object = await env.DATA.get(key, { range, onlyIf: request.headers });
  } catch {
    // R2 rejects unsatisfiable ranges (offset past the end of the object).
    return text(416, 'Range Not Satisfiable');
  }
  if (object === null) return text(404, 'Not Found');

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set(
    'cache-control',
    POINTER_KEYS.has(key) ? 'public, max-age=60' : 'public, max-age=31536000, immutable',
  );
  if (!headers.has('content-type')) headers.set('content-type', contentTypeFor(key));

  // A conditional request that was not satisfied comes back without a body.
  if (!('body' in object)) return new Response(null, { status: 304, headers });

  let status = 200;
  if (range) {
    const { start, end } = contentRange(range, object.size);
    headers.set('content-range', `bytes ${start}-${end}/${object.size}`);
    headers.set('content-length', String(end - start + 1));
    status = 206;
  } else {
    headers.set('content-length', String(object.size));
  }
  return new Response(request.method === 'HEAD' ? null : object.body, { status, headers });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const res = text(405, 'Method Not Allowed');
      res.headers.set('allow', 'GET, HEAD');
      return withSecurityHeaders(res);
    }

    const yahoo = await handleYahoo(request, env);
    if (yahoo) return withSecurityHeaders(yahoo, url.pathname);

    if (url.pathname.startsWith(DATA_PREFIX)) {
      return withSecurityHeaders(
        await serveData(request, env, url.pathname.slice(DATA_PREFIX.length)),
        url.pathname,
      );
    }

    // One static page serves every player: /p/{league}/{player_id}/ -> /p/ (the island reads the URL).
    if (PLAYER_PATH.test(url.pathname)) {
      const page = new URL('/p/', url);
      return withSecurityHeaders(await env.ASSETS.fetch(new Request(page, request)));
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request), url.pathname);
  },
} satisfies ExportedHandler<Env>;
