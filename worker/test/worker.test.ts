// Runs inside workerd via @cloudflare/vitest-plugin, with the real assets binding
// (web/dist must be built first) and an isolated R2 bucket per test.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { contentRange, parseRange } from '../src/index';

const ORIGIN = 'https://fantasyscout.example';

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

  it('serves the player page for any /p/{league}/{id}/ address', async () => {
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

  it('serves builds.json with a short cache too', async () => {
    const res = await SELF.fetch(`${ORIGIN}/data/builds.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await res.json()).toEqual([{ build_id: 'test' }]);
  });

  it('serves build files as immutable with a parquet content type', async () => {
    const res = await SELF.fetch(`${ORIGIN}/data/build-1/fct_shot.parquet`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('content-type')).toBe('application/vnd.apache.parquet');
    expect(res.headers.get('content-length')).toBe('100');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
  });

  it('honours Range requests for DuckDB-WASM', async () => {
    const res = await SELF.fetch(`${ORIGIN}/data/build-1/fct_shot.parquet`, {
      headers: { range: 'bytes=10-19' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 10-19/100');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(body.slice(10, 20));
  });

  it('honours suffix Range requests (parquet footers)', async () => {
    const res = await SELF.fetch(`${ORIGIN}/data/build-1/fct_shot.parquet`, {
      headers: { range: 'bytes=-8' },
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
  it('answers through the Worker with the security headers, and says when it is not configured', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/yahoo/status`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(await res.json()).toEqual({ configured: false, connected: false });
    expect((await SELF.fetch(`${ORIGIN}/auth/yahoo/start`, { redirect: 'manual' })).status).toBe(404);
  });
});
