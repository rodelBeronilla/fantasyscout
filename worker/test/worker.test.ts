// Runs inside workerd via @cloudflare/vitest-plugin, with the real assets binding
// (web/dist must be built first) and an isolated R2 bucket per test.
import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentRange, parseRange, SECURITY_HEADERS } from '../src/index';
import { DOCS_CSP, headersFile, IMMUTABLE, STATIC_HEADERS } from '../src/policy';
import { ciReaderKey, sessionCookie } from '../src/owner';

const ORIGIN = 'https://fantasyscout.example';
/** CI's reader key, derived from the Yahoo client secret in the test bindings (vitest.config.ts). */
let OWNER: Record<string, string> = {};
beforeAll(async () => {
  OWNER = { authorization: `Bearer ${await ciReaderKey('test-client-secret')}` };
});

describe('parseRange', () => {
  it('parses the single-range forms DuckDB-WASM sends', () => {
    expect(parseRange('bytes=10-19')).toEqual({ offset: 10, length: 10 });
    expect(parseRange('bytes=10-')).toEqual({ offset: 10 });
    expect(parseRange('bytes=-8')).toEqual({ suffix: 8 });
  });

  it('ignores absent, malformed, inverted, empty and multi-range values', () => {
    expect(parseRange(null)).toBeUndefined();
    expect(parseRange('bytes=-')).toBeUndefined();
    expect(parseRange('bytes=-0')).toBeUndefined();
    expect(parseRange('bytes=20-10')).toBeUndefined();
    expect(parseRange('bytes=0-1,5-6')).toBeUndefined();
    expect(parseRange('items=0-1')).toBeUndefined();
  });

  it('clamps the served window to the object size', () => {
    expect(contentRange({ offset: 90, length: 50 }, 100)).toEqual({ start: 90, end: 99 });
    expect(contentRange({ suffix: 500 }, 100)).toEqual({ start: 0, end: 99 });
    expect(contentRange({ offset: 5 }, 100)).toEqual({ start: 5, end: 99 });
  });
});

describe('routing', () => {
  it('allows the scripts and style Astro inlines, by hash', async () => {
    const res = await SELF.fetch(`${ORIGIN}/`);
    const csp = res.headers.get('content-security-policy') ?? '';
    const html = await res.text();
    const inline = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].filter(
      (m) => !/\ssrc=/.test(m[0].slice(0, m[0].indexOf('>') + 1)) && m[1]!.trim(),
    );
    expect(inline.length).toBeGreaterThan(0);
    for (const m of inline) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m[1]!));
      const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
      expect(csp).toContain(`'sha256-${b64}'`);
    }
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain('https://extensions.duckdb.org');
  });

  it('serves the home page with security headers', async () => {
    const res = await SELF.fetch(`${ORIGIN}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("'wasm-unsafe-eval'");
    expect(res.headers.get('content-security-policy')).toContain('frame-src https://public.tableau.com');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toContain('FantasyScout');
  });

  it('names the player in the shell when the current build has the player file', async () => {
    // the suite's R2 state is shared and the data tests seed latest.json as build 'test' before each of
    // theirs; these two seed the same pointer and add to that build, so nothing leaks between tests
    await env.DATA.put('latest.json', JSON.stringify({ build_id: 'test' }), { httpMetadata: { contentType: 'application/json' } });
    await env.DATA.put('builds/test/players/wnba/1628932.json', JSON.stringify({ name: "A'ja Wilson", team: { team_id: '1611661319', abbreviation: 'LVA', name: 'Aces' }, position: 'F' }));
    const res = await SELF.fetch(`${ORIGIN}/p/wnba/1628932/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>A'ja Wilson · LVA, F · WNBA · FantasyScout</title>");
    expect(html).toContain(`property="og:title" content="A'ja Wilson · LVA, F · WNBA · FantasyScout"`);
    expect(html).toContain('name="description" content="A&#39;ja Wilson: season line'.replace('&#39;', "'"));
    expect(html).toContain(`rel="canonical" href="${ORIGIN}/p/wnba/1628932/"`);
    // a player the build does not have keeps the plain shell, answered 404 (#410)
    const other = await SELF.fetch(`${ORIGIN}/p/wnba/999999999/`);
    expect(other.status).toBe(404);
    expect(await other.text()).toContain('<title>Player · FantasyScout</title>');
  });

  it('keeps a named player page at the edge for a minute, with none of the shell\'s validators (#443, #409)', async () => {
    await env.DATA.put('latest.json', JSON.stringify({ build_id: 'test' }), { httpMetadata: { contentType: 'application/json' } });
    await env.DATA.put('builds/test/players/nba/77.json', JSON.stringify({ name: 'Edge Player', team: { abbreviation: 'BOS' }, position: 'G' }));
    const url = `${ORIGIN}/p/nba/77/`;
    try {
      const first = await SELF.fetch(url);
      expect(await first.text()).toContain('<title>Edge Player · BOS, G · NBA · FantasyScout</title>');
      expect(first.headers.get('etag')).toBeNull();
      expect(first.headers.get('last-modified')).toBeNull();
      expect(first.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
      expect(first.headers.get('content-security-policy')).toContain("default-src 'self'");
      // the edge copy lands once the response is out
      for (let i = 0; i < 50 && !(await caches.default.match(new Request(url))); i++) await new Promise((r) => setTimeout(r, 20));
      expect(await caches.default.match(new Request(url))).toBeTruthy();
      expect(await caches.default.match(new Request(`${ORIGIN}/__edge/current-build`))).toBeTruthy();
      // with the file gone from R2, the repeat view still comes from the edge
      await env.DATA.delete('builds/test/players/nba/77.json');
      const second = await SELF.fetch(url);
      expect(await second.text()).toContain('Edge Player');
      expect(second.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
      // the shell's validator no longer answers 304 for a named page
      await env.DATA.put('builds/test/players/nba/78.json', JSON.stringify({ name: 'Second Player' }));
      const shellTag = (await SELF.fetch(`${ORIGIN}/p/`)).headers.get('etag') ?? '"shell"';
      const conditional = await SELF.fetch(`${ORIGIN}/p/nba/78/`, { headers: { 'if-none-match': shellTag } });
      expect(conditional.status).toBe(200);
      expect(await conditional.text()).toContain('Second Player');
    } finally {
      await caches.default.delete(new Request(url));
      await caches.default.delete(new Request(`${ORIGIN}/p/nba/78/`));
      await caches.default.delete(new Request(`${ORIGIN}/__edge/current-build`));
    }
  });

  it('serves a sitemap of the current build\'s players', async () => {
    await env.DATA.put('latest.json', JSON.stringify({ build_id: 'test' }), { httpMetadata: { contentType: 'application/json' } });
    await env.DATA.put('builds/test/players/wnba/1.json', '{}');
    await env.DATA.put('builds/test/players/nba/2.json', '{}');
    await env.DATA.put('builds/test/players/index.json', '{}');
    const res = await SELF.fetch(`${ORIGIN}/sitemap-players.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    const xml = await res.text();
    expect(xml).toContain(`<loc>${ORIGIN}/p/wnba/1/</loc>`);
    expect(xml).toContain(`<loc>${ORIGIN}/p/nba/2/</loc>`);
    expect(xml).not.toContain('index');
    // The edge keeps it for the hour (#444): with listing broken, the second request still answers.
    const key = new Request(`${ORIGIN}/sitemap-players.xml`);
    for (let i = 0; i < 50 && !(await caches.default.match(key)); i++) await new Promise((r) => setTimeout(r, 20));
    const spy = vi.spyOn(env.DATA, 'list').mockRejectedValue(new Error('r2 down'));
    try {
      const again = await SELF.fetch(`${ORIGIN}/sitemap-players.xml`);
      expect(again.status).toBe(200);
      expect(await again.text()).toContain(`<loc>${ORIGIN}/p/nba/2/</loc>`);
      expect(again.headers.get('x-content-type-options')).toBe('nosniff');
    } finally {
      spy.mockRestore();
      await caches.default.delete(key);
    }
  });

  it('serves the player page for a /p/{league}/{id}/ address the build has', async () => {
    await env.DATA.put('latest.json', JSON.stringify({ build_id: 'test' }), { httpMetadata: { contentType: 'application/json' } });
    await env.DATA.put('builds/test/players/wnba/1629476.json', JSON.stringify({ name: 'Some Player' }));
    const res = await SELF.fetch(`${ORIGIN}/p/wnba/1629476/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('FantasyScout');
    const miss = await SELF.fetch(`${ORIGIN}/p/xyz/1/`);
    expect(miss.status).toBe(404);
  });

  it('gives the dbt docs their own policy and nothing else', async () => {
    const docs = await SELF.fetch(`${ORIGIN}/docs/manifest.json`);
    expect(docs.headers.get('content-security-policy')).toContain("'unsafe-eval'");
    for (const path of ['/', '/data/latest.json']) {
      const csp = (await SELF.fetch(`${ORIGIN}${path}`)).headers.get('content-security-policy') ?? '';
      expect(csp).not.toContain("'unsafe-inline'");
      expect(csp).not.toContain("'unsafe-eval'");
    }
  });

  it('serves rendered notebooks with a no-script policy', async () => {
    const res = await SELF.fetch(`${ORIGIN}/data/builds/b1/notebooks/01_shot_profiles.html`);
    expect(res.status).toBe(404); // not seeded; the policy is chosen by path
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('content-security-policy')).toContain("style-src 'unsafe-inline'");
    const other = await SELF.fetch(`${ORIGIN}/data/builds/b1/health.json`);
    expect(other.headers.get('content-security-policy')).not.toContain("default-src 'none'");
    // the same notebook with its dot encoded is the same file, so the same policy (#408)
    const encoded = await SELF.fetch(`${ORIGIN}/data/builds/b1/notebooks/01_shot_profiles%2Ehtml`);
    expect(encoded.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('answers a /data/ path that does not decode with 400, not as a private table (#411)', async () => {
    for (const path of ['/data/%', '/data/builds/%E0%A4%A.parquet']) {
      const res = await SELF.fetch(`${ORIGIN}${path}`);
      expect(res.status, path).toBe(400);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('serves the 404 page for unknown paths', async () => {
    const res = await SELF.fetch(`${ORIGIN}/nope/`);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toContain('No such page');
  });

  it('rejects write methods', async () => {
    const res = await SELF.fetch(`${ORIGIN}/`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });
});

// The asset layer serves the pages and bundles without the Worker (#442): its _headers file must
// give them exactly what the Worker gives the paths it serves.
describe('the static-asset layer', () => {
  it('serves a page with the same headers the Worker sets', async () => {
    for (const path of ['/', '/streamers/', '/health/', '/nope/']) {
      const res = await SELF.fetch(`${ORIGIN}${path}`);
      expect(res.headers.get('content-security-policy'), path).toBe(SECURITY_HEADERS['content-security-policy']);
      for (const [name, value] of Object.entries(STATIC_HEADERS)) expect(res.headers.get(name), `${path} ${name}`).toBe(value);
    }
  });

  it('serves the content-hashed bundles for a year, and the pages for no time at all', async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/`)).text();
    const bundle = html.match(/\/_astro\/[^"']+\.js/)?.[0];
    expect(bundle).toBeTruthy();
    const res = await SELF.fetch(`${ORIGIN}${bundle}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await SELF.fetch(`${ORIGIN}/`)).headers.get('cache-control') ?? '').not.toContain('immutable');
  });

  it('gives the docs their policy alone, not joined to the pages\' one', async () => {
    // CI's build has no dbt docs (the deploy adds them), so this is the 404 page under /docs/: the
    // rule follows the path either way.
    for (const path of ['/docs/', '/docs/manifest.json']) {
      expect((await SELF.fetch(`${ORIGIN}${path}`)).headers.get('content-security-policy'), path).toBe(DOCS_CSP);
    }
  });

  it('writes a _headers file Cloudflare accepts', () => {
    const file = headersFile({ scripts: ['sha256-a'], styles: ['sha256-b'] });
    expect(file.split('\n').filter((l) => /^\S/.test(l) && !l.startsWith('#'))).toEqual(['/*', '/docs/*', '/_astro/*']);
    expect(file).toContain("script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com 'sha256-a'");
    const many = { scripts: Array.from({ length: 40 }, (_, i) => `sha256-${'x'.repeat(43)}${i}`), styles: [] };
    expect(() => headersFile(many)).toThrow(/over Cloudflare's/);
  });
});

describe('data', () => {
  const body = new Uint8Array(100).map((_, i) => i);

  beforeEach(async () => {
    await env.DATA.put('latest.json', JSON.stringify({ build_id: 'test' }), {
      httpMetadata: { contentType: 'application/json' },
    });
    await env.DATA.put('builds.json', JSON.stringify([{ build_id: 'test' }]), {
      httpMetadata: { contentType: 'application/json' },
    });
    await env.DATA.put('build-1/fct_shot.parquet', body);
  });

  it('serves latest.json with a short cache', async () => {
    const res = await SELF.fetch(`${ORIGIN}/data/latest.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await res.json()).toEqual({ build_id: 'test' });
  });

  it('serves the notebook findings history with a short cache, since every build rewrites it', async () => {
    await env.DATA.put('notebooks/findings-history.json', '{"notebooks":{}}', { httpMetadata: { contentType: 'application/json' } });
    const res = await SELF.fetch(`${ORIGIN}/data/notebooks/findings-history.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('serves builds.json with a short cache too', async () => {
    const res = await SELF.fetch(`${ORIGIN}/data/builds.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await res.json()).toEqual([{ build_id: 'test' }]);
  });

  it("serves a build's index files and key list with the pointers' short cache, since the export rewrites them", async () => {
    for (const key of ['builds/b1/notebooks/index.json', 'builds/b1/tableau/index.json', 'builds/b1/keys.txt']) {
      await env.DATA.put(key, key.endsWith('.json') ? '{"files":[]}' : 'builds/b1/health.json');
      const res = await SELF.fetch(`${ORIGIN}/data/${key}`);
      expect(res.status, key).toBe(200);
      expect(res.headers.get('cache-control'), key).toBe('public, max-age=60');
    }
    // A notebook itself, or anything else under the build, stays immutable.
    await env.DATA.put('builds/b1/notebooks/01_board_backtest.html', '<html></html>');
    const page = await SELF.fetch(`${ORIGIN}/data/builds/b1/notebooks/01_board_backtest.html`);
    expect(page.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('serves a pointer from the edge cache with a minute of cache-control, whatever the cache stored', async () => {
    // The zone's browser cache TTL can rewrite a cached response's max-age; the Worker's rule wins.
    // The suite shares one edge cache, so the doctored entries are removed again at the end.
    const pointer = new Request(`${ORIGIN}/data/latest.json`);
    const file = new Request(`${ORIGIN}/data/builds/c0/board/nba.json`);
    try {
      await caches.default.put(
        pointer,
        new Response(JSON.stringify({ build_id: 'test' }), {
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=14400', etag: '"doctored"' },
        }),
      );
      const res = await SELF.fetch(pointer.url);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=60');
      expect(await res.json()).toEqual({ build_id: 'test' });
      // an immutable build file keeps the year-long rule on a hit too
      await caches.default.put(
        file,
        new Response('[]', { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=14400' } }),
      );
      const served = await SELF.fetch(file.url);
      expect(served.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    } finally {
      await caches.default.delete(pointer);
      await caches.default.delete(file);
    }
  });

  it("serves the current build's board, streamers and schedule at a stable address, for a minute (#436)", async () => {
    await env.DATA.put('builds/test/board/nba.json', '[{"player_id":"7"}]', {
      httpMetadata: { contentType: 'application/json' },
    });
    const address = new Request(`${ORIGIN}/data/current/board/nba.json`);
    try {
      const res = await SELF.fetch(address);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=60');
      expect(res.headers.get('x-build-id')).toBe('test');
      expect(await res.json()).toEqual([{ player_id: '7' }]);
      // the column-wise copy (#535) by the same rule
      await env.DATA.put('builds/test/board/nba.columns.json', '{"player_id":["7"]}', {
        httpMetadata: { contentType: 'application/json' },
      });
      const columns = await SELF.fetch(`${ORIGIN}/data/current/board/nba.columns.json`);
      expect(columns.status).toBe(200);
      expect(await columns.json()).toEqual({ player_id: ['7'] });
      await caches.default.delete(new Request(`${ORIGIN}/data/current/board/nba.columns.json`));
      // a file the build does not have, and anything but the page files, is not found here
      expect((await SELF.fetch(`${ORIGIN}/data/current/streamers/wnba.json`)).status).toBe(404);
      // the other files Streamers reads (#562)
      await env.DATA.put('builds/test/dim_team.json', '[]', { httpMetadata: { contentType: 'application/json' } });
      await env.DATA.put('builds/test/team_weeks/wnba.json', '[]', { httpMetadata: { contentType: 'application/json' } });
      for (const path of ['current/dim_team.json', 'current/team_weeks/wnba.json']) {
        const res = await SELF.fetch(`${ORIGIN}/data/${path}`);
        expect(res.status, path).toBe(200);
        expect(res.headers.get('x-build-id')).toBe('test');
        await caches.default.delete(new Request(`${ORIGIN}/data/${path}`));
      }
      for (const path of ['current/board/xyz.json', 'current/players/wnba/1.json', 'current/fct_shot.parquet', 'current/dim_player.json', 'current/transactions/wnba.columns.json.x']) {
        expect((await SELF.fetch(`${ORIGIN}/data/${path}`)).status).not.toBe(200);
      }
    } finally {
      await caches.default.delete(address);
    }
  });

  it('answers a public build file from the edge cache the second time', async () => {
    await env.DATA.put('builds/c1/board/nba.json', '[{"player_id":"1"}]', {
      httpMetadata: { contentType: 'application/json' },
    });
    const first = await SELF.fetch(`${ORIGIN}/data/builds/c1/board/nba.json`);
    expect(first.status).toBe(200);
    await first.text();
    // R2 gone: the cached copy still answers.
    const spy = vi.spyOn(env.DATA, 'get').mockRejectedValue(new Error('r2 down'));
    try {
      const second = await SELF.fetch(`${ORIGIN}/data/builds/c1/board/nba.json`);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual([{ player_id: '1' }]);
      // A range request, and a private table, bypass the cache and reach R2.
      const ranged = await SELF.fetch(`${ORIGIN}/data/builds/c1/board/nba.json`, { headers: { range: 'bytes=0-3' } });
      expect(ranged.status).not.toBe(200);
      await SELF.fetch(`${ORIGIN}/data/build-1/fct_shot.parquet`, { headers: OWNER });
    } finally {
      spy.mockRestore();
    }
    const priv = await SELF.fetch(`${ORIGIN}/data/build-1/fct_shot.parquet`, { headers: OWNER });
    expect(priv.status).toBe(200);
    expect(priv.headers.get('cache-control')).toContain('private');
  });


  it('answers an R2 failure with 503 and retry-after, not 416', async () => {
    const spy = vi.spyOn(env.DATA, 'get').mockRejectedValueOnce(new Error('r2 down'));
    try {
      const res = await SELF.fetch(`${ORIGIN}/data/builds/test/board/nba.json`);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('30');
      expect(res.headers.get('cache-control')).toBe('no-store');
    } finally {
      spy.mockRestore();
    }
  });

  it('still answers 416 when a range was asked and R2 refused it', async () => {
    const spy = vi.spyOn(env.DATA, 'get').mockRejectedValueOnce(new Error('range not satisfiable'));
    try {
      const res = await SELF.fetch(`${ORIGIN}/data/build-1/fct_shot.parquet`, {
        headers: { ...OWNER, range: 'bytes=500-' },
      });
      expect(res.status).toBe(416);
    } finally {
      spy.mockRestore();
    }
  });

  it('answers HEAD with the headers and no body', async () => {
    const res = await SELF.fetch(`${ORIGIN}/data/build-1/fct_shot.parquet`, { method: 'HEAD', headers: OWNER });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('100');
    expect(res.headers.get('etag')).toBeTruthy();
    expect(await res.text()).toBe('');
  });

  it('a build that was pruned is simply not found', async () => {
    const res = await SELF.fetch(`${ORIGIN}/data/builds/gone/board/nba.json`);
    expect(res.status).toBe(404);
  });

  it('serves build files as immutable with a parquet content type', async () => {
    const res = await SELF.fetch(`${ORIGIN}/data/build-1/fct_shot.parquet`, { headers: OWNER });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('content-type')).toBe('application/vnd.apache.parquet');
    expect(res.headers.get('content-length')).toBe('100');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
  });

  it('honours Range requests for DuckDB-WASM', async () => {
    const res = await SELF.fetch(`${ORIGIN}/data/build-1/fct_shot.parquet`, {
      headers: { ...OWNER, range: 'bytes=10-19' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 10-19/100');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(body.slice(10, 20));
  });

  it('honours suffix Range requests (parquet footers)', async () => {
    const res = await SELF.fetch(`${ORIGIN}/data/build-1/fct_shot.parquet`, {
      headers: { ...OWNER, range: 'bytes=-8' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 92-99/100');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(body.slice(92));
  });

  it('answers conditional requests with 304', async () => {
    const first = await SELF.fetch(`${ORIGIN}/data/latest.json`);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const res = await SELF.fetch(`${ORIGIN}/data/latest.json`, {
      headers: { 'if-none-match': etag as string },
    });
    expect(res.status).toBe(304);
  });

  it('returns 404 for missing objects and traversal attempts', async () => {
    expect((await SELF.fetch(`${ORIGIN}/data/missing.json`)).status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/data/..%2Fsecret`)).status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/data/`)).status).toBe(404);
  });
});

describe('the Yahoo league import', () => {
  it('answers through the Worker with the security headers, and stays parked until YAHOO_IMPORT is on', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/yahoo/status`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(await res.json()).toEqual({ configured: true, live: false, connected: false });
    expect((await SELF.fetch(`${ORIGIN}/auth/yahoo/start`, { redirect: 'manual' })).status).toBe(404);
  });
});

describe('the private tables and the owner sign-in', () => {
  const body = new Uint8Array(16);
  const table = `${ORIGIN}/data/builds/b1/fct_event/wnba-2026.parquet`;
  beforeEach(async () => {
    await env.DATA.put('builds/b1/fct_event/wnba-2026.parquet', body);
    await env.DATA.put('builds/b1/board/wnba.json', '[]', { httpMetadata: { contentType: 'application/json' } });
  });

  it('keeps every Parquet table from anyone but the owner, however the name is written', async () => {
    for (const path of ['builds/b1/fct_event/wnba-2026.parquet', 'builds/b1/fct_event/wnba-2026.parque%74', 'builds/b1/fct_event/WNBA-2026.PARQUET']) {
      const res = await SELF.fetch(`${ORIGIN}/data/${path}`);
      expect(res.status, path).toBe(401);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    }
    expect((await SELF.fetch(table, { headers: { authorization: 'Bearer test-client-secret' } })).status).toBe(401);
    expect((await SELF.fetch(table, { headers: OWNER })).status).toBe(200);
  });

  it('keeps the JSON the pages read public', async () => {
    const res = await SELF.fetch(`${ORIGIN}/data/builds/b1/board/wnba.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it("opens the tables to the owner's session cookie, not another account's", async () => {
    const mine = `fs_owner=${await sessionCookie('test-client-secret', 'OWNERGUID')}`;
    const theirs = `fs_owner=${await sessionCookie('test-client-secret', 'SOMEONEELSE')}`;
    expect((await SELF.fetch(table, { headers: { cookie: mine } })).status).toBe(200);
    expect((await SELF.fetch(table, { headers: { cookie: theirs } })).status).toBe(401);
    expect(await (await SELF.fetch(`${ORIGIN}/api/owner/status`, { headers: { cookie: mine } })).json()).toEqual({ configured: true, owner: true });
    expect(await (await SELF.fetch(`${ORIGIN}/api/owner/status`)).json()).toEqual({ configured: true, owner: false });
  });

  it("starts the owner's sign-in at Yahoo, though the league import is parked", async () => {
    const res = await SELF.fetch(`${ORIGIN}/auth/owner/start`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const auth = new URL(res.headers.get('location')!);
    expect(auth.origin + auth.pathname).toBe('https://api.login.yahoo.com/oauth2/request_auth');
    expect(auth.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/yahoo/callback`);
    expect(res.headers.get('set-cookie')).toMatch(/^fs_owner_state=owner-[\w-]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
    // Without the owner's state, the callback belongs to the parked import.
    expect((await SELF.fetch(`${ORIGIN}/auth/yahoo/callback?code=c&state=s`, { redirect: 'manual' })).status).toBe(404);
    const out = await SELF.fetch(`${ORIGIN}/auth/owner/logout`, { redirect: 'manual' });
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await SELF.fetch(`${ORIGIN}/data/latest.json`, { method: 'POST' })).status).toBe(405);
  });
});
