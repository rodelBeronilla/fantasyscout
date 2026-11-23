import { afterEach, describe, expect, it, vi } from 'vitest';

import { callKey, planBatch, validCall } from '../../../worker/src/owner-log-event';
import type { PreviewCall } from './owner-preview';
import { limitsKnown } from './owner-preview';

// The owner preview (#1056): the switch in this browser, then the Worker. Each case loads the
// modules afresh, with fetch and the browser's storage stubbed. Every value below is made up.
async function load(opts: {
  switchOn: boolean;
  remembered?: boolean;
  owner?: boolean;
  worker?: boolean;
  /** How the log answers a batch: as the Worker would (by its own rule), refused, failed, or not as the Worker at all. */
  answer?: 'refuse' | 'fail' | 'no-worker' | 'hang';
  /** The calls the log holds already, from another view or tab. */
  have?: PreviewCall[];
}) {
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
      if (opts.answer === 'refuse') return Response.json({ error: 'not an event' }, { status: 400 });
      if (opts.answer === 'fail') throw new TypeError('the network is down');
      if (opts.answer === 'hang')
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      if (opts.answer === 'no-worker') return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
      const have = new Set((opts.have ?? []).map((c) => callKey({ ...c, date: '2026-11-20', league: LEAGUE })));
      const plan = planBatch(JSON.parse(String(init?.body)), have);
      return plan ? Response.json({ results: plan.results }) : Response.json({ error: 'not a batch' }, { status: 400 });
    }),
  );
  return { ...(await import('./owner-preview')), calls, store };
}

const batches = (calls: { url: string; init?: RequestInit }[]) =>
  calls.filter((c) => c.url === '/api/owner/log').map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>);

const LEAGUE = 'yahoo:99:1762094400000';

const CALL: PreviewCall = { call: 'lineup', subject: 'p1 p2', value: '12 starts, 1 lost', naive: null };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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

  it("logs a page view's calls in one request once they settle, and says call by call whether the log holds each", async () => {
    vi.useFakeTimers();
    const { logBeforeShowing, ownerPreviewOn, calls, SETTLE_MS } = await load({ switchOn: true, owner: true });
    expect(await ownerPreviewOn()).toBe(true);
    const one = logBeforeShowing([CALL], LEAGUE, '2026-11-20');
    const two = logBeforeShowing([{ ...CALL, call: 'swaps', subject: 'p3 for p4' }, { ...CALL, call: 'swaps', subject: 'p5 for p6' }], LEAGUE, '2026-11-20');
    // a frame whose call changes withdraws the one it no longer shows: it is never sent
    const gone = logBeforeShowing([{ ...CALL, value: 'drawn before the schedule came' }], LEAGUE, '2026-11-20');
    gone.cancel();
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
    expect(batches(calls)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await one.done).toEqual(['held']);
    expect(await two.done).toEqual(['held', 'held']);
    expect(batches(calls)).toHaveLength(1);
    expect(batches(calls)[0]).toEqual({
      kind: 'calls',
      calls: [
        { date: '2026-11-20', call: 'lineup', subject: 'p1 p2', value: '12 starts, 1 lost', naive: null, build: 'build-1', league: LEAGUE },
        { date: '2026-11-20', call: 'swaps', subject: 'p3 for p4', value: '12 starts, 1 lost', naive: null, build: 'build-1', league: LEAGUE },
        { date: '2026-11-20', call: 'swaps', subject: 'p5 for p6', value: '12 starts, 1 lost', naive: null, build: 'build-1', league: LEAGUE },
      ],
    });
    // shown again on this view: the log holds it, nothing is sent
    expect(await logBeforeShowing([{ ...CALL }], LEAGUE, '2026-11-20').done).toEqual(['held']);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(batches(calls)).toHaveLength(1);
  });

  it('takes a call the log already held (another view, another tab) as held', async () => {
    vi.useFakeTimers();
    const { logBeforeShowing, ownerPreviewOn, SETTLE_MS } = await load({ switchOn: true, owner: true, have: [CALL] });
    await ownerPreviewOn();
    const asked = logBeforeShowing([CALL, { ...CALL, subject: 'p9' }], LEAGUE, '2026-11-20');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(await asked.done).toEqual(['held', 'held']);
  });

  it('says false for a call refused, or not answered, and does not send it again on this view', async () => {
    vi.useFakeTimers();
    for (const answer of ['refuse', 'fail', 'no-worker'] as const) {
      const { logBeforeShowing, ownerPreviewOn, calls, SETTLE_MS } = await load({ switchOn: true, owner: true, answer });
      await ownerPreviewOn();
      const asked = logBeforeShowing([CALL], LEAGUE, '2026-11-20');
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
      expect(await asked.done, answer).toEqual(['refused']);
      expect(await logBeforeShowing([CALL], LEAGUE, '2026-11-20').done, answer).toEqual(['refused']);
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
      expect(batches(calls).length, answer).toBeLessThanOrEqual(1);
    }
  });

  it('says a log that does not answer in time did not, and sends nothing more on this view (#1137)', async () => {
    vi.useFakeTimers();
    const { logBeforeShowing, ownerPreviewOn, calls, SETTLE_MS } = await load({ switchOn: true, owner: true, answer: 'hang' });
    const { LOG_TIMEOUT_MS } = await import('./owner-log');
    await ownerPreviewOn();
    const asked = logBeforeShowing([CALL], LEAGUE, '2026-11-20');
    let said: unknown = null;
    void asked.done.then((r) => (said = r));
    await vi.advanceTimersByTimeAsync(SETTLE_MS + LOG_TIMEOUT_MS - 1);
    expect(said).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(said).toEqual(['timeout']);
    expect(await logBeforeShowing([CALL], LEAGUE, '2026-11-20').done).toEqual(['timeout']);
    expect(batches(calls)).toHaveLength(1);
  });

  it('waits the full settle for the page\'s first request, and the short one for a change after it (#1137)', async () => {
    vi.useFakeTimers();
    const { logBeforeShowing, ownerPreviewOn, calls, SETTLE_MS, CHANGE_SETTLE_MS } = await load({ switchOn: true, owner: true });
    await ownerPreviewOn();
    expect(CHANGE_SETTLE_MS).toBeLessThan(SETTLE_MS);
    void logBeforeShowing([CALL], LEAGUE, '2026-11-20').done;
    await vi.advanceTimersByTimeAsync(CHANGE_SETTLE_MS);
    expect(batches(calls)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SETTLE_MS - CHANGE_SETTLE_MS);
    expect(batches(calls)).toHaveLength(1);
    // he changes something: the frame's new call goes once the change has settled, with whatever else it touched
    const changed = logBeforeShowing([{ ...CALL, value: '13 starts' }], LEAGUE, '2026-11-20');
    const also = logBeforeShowing([{ ...CALL, call: 'build', subject: 'category PTS' }], LEAGUE, '2026-11-20');
    await vi.advanceTimersByTimeAsync(CHANGE_SETTLE_MS - 1);
    expect(batches(calls)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await changed.done).toEqual(['held']);
    expect(await also.done).toEqual(['held']);
    expect(batches(calls)).toHaveLength(2);
    expect((batches(calls)[1]!['calls'] as unknown[]).length).toBe(2);
  });

  it('sends nothing for a browser the Worker does not take as the owner, and holds nothing', async () => {
    vi.useFakeTimers();
    const { logBeforeShowing, calls, SETTLE_MS } = await load({ switchOn: true, remembered: false, owner: false });
    const asked = logBeforeShowing([CALL], LEAGUE, '2026-11-20');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(await asked.done).toEqual(['refused']);
    expect(batches(calls)).toEqual([]);
  });
});

describe("the preview's calls fit the log's rule whatever the league (#1056)", () => {
  const entry = (c: PreviewCall) => ({ ...c, date: '2026-11-20', build: 'build-1', league: LEAGUE });
  const ids = (n: number, from = 1_630_000) => Array.from({ length: n }, (_, i) => String(from + i));

  it('passes the Worker’s own rule at the extremes', async () => {
    const { previewCall, eachCall, tradeSubject, heldBack, importOf } = await load({ switchOn: false });
    const cats = ['PTS', 'REB', 'AST', 'STL', 'BLK', '3PTM', 'FG%', 'FT%', 'TO'];
    const long = (n: number) => 'x'.repeat(n);
    const extremes: PreviewCall[] = [
      // nine categories too close; a 9-0 week, with nothing to flip and an empty value
      previewCall({ call: 'too-close', subject: cats.map((c) => `${c}-too-close-in-a-long-name`), value: 'Winning 0, losing 0, 9 too close', naive: 'Winning 9, losing 0' }),
      previewCall({ call: 'stream', subject: 'none', value: '', empty: 'nothing to flip: every category is projected won' }),
      // sixteen benched seven-digit ids
      previewCall({ call: 'lineup', subject: ids(16), value: '40 starts, 3 lost to a full lineup, 0 open slots', empty: 'nobody benched' }),
      // eight for eight
      previewCall({ call: 'trade-verdict', subject: tradeSubject(ids(8), ids(8, 1_640_000)), value: 'bad (terrible), them', naive: 'value -12.5' }),
      previewCall({ call: 'trade-finder', subject: tradeSubject(ids(8), ids(8, 1_640_000), '7: '), value: '+0.40 categories' }),
      // thirty items in one frame, and a value of thirty parts
      ...eachCall('trade-suggestions', ids(30).map((id) => ({ subject: tradeSubject([id, id, id], [id, id, id]), value: ids(30) }))),
      // every field at and past its limit, and empty
      previewCall({ call: long(80), subject: long(500), value: long(500), naive: long(500) }),
      previewCall({ call: 'Trade Finder!', subject: '', value: '   ', naive: '' }),
      previewCall({ call: 'stream', subject: [], value: [], naive: [] }),
      previewCall({ call: 'stream', subject: [long(300)], value: Number.NaN, naive: Number.POSITIVE_INFINITY }),
      heldBack('top-adds', 30, 0, 0)!,
      heldBack('swaps', 30, 1, 1)!,
    ];
    for (const c of extremes) expect(validCall(entry(c)), JSON.stringify(c)).not.toBeNull();
    // and the league's import, however long its parts
    expect(validCall({ ...entry(extremes[0]!), league: importOf({ host: 'yahoo', leagueId: long(100), syncedAt: 1 }) })).not.toBeNull();
    expect(importOf(undefined)).toBe('none');
    expect(validCall({ ...entry(extremes[0]!), league: importOf({ host: 'yahoo', leagueId: '99', syncedAt: 1e21 }) })).not.toBeNull();
    expect(validCall(entry(previewCall({ call: 'lineup', subject: ['', '  '], value: [''], emptySubject: 'nobody benched' })))).not.toBeNull();
    expect(previewCall({ call: 'lineup', subject: [], value: 'v', emptySubject: 'nobody benched' }).subject).toBe('nobody benched');
    // a list cut to fit says what it left out
    expect(previewCall({ call: 'lineup', subject: ids(16), value: 'v' }).subject).toMatch(/ \(\+\d+ more\)$/);
    expect(tradeSubject(ids(8), ids(8, 1_640_000))).toMatch(/^.+ \(\+\d+ more\) > .+ \(\+\d+ more\)$/);
    expect(tradeSubject(['a', 'b'], ['c'])).toBe('a b > c');
    // a batch of every one of them is one request the Worker takes
    expect(planBatch({ kind: 'calls', calls: extremes.map(entry) }, new Set())?.results.every((r) => r !== 'refused')).toBe(true);
  });

  it('says a list held back by the adds left is held back, not that there is none', async () => {
    const { heldBack } = await load({ switchOn: false });
    expect(heldBack('top-adds', 3, 0, 0)?.value).toBe('all 3 held back: no adds left this week');
    expect(heldBack('top-adds', 3, 1, 1)?.value).toBe('2 more held back by the adds limit (1 left this week)');
    expect(heldBack('top-adds', 3, 3, 4)).toBeNull();
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
