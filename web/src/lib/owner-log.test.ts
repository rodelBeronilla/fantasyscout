import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LeagueSetup } from './fantasy-league';
import type { CallShown } from './owner-log';

// The owner's private log (#1032). The module asks the Worker once a page, so each case loads it
// afresh, with fetch and the browser's storage stubbed. Every value below is made up.
async function load(opts: { remembered: boolean; owner?: boolean }) {
  vi.resetModules();
  const store = new Map<string, string>(opts.remembered ? [['fantasyscout:owner', '1']] : []);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input) === '/api/owner/status') return Response.json({ configured: true, owner: !!opts.owner });
      return Response.json({ logged: true });
    }),
  );
  return { ...(await import('./owner-log')), calls, store };
}

const posted = (calls: { url: string; init?: RequestInit }[]) =>
  calls.filter((c) => c.url === '/api/owner/log').map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>);

const CALL: CallShown = { date: '2026-11-17', call: 'start', subject: 'p1', value: 1.5, naive: 'bench', build: 'build-1' };

afterEach(() => vi.unstubAllGlobals());

describe("the owner's log", () => {
  it('asks nothing at all in a browser that never signed in as the owner', async () => {
    const { logPage, logCall, calls } = await load({ remembered: false });
    expect(await logPage('/league/')).toBe(false);
    expect(await logCall(CALL)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('writes nothing, and forgets the owner, when the Worker says the cookie no longer holds', async () => {
    const { logPage, calls, store } = await load({ remembered: true, owner: false });
    expect(await logPage('/league/')).toBe(false);
    expect(calls.map((c) => c.url)).toEqual(['/api/owner/status']);
    expect(store.has('fantasyscout:owner')).toBe(false);
  });

  it("logs a call shown with the bar's fields, as JSON from this site, after one status check a page", async () => {
    const { logCall, logPage, calls } = await load({ remembered: true, owner: true });
    expect(await logCall(CALL)).toBe(true);
    expect(await logPage('/trade/')).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(['/api/owner/status', '/api/owner/log', '/api/owner/log']);
    expect(posted(calls)).toEqual([{ kind: 'call', ...CALL }, { kind: 'page', path: '/trade/' }]);
    const init = calls[1]!.init!;
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('logs only the fields of a call, nothing extra a caller passes', async () => {
    const { logCall, calls } = await load({ remembered: true, owner: true });
    await logCall({ ...CALL, naive: null, extra: 'x' } as CallShown);
    expect(posted(calls)).toEqual([{ kind: 'call', ...CALL, naive: null }]);
  });

  it("logs an import's rosters, slots, records and time, once however often it is read", async () => {
    const { logImport, importEvent, calls } = await load({ remembered: true, owner: true });
    const setup = {
      mine: 1,
      source: {
        host: 'yahoo',
        leagueId: 'L',
        syncedAt: 1_763_400_000_000,
        rosters: [['p1'], ['p2', 'p3']],
        changes: null,
        slots: { p2: 'PG', p3: 'BN' },
        records: [null, { wins: 2, losses: 1, ties: 0, seed: 1 }],
      },
    } as unknown as LeagueSetup;
    const event = {
      kind: 'import',
      host: 'yahoo',
      mine: 1,
      time: 1_763_400_000_000,
      rosters: [['p1'], ['p2', 'p3']],
      slots: { p2: 'PG', p3: 'BN' },
      records: [null, { wins: 2, losses: 1, ties: 0, seed: 1 }],
    };
    expect(importEvent(setup)).toEqual(event);
    expect(await logImport(setup)).toBe(true);
    expect(await logImport(setup)).toBe(false);
    expect(posted(calls)).toEqual([event]);
    // an ESPN import names no team as the manager's, and may bring no slots or records
    const espn = { mine: 0, source: { host: 'espn', leagueId: 'E', syncedAt: 5, rosters: [], changes: null } } as unknown as LeagueSetup;
    expect(importEvent(espn)).toEqual({ kind: 'import', host: 'espn', mine: null, time: 5, rosters: [], slots: {}, records: [] });
    expect(importEvent({ mine: 0 } as LeagueSetup)).toBeNull();
  });
});
