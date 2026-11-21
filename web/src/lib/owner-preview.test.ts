import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PreviewCall } from './owner-preview';
import { limitsKnown } from './owner-preview';

// The owner preview (#1056): the switch in this browser, then the Worker. Each case loads the
// modules afresh, with fetch and the browser's storage stubbed. Every value below is made up.
async function load(opts: { switchOn: boolean; remembered?: boolean; owner?: boolean; worker?: boolean }) {
  vi.resetModules();
  const store = new Map<string, string>();
  if (opts.switchOn) store.set('fantasyscout:owner-preview', 'on');
  if (opts.remembered) store.set('fantasyscout:owner', '1');
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage });
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (opts.worker === false) throw new TypeError('no Worker');
      if (String(input) === '/api/owner/status') return Response.json({ configured: true, owner: !!opts.owner });
      if (String(input).endsWith('latest.json')) return Response.json({ build_id: 'build-1' });
      return Response.json({ logged: true });
    }),
  );
  return { ...(await import('./owner-preview')), calls, store };
}

const posted = (calls: { url: string; init?: RequestInit }[]) =>
  calls.filter((c) => c.url === '/api/owner/log').map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>);

const CALL: PreviewCall = { call: 'lineup', subject: 'p1 p2', value: '12 starts, 1 lost', naive: null };

afterEach(() => vi.unstubAllGlobals());

describe('the owner preview', () => {
  it('is off, and asks nothing, while the switch is off: the owner included', async () => {
    const { ownerPreviewOn, calls } = await load({ switchOn: false, remembered: true, owner: true });
    expect(await ownerPreviewOn()).toBe(false);
    expect(calls).toEqual([]);
  });

  it('is off with the switch on when the Worker says this browser is not the owner, or cannot be asked', async () => {
    const notOwner = await load({ switchOn: true, remembered: true, owner: false });
    expect(await notOwner.ownerPreviewOn()).toBe(false);
    expect(notOwner.calls.map((c) => c.url)).toEqual(['/api/owner/status']);
    const noWorker = await load({ switchOn: true, remembered: true, worker: false });
    expect(await noWorker.ownerPreviewOn()).toBe(false);
  });

  it('is on only with the switch on and the Worker saying owner, the flag this browser keeps or not', async () => {
    expect(await (await load({ switchOn: true, remembered: false, owner: true })).ownerPreviewOn()).toBe(true);
    expect(await (await load({ switchOn: true, remembered: true, owner: true })).ownerPreviewOn()).toBe(true);
  });

  it('keeps the switch in this browser', async () => {
    const { setPreviewSwitch, previewSwitchOn, store } = await load({ switchOn: false });
    expect(previewSwitchOn()).toBe(false);
    setPreviewSwitch(true);
    expect(store.get('fantasyscout:owner-preview')).toBe('on');
    expect(previewSwitchOn()).toBe(true);
    setPreviewSwitch(false);
    expect(store.has('fantasyscout:owner-preview')).toBe(false);
  });

  it('logs a call once a page view, with the date and the build, however often it renders', async () => {
    const { logPreviewCall, ownerPreviewOn, calls } = await load({ switchOn: true, owner: true });
    expect(await ownerPreviewOn()).toBe(true);
    expect(await logPreviewCall(CALL, '2026-11-20')).toBe(true);
    expect(await logPreviewCall({ ...CALL }, '2026-11-20')).toBe(false);
    // the same call saying something else is a new call shown
    expect(await logPreviewCall({ ...CALL, value: '13 starts' }, '2026-11-20')).toBe(true);
    expect(posted(calls)).toEqual([
      { kind: 'call', date: '2026-11-20', call: 'lineup', subject: 'p1 p2', value: '12 starts, 1 lost', naive: null, build: 'build-1' },
      { kind: 'call', date: '2026-11-20', call: 'lineup', subject: 'p1 p2', value: '13 starts', naive: null, build: 'build-1' },
    ]);
  });

  it('writes nothing for a browser the Worker does not take as the owner', async () => {
    const { logPreviewCall, calls } = await load({ switchOn: true, remembered: false, owner: false });
    expect(await logPreviewCall(CALL, '2026-11-20')).toBe(false);
    expect(posted(calls)).toEqual([]);
  });
});

describe("the preview's pickups", () => {
  it('offers no more adds than are left this week, and all of them with no limit', async () => {
    const { withinAdds, addsOpen } = await load({ switchOn: false });
    expect(withinAdds(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
    expect(withinAdds(['a', 'b', 'c'], 0)).toEqual([]);
    expect(withinAdds(['a', 'b', 'c'], null)).toEqual(['a', 'b', 'c']);
    expect([addsOpen(0), addsOpen(1), addsOpen(null)]).toEqual([false, true, true]);
  });
});

describe('whether the adds a week and the waiver wait are known (#1056)', () => {
  it('a value that is set is known; an empty one is "not known" only on a Yahoo copy whose settings were never read', () => {
    const old = { host: 'yahoo' };
    const read = { host: 'yahoo', rules: { tradeReview: 'League Votes' } };
    // an old Yahoo copy, nothing typed
    expect(limitsKnown({ addsPerWeek: null, waiverDays: null, source: old })).toEqual({ adds: false, waiver: false });
    // the same copy with 4 adds and 2 days typed on the League page
    expect(limitsKnown({ addsPerWeek: 4, waiverDays: 2, source: old })).toEqual({ adds: true, waiver: true });
    // one typed, one not
    expect(limitsKnown({ addsPerWeek: 4, waiverDays: null, source: old })).toEqual({ adds: true, waiver: false });
    // imported with the settings page read: empty means no limit, and is known
    expect(limitsKnown({ addsPerWeek: null, waiverDays: null, source: read })).toEqual({ adds: true, waiver: true });
    // a league set up by hand or from another host says its own
    expect(limitsKnown({ addsPerWeek: null, waiverDays: null, source: { host: 'espn' } })).toEqual({ adds: true, waiver: true });
    expect(limitsKnown({})).toEqual({ adds: true, waiver: true });
  });
});
