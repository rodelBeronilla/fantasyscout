/**
 * FantasyScout edge Worker.
 *
 *   /data/<key>                 -> object <key> from the R2 bucket, with Range support for DuckDB-WASM;
 *                                  the Parquet tables only for the signed-in owner (owner.ts, ADR 0008)
 *   /auth/owner/*, /api/owner/* -> the owner's sign-in, with the owner's Yahoo account (owner.ts)
 *   /auth/yahoo/*, /api/yahoo/* -> the Yahoo Fantasy league import (yahoo.ts)
 *   /p/{league}/{id}/           -> the player page's shell, titled for the player
 *   /sitemap-players.xml        -> the current build's players, for crawlers
 *
 * Only those paths run the Worker (wrangler.toml run_worker_first); the static-asset layer serves
 * every other page and bundle on its own, with the same security headers from web/dist/_headers
 * (policy.ts, #442). Its secrets are the Yahoo app's client id
 * and secret, which sign the owner in (guarding the bulk Parquet tables) and serve the league import.
 */

import cspHashes from './csp-hashes.json';
import { handleAccount, isAccountWrite, PRIVATE_PREFIX } from './account';
import { type AiEnv, handleAi } from './ai';
import { handleOwner, isOwner, isPrivateData, type OwnerEnv } from './owner';
import { DOCS_CSP, NOTEBOOK_CSP, pagePolicy, STATIC_HEADERS } from './policy';
import { handleYahoo, type YahooEnv } from './yahoo';

interface Env extends YahooEnv, OwnerEnv, AiEnv {
  ASSETS: Fetcher;
  DATA: R2Bucket;
}

const DATA_PREFIX = '/data/';
/** The two pointers the export rewrites. */
const POINTER_KEYS = new Set([
  'latest.json',
  'builds.json',
  'notebooks/findings-history.json',
  'notes/nba.json',
  'notes/wnba.json',
  'notes/evals.json',
  // the one-line notes on flagged players (#823), rewritten every day
  'notes/players/nba.json',
  'notes/players/wnba.json',
]);
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
 * The files a page head preloads before it knows the build id (#436): the board, the streamers,
 * the schedule, the moves, the team-weeks and who takes an out player's minutes (#820) of the
 * current build, and its team list (#562), at an
 * address that does not change. The Worker resolves the pointer, so the page fetches the file
 * beside latest.json instead of after it. Served like a pointer, for a minute; nothing else (no
 * private table, no player file) is reachable this way.
 */
const CURRENT_PATH = /^current\/((?:(?:board|streamers|schedule|transactions|team_weeks|minutes)\/(?:wnba|nba)(?:\.columns)?|dim_team)\.json)$/;

/** The cache-control a data file is served with: a minute for the mutable keys, a year for the rest. */
function clientCache(key: string, isPrivate = false): string {
  return isMutable(key) ? 'public, max-age=60' : `${isPrivate ? 'private' : 'public'}, max-age=31536000, immutable`;
}
/** Player pages are addressed by league and id but rendered by one page. */
const PLAYER_PATH = /^\/p\/(wnba|nba)\/[^/]+\/?$/;

// The policies and headers live in policy.ts, shared with the static-asset layer's _headers file (#442).
const CSP = pagePolicy(cspHashes);

export const SECURITY_HEADERS: Readonly<Record<string, string>> = { 'content-security-policy': CSP, ...STATIC_HEADERS };

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

/**
 * The edge-cache key of a public data file: its origin and path, without the query string. The
 * files are addressed by path alone, so `?v=1` is the same file; keyed on the full URL, every new
 * query string was another R2 read and another cache entry (#445).
 */
function edgeKey(request: Request): Request {
  const url = new URL(request.url);
  return new Request(`${url.origin}${url.pathname}`);
}

/** A current-build page file (CURRENT_PATH): the pointer resolved here, the file served for a minute, from the edge cache when it can be. */
async function serveCurrent(request: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  const cacheable =
    request.method === 'GET' &&
    !request.headers.has('range') &&
    !request.headers.has('if-none-match') &&
    !request.headers.has('if-modified-since');
  if (cacheable) {
    const hit = await caches.default.match(edgeKey(request));
    if (hit) {
      const out = new Response(hit.body, hit);
      out.headers.set('cache-control', 'public, max-age=60');
      return out;
    }
  }
  // The pointer read now: the file itself is what the edge keeps for a minute.
  const build = await pointerBuild(env);
  if (!build) return text(404, 'Not Found');
  const res = await serveData(request, env, `builds/${build}/${path}`);
  const out = new Response(res.body, res);
  out.headers.set('cache-control', 'public, max-age=60');
  out.headers.set('x-build-id', build);
  if (cacheable && out.status === 200) ctx.waitUntil(caches.default.put(edgeKey(request), out.clone()));
  return out;
}

/**
 * The current build's id. The edge keeps it for a minute (#443), the staleness the pointer is
 * served with anyway (ADR 0006), so a player page or the sitemap does not read latest.json from R2
 * on every request.
 */
async function currentBuild(env: Env, origin: string, ctx: ExecutionContext): Promise<string | null> {
  const key = new Request(`${origin}/__edge/current-build`);
  const hit = await caches.default.match(key);
  if (hit) return (await hit.text()) || null;
  const build = await pointerBuild(env);
  if (build) ctx.waitUntil(caches.default.put(key, new Response(build, { headers: { 'cache-control': 'public, max-age=60' } })));
  return build;
}

/** The build latest.json names, read from R2 now. */
async function pointerBuild(env: Env): Promise<string | null> {
  const latest = await env.DATA.get('latest.json');
  if (!latest) return null;
  try {
    return ((await latest.json()) as { build_id?: string }).build_id ?? null;
  } catch {
    return null;
  }
}

/**
 * /sitemap-players.xml: every player file of the current build as a page URL; an hour's cache. The
 * edge keeps it for that hour too (#444): building it lists the bucket (two pages of keys, about
 * 1.5 s), and crawlers fetch sitemaps as often as they like.
 */
async function playersSitemap(env: Env, origin: string, ctx: ExecutionContext): Promise<Response> {
  const key = new Request(`${origin}/sitemap-players.xml`);
  const hit = await caches.default.match(key);
  if (hit) return new Response(hit.body, hit);
  const build = await currentBuild(env, origin, ctx);
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
  const res = new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
  // Only a sitemap of a build is kept: before the first build there is nothing worth an hour.
  if (build) ctx.waitUntil(caches.default.put(key, res.clone()));
  return res;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The player shell with the player's name, team and position in its title, description and Open Graph tags. */
async function namePlayer(shell: Response, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const m = /^\/p\/(wnba|nba)\/([^/]+)\/?$/.exec(url.pathname);
  const build = m ? await currentBuild(env, url.origin, ctx) : null;
  if (!m || !build) return shell;
  const file = await env.DATA.get(`builds/${build}/players/${m[1]}/${m[2]}.json`);
  // A build that has no file for the id has no such player: the same shell, which says so once
  // its script runs, but answered 404, so made-up ids are not an endless set of pages (#410).
  if (!file) return new Response(shell.body, { status: 404, headers: shell.headers });
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

/** How browsers may keep a player page: revalidate every time, like the shell it is made from. */
const PAGE_CACHE = 'public, max-age=0, must-revalidate';

/**
 * A player page: the shell named for the player. The edge keeps each named page for a minute
 * (#443), so a repeat view does not read R2 or rewrite the shell again. The page carries no ETag
 * or Last-Modified: those were the shell's, shared by every player, so a browser revalidating
 * with them got a 304 and kept an old title (#409). The shell is fetched unconditionally for the
 * same reason.
 */
async function playerPage(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  const key = new Request(`${url.origin}${path}`);
  const hit = await caches.default.match(key);
  if (hit) {
    const out = new Response(hit.body, hit);
    out.headers.set('cache-control', PAGE_CACHE);
    return out;
  }
  const shell = await env.ASSETS.fetch(new Request(new URL('/p/', url), { headers: { accept: request.headers.get('accept') ?? 'text/html' } }));
  const named = await namePlayer(shell, env, url, ctx);
  const out = new Response(named.body, named);
  out.headers.delete('etag');
  out.headers.delete('last-modified');
  out.headers.set('cache-control', PAGE_CACHE);
  if (out.status === 200) {
    const html = await out.text();
    const stored = new Response(html, out);
    stored.headers.set('cache-control', 'public, max-age=60');
    ctx.waitUntil(caches.default.put(key, stored));
    return new Response(html, out);
  }
  return out;
}

/** The Worker itself: wrangler.toml names this module as main, so the runtime calls this export. @public */
export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    // The account routes (#684) take PUT and DELETE; everything else is read-only.
    if (request.method !== 'GET' && request.method !== 'HEAD' && !isAccountWrite(request)) {
      const res = text(405, 'Method Not Allowed');
      res.headers.set('allow', 'GET, HEAD');
      return withSecurityHeaders(res);
    }

    // Before the league import: the owner's sign-in shares its Yahoo callback.
    const owner = await handleOwner(request, env);
    if (owner) return withSecurityHeaders(owner, url.pathname);

    const yahoo = await handleYahoo(request, env);
    if (yahoo) return withSecurityHeaders(yahoo, url.pathname);

    const account = await handleAccount(request, env);
    if (account) return withSecurityHeaders(account, url.pathname);

    const ai = await handleAi(request, env);
    if (ai) return withSecurityHeaders(ai, url.pathname);

    if (url.pathname.startsWith(DATA_PREFIX)) {
      // The path is decoded once, here: a path that does not decode is a bad request, not a
      // private table (#411), and the policy is chosen on the decoded path, so a notebook asked
      // for as `01_board_backtest%2Ehtml` still gets the no-script policy (#408).
      let path: string;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        return withSecurityHeaders(text(400, 'Bad Request'), url.pathname);
      }
      // The accounts' setups (#684) sit in the same bucket and are never served as data.
      if (path.slice(DATA_PREFIX.length).startsWith(PRIVATE_PREFIX)) return withSecurityHeaders(text(404, 'Not Found'), path);
      const current = CURRENT_PATH.exec(url.pathname.slice(DATA_PREFIX.length));
      if (current?.[1]) return withSecurityHeaders(await serveCurrent(request, env, ctx, current[1]), path);
      const isPrivate = isPrivateData(url.pathname);
      if (isPrivate && !(await isOwner(request, env))) {
        const res = text(401, 'The raw tables are private: sign in on the SQL page.');
        res.headers.set('cache-control', 'private, no-store');
        return withSecurityHeaders(res, path);
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
        const hit = await caches.default.match(edgeKey(request));
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
          return withSecurityHeaders(out, path);
        }
      }
      const served = withSecurityHeaders(
        await serveData(request, env, url.pathname.slice(DATA_PREFIX.length), isPrivate),
        path,
      );
      if (cacheable && served.status === 200) ctx.waitUntil(caches.default.put(edgeKey(request), served.clone()));
      return served;
    }

    // The players of the current build, one URL each, for crawlers (robots.txt names it).
    if (url.pathname === '/sitemap-players.xml') {
      return withSecurityHeaders(await playersSitemap(env, url.origin, ctx), url.pathname);
    }

    // One static page serves every player: /p/{league}/{player_id}/ -> /p/ (the island reads the URL).
    // The shell's title and description name the player, from the build's player file, so a
    // search result or a link preview says who the page is about before any script runs.
    if (PLAYER_PATH.test(url.pathname)) {
      return withSecurityHeaders(await playerPage(request, env, ctx, url), url.pathname);
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request), url.pathname);
  },
} satisfies ExportedHandler<Env>;
