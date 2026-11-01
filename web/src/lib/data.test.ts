import { afterEach, describe, expect, it, vi } from 'vitest';

// The data client memoises the build pointer for the life of the page, so each case loads the
// module afresh and stubs fetch.
async function client(responses: (() => Promise<Response>)[]) {
  vi.resetModules();
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const next = responses.shift();
    if (!next) throw new Error('no response left');
    return next();
  });
  vi.stubGlobal('fetch', fetchMock);
  const mod = await import('./data');
  return { ...mod, calls };
}

const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const status = (code: number) => async () => new Response('x', { status: code });
const offline = async () => {
  throw new TypeError('Failed to fetch');
};

afterEach(() => vi.unstubAllGlobals());

describe('the build pointer', () => {
  it('is fetched once and remembered', async () => {
    const latest = { build_id: 'b1', manifest: 'builds/b1/manifest.json', created_at: 't', data_as_of: {} };
    const { getLatest, buildHref, calls } = await client([ok(latest)]);
    expect(await getLatest()).toEqual(latest);
    expect(await getLatest()).toEqual(latest);
    expect(calls).toEqual(['/data/latest.json']);
    expect(buildHref(latest, 'board/nba.json')).toBe('/data/builds/b1/board/nba.json');
  });

  it('is null when no build has been published (404), and fetchBuildJson says so', async () => {
    const { getLatest, fetchBuildJson, NoBuildError } = await client([status(404)]);
    expect(await getLatest()).toBeNull();
    await expect(fetchBuildJson('board/nba.json')).rejects.toBeInstanceOf(NoBuildError);
  });

  it('throws on any other failure and does not remember it', async () => {
    const latest = { build_id: 'b2', manifest: 'm', created_at: 't', data_as_of: {} };
    const { getLatest, DataUnavailableError, calls } = await client([status(503), offline, ok(latest)]);
    await expect(getLatest()).rejects.toMatchObject({ status: 503, message: expect.stringContaining('HTTP 503') });
    const second = getLatest();
    await expect(second).rejects.toBeInstanceOf(DataUnavailableError);
    await expect(second).rejects.toMatchObject({ status: undefined });
    expect(await getLatest()).toEqual(latest);
    expect(calls).toHaveLength(3);
  });
});
