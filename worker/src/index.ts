/**
 * FantasyScout edge Worker.
 *
 *   /data/<key>                 -> object <key> from the R2 bucket, with Range support for DuckDB-WASM;
 *                                  the Parquet tables only for the signed-in owner (owner.ts, ADR 0008)
 *   /auth/owner/*, /api/owner/* -> the owner's sign-in, with the owner's Yahoo account (owner.ts)
 *   /auth/yahoo/*, /api/yahoo/* -> the Yahoo Fantasy league import (yahoo.ts)
 *   /*                          -> static files from the Astro build (assets binding)
 *
 * Every response carries the security headers below. Its secrets are the Yahoo app's client id
 * and secret, which sign the owner in (guarding the bulk Parquet tables) and serve the league import.
 */

import cspHashes from './csp-hashes.json';
import { handleOwner, isOwner, isPrivateData, type OwnerEnv } from './owner';
import { handleYahoo, type YahooEnv } from './yahoo';

export interface Env extends YahooEnv, OwnerEnv {
  ASSETS: Fetcher;
  DATA: R2Bucket;
}

const DATA_PREFIX = '/data/';
/** The two pointers the export rewrites. */
const POINTER_KEYS = new Set(['latest.json', 'builds.json', 'notebooks/findings-history.json']);
/**
 * A build's files never change once written, except the lists of them: the export adds the
 * rendered notebooks and the Tableau extract to a staged build after the fact, rewriting the
 * folder's index.json and the build's keys.txt. Those are served like the pointers, for a minute,
 * so a visitor who opened /notebooks/ while the index listed four notebooks is not held to that
 * list for a year.
 */
const MUTABLE_UNDER_BUILDS = /^builds\/[^/]+\/(?:keys\.txt|(?:[^/]+\/)*index\.json)$/;
function isMutable(key: string): boolean {
  return POINTER_KEYS.has(key) || MUTABLE_UNDER_BUILDS.test(key);
}
/**
 * The files a page head preloads before it knows the build id (#436): the board, the streamers
 * and the schedule of the current build, at an address that does not change. The Worker resolves
 * the pointer, so the page fetches the file beside latest.json instead of after it. Served like a
 * pointer, for a minute; nothing else (no private table, no player file) is reachable this way.
 */
const CURRENT_PATH = /^current\/((?:board|streamers|schedule)\/(?:wnba|nba)(?:\.columns)?\.json)$/;

/** The cache-control a data file is served with: a minute for the mutable keys, a year for the rest. */
function clientCache(key: string, isPrivate = false): string {
  return isMutable(key) ? 'public, max-age=60' : `${isPrivate ? 'private' : 'public'}, max-age=31536000, immutable`;
}
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

async function serveData(request: Request, env: Env, rawKey: string, isPrivate = false): Promise<Response> {
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
    // R2 rejects an unsatisfiable range (an offset past the end of the object); that is the one
    // failure the request caused. Anything else is R2 itself, and the client should try again.
    if (range) return text(416, 'Range Not Satisfiable');
    const res = text(503, 'Service Unavailable');
    res.headers.set('retry-after', '30');
    return res;
  }
  if (object === null) return text(404, 'Not Found');

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', clientCache(key, isPrivate));
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

// The shape export/players.py writes: the team is an object with the abbreviation the pages show.
interface PlayerFile {
  name?: string | null;
  position?: string | null;
  team?: { abbreviation?: string | null; name?: string | null } | string | null;
  league?: string;
}

const teamLabel = (team: PlayerFile['team']): string =>
  typeof team === 'string' ? team : (team?.abbreviation ?? team?.name ?? '');

/** A current-build page file (CURRENT_PATH): the pointer resolved here, the file served for a minute, from the edge cache when it can be. */
async function serveCurrent(request: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  const cacheable =
    request.method === 'GET' &&
    !request.headers.has('range') &&
    !request.headers.has('if-none-match') &&
    !request.headers.has('if-modified-since');
  if (cacheable) {
    const hit = await caches.default.match(request);
    if (hit) {
      const out = new Response(hit.body, hit);
      out.headers.set('cache-control', 'public, max-age=60');
      return out;
    }
  }
  const build = await currentBuild(env);
  if (!build) return text(404, 'Not Found');
  const res = await serveData(request, env, `builds/${build}/${path}`);
  const out = new Response(res.body, res);
  out.headers.set('cache-control', 'public, max-age=60');
  out.headers.set('x-build-id', build);
  if (cacheable && out.status === 200) ctx.waitUntil(caches.default.put(request, out.clone()));
  return out;
}

async function currentBuild(env: Env): Promise<string | null> {
  const latest = await env.DATA.get('latest.json');
  if (!latest) return null;
  try {
    const pointer = (await latest.json()) as { build_id?: string };
    return pointer.build_id ?? null;
  } catch {
    return null;
  }
}

/** /sitemap-players.xml: every player file of the current build as a page URL; an hour's cache. */
async function playersSitemap(env: Env, origin: string): Promise<Response> {
  const build = await currentBuild(env);
  const urls: string[] = [];
  if (build) {
    const prefix = `builds/${build}/players/`;
    let cursor: string | undefined;
    do {
      const page = await env.DATA.list({ prefix, cursor, limit: 1000 });
      for (const object of page.objects) {
        const m = /players\/(wnba|nba)\/([^/]+)\.json$/.exec(object.key);
        if (m) urls.push(`  <url><loc>${origin}/p/${m[1]}/${m[2]}/</loc><changefreq>daily</changefreq></url>`);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The player shell with the player's name, team and position in its title, description and Open Graph tags. */
async function namePlayer(shell: Response, env: Env, url: URL): Promise<Response> {
  const m = /^\/p\/(wnba|nba)\/([^/]+)\/?$/.exec(url.pathname);
  const build = m ? await currentBuild(env) : null;
  if (!m || !build) return shell;
  const file = await env.DATA.get(`builds/${build}/players/${m[1]}/${m[2]}.json`);
  if (!file) return shell;
  let player: PlayerFile;
  try {
    player = (await file.json()) as PlayerFile;
  } catch {
    return shell;
  }
  if (!player.name) return shell;
  const league = (m[1] ?? '').toUpperCase();
  const who = [player.name, [teamLabel(player.team), player.position].filter(Boolean).join(', ')]
    .filter(Boolean)
    .join(' · ');
  const title = escapeHtml(`${who} · ${league} · FantasyScout`);
  const description = escapeHtml(
    `${player.name}: season line, rolling trends, shot chart, game log and category strengths for fantasy basketball (${league}).`,
  );
  const canonical = `${url.origin}${url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`}`;
  const attr = (name: string, value: string) => ({
    element: (e: Element) => {
      e.setAttribute(name, value);
    },
  });
  return new HTMLRewriter()
    .on('title', {
      element: (e) => {
        e.setInnerContent(title, { html: true });
      },
    })
    .on('meta[name="description"]', attr('content', description))
    .on('meta[property="og:title"]', attr('content', title))
    .on('meta[property="og:description"]', attr('content', description))
    .on('meta[property="og:url"]', attr('content', canonical))
    .on('link[rel="canonical"]', attr('href', canonical))
    .transform(shell);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const res = text(405, 'Method Not Allowed');
      res.headers.set('allow', 'GET, HEAD');
      return withSecurityHeaders(res);
    }

    // Before the league import: the owner's sign-in shares its Yahoo callback.
    const owner = await handleOwner(request, env);
    if (owner) return withSecurityHeaders(owner, url.pathname);

    const yahoo = await handleYahoo(request, env);
    if (yahoo) return withSecurityHeaders(yahoo, url.pathname);

    if (url.pathname.startsWith(DATA_PREFIX)) {
      const current = CURRENT_PATH.exec(url.pathname.slice(DATA_PREFIX.length));
      if (current?.[1]) return withSecurityHeaders(await serveCurrent(request, env, ctx, current[1]), url.pathname);
      const isPrivate = isPrivateData(url.pathname);
      if (isPrivate && !(await isOwner(request, env))) {
        const res = text(401, 'The raw tables are private: sign in on the SQL page.');
        res.headers.set('cache-control', 'private, no-store');
        return withSecurityHeaders(res, url.pathname);
      }
      // Public files are kept in the edge cache for as long as their cache-control says (the
      // pointers a minute, a build's files a year), so a page view is answered at the edge rather
      // than by a Worker round trip to R2. Private tables, HEAD, range and conditional requests
      // go to R2 every time.
      const cacheable =
        !isPrivate &&
        request.method === 'GET' &&
        !request.headers.has('range') &&
        !request.headers.has('if-none-match') &&
        !request.headers.has('if-modified-since');
      if (cacheable) {
        const hit = await caches.default.match(request);
        if (hit) {
          // The header the client sees is the Worker's rule, never what the cache stored: the zone's
          // browser cache TTL can rewrite a lower max-age on cached responses, which would hold a
          // pointer in browsers for hours (#382).
          const out = new Response(hit.body, hit);
          let key = url.pathname.slice(DATA_PREFIX.length);
          try {
            key = decodeURIComponent(key);
          } catch {
            // an undecodable path never reached the cache; keep the raw key
          }
          out.headers.set('cache-control', clientCache(key, isPrivate));
          return withSecurityHeaders(out, url.pathname);
        }
      }
      const served = withSecurityHeaders(
        await serveData(request, env, url.pathname.slice(DATA_PREFIX.length), isPrivate),
        url.pathname,
      );
      if (cacheable && served.status === 200) ctx.waitUntil(caches.default.put(request, served.clone()));
      return served;
    }

    // The players of the current build, one URL each, for crawlers (robots.txt names it).
    if (url.pathname === '/sitemap-players.xml') {
      return withSecurityHeaders(await playersSitemap(env, url.origin), url.pathname);
    }

    // One static page serves every player: /p/{league}/{player_id}/ -> /p/ (the island reads the URL).
    // The shell's title and description name the player, from the build's player file, so a
    // search result or a link preview says who the page is about before any script runs.
    if (PLAYER_PATH.test(url.pathname)) {
      const page = new URL('/p/', url);
      const shell = await env.ASSETS.fetch(new Request(page, request));
      return withSecurityHeaders(await namePlayer(shell, env, url), url.pathname);
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request), url.pathname);
  },
} satisfies ExportedHandler<Env>;
