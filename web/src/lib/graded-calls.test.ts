import { afterEach, describe, expect, it, vi } from 'vitest';

import { type LoggedCall } from './graded';
import { gradeCalls, hasWeek, type LoggedImport, parseImports, type PlayerWeek, weekCalls } from './graded-calls';

// The owner preview's calls of last week, graded where the grade is plain (#1058). Made-up players.

const MONDAY = '2026-11-23';
const call = (c: Partial<LoggedCall> & Pick<LoggedCall, 'call' | 'subject'>): LoggedCall => ({ at: '', date: MONDAY, value: 'v', naive: null, build: 'b', ...c });

const week = (player_id: string, games: number, over: Partial<PlayerWeek> = {}): PlayerWeek => ({
  league: 'nba',
  player_id,
  week_start: MONDAY,
  games_scheduled: 4,
  games_played: games,
  points: 10 * games,
  rebounds_total: 4 * games,
  assists: 3 * games,
  steals: games,
  blocks: 0,
  three_pointers_made: 2 * games,
  turnovers: games,
  field_goals_made: 4 * games,
  field_goals_attempted: 9 * games,
  free_throws_made: games,
  free_throws_attempted: games,
  ...over,
});

const WEEKS = [week('p1', 3), week('p2', 4), week('p3', 2), week('r1', 4), week('r2', 3), week('r3', 0), week('p1', 1, { week_start: '2026-11-16' })];
const IMPORT: LoggedImport = { at: '2026-11-23T13:00:00Z', mine: 0, rosters: [['r1', 'r2', 'r3', 'r4'], ['x']], slots: { r1: 'PG', r2: 'BN', r3: 'UTIL', r4: 'IL' } };

describe("last week's preview calls", () => {
  it('takes the week’s calls, Monday to Sunday, the week’s chances left out', () => {
    const calls = [
      call({ call: 'lineup', subject: 'none', date: '2026-11-22' }),
      call({ call: 'week-chances', subject: 'nba:2026-11-23:1' }),
      call({ call: 'stream', subject: 'p1', date: '2026-11-29' }),
      call({ call: 'stream', subject: 'p1', date: '2026-11-30' }),
    ];
    expect(weekCalls(calls, MONDAY).map((c) => [c.call, c.date])).toEqual([['stream', '2026-11-29']]);
  });

  it('grades a top add and a stream by the players’ games and totals that week, each player once', () => {
    const grades = gradeCalls(
      [
        call({ call: 'top-adds', subject: 'p1 p2' }),
        call({ call: 'top-adds', subject: 'p2 p9', date: '2026-11-25' }),
        call({ call: 'stream', subject: 'p3 for r1', date: '2026-11-24' }),
        call({ call: 'top-adds', subject: 'none' }),
      ],
      MONDAY,
      WEEKS,
      [],
    );
    expect(grades).toHaveLength(2);
    const [adds, stream] = grades;
    expect(adds).toMatchObject({ kind: 'players', call: 'top-adds', date: MONDAY });
    if (adds?.kind !== 'players' || stream?.kind !== 'players') throw new Error('expected players');
    expect(adds.players.map((p) => [p.id, p.line?.games_played ?? null])).toEqual([
      ['p1', 3],
      ['p2', 4],
      ['p9', null],
    ]);
    // the week's own row, not the week before's
    expect(adds.players[0]!.line?.points).toBe(30);
    expect(stream.players.map((p) => [p.id, p.role, p.line?.games_played])).toEqual([
      ['p3', 'add', 2],
      ['r1', 'drop', 4],
    ]);
  });

  it('grades the Monday lineup plan: its starts against the games the roster’s players played, the injured list left out', () => {
    const grades = gradeCalls([call({ call: 'lineup', subject: 'r2', value: '9 starts, 1 lost to a full lineup, 2 open slots', date: MONDAY })], MONDAY, WEEKS, [IMPORT]);
    expect(grades).toEqual([{ kind: 'lineup', date: MONDAY, counted: 9, played: 7, roster: 3 }]);
  });

  it('does not grade a plan first made after the Monday, nor one with no roster logged', () => {
    const later = gradeCalls([call({ call: 'lineup', subject: 'none', value: '5 starts', date: '2026-11-25' })], MONDAY, WEEKS, [IMPORT]);
    expect(later).toMatchObject([{ kind: 'not-graded', call: 'lineup' }]);
    const none = gradeCalls([call({ call: 'lineup', subject: 'none', value: '9 starts' })], MONDAY, WEEKS, []);
    expect(none).toMatchObject([{ kind: 'not-graded', call: 'lineup', why: 'no import logged that day names the roster it counted' }]);
  });

  it('lists a trade and every call without a plain measure as not graded, once each', () => {
    const grades = gradeCalls(
      [call({ call: 'trade-verdict', subject: 'a > b' }), call({ call: 'trade-verdict', subject: 'c > d' }), call({ call: 'swaps', subject: 'x for y' })],
      MONDAY,
      WEEKS,
      [],
    );
    expect(grades).toEqual([
      { kind: 'not-graded', call: 'trade-verdict', date: MONDAY, why: 'no plain measure yet' },
      { kind: 'not-graded', call: 'swaps', date: MONDAY, why: 'no plain measure yet' },
    ]);
  });

  it('reads the log’s imports, and knows whether the build has published the week', () => {
    const text = [JSON.stringify({ at: IMPORT.at, kind: 'import', host: 'yahoo', mine: 0, time: 1, rosters: IMPORT.rosters, slots: IMPORT.slots, records: [] }), '{"kind":"page"', ''].join('\n');
    expect(parseImports(text)).toEqual([IMPORT]);
    expect(hasWeek(WEEKS, MONDAY)).toBe(true);
    expect(hasWeek(WEEKS, '2026-11-30')).toBe(false);
  });
});

describe("the week's chances, logged once a week in this browser", () => {
  afterEach(() => vi.unstubAllGlobals());

  it('logs the first time and not again that week, then again the next week', async () => {
    vi.resetModules();
    const store = new Map<string, string>([['fantasyscout:owner', '1']]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    vi.stubGlobal('window', { localStorage: globalThis.localStorage, location: { origin: 'https://example.test' } });
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/owner/status') return Response.json({ configured: true, owner: true });
        if (url === '/api/owner/log') {
          posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return Response.json({ logged: true });
        }
        return new Response('missing', { status: 404 });
      }),
    );
    const { logWeekChances, chancesKey } = await import('./graded-log');
    const c = { league: 'nba' as const, monday: MONDAY, opponent: 1, week: 9, chances: { z_points: 0.6 }, soFar: null };
    expect(await logWeekChances(c, MONDAY)).toBe(true);
    expect(await logWeekChances(c, '2026-11-24')).toBe(false);
    expect(store.get(chancesKey('nba'))).toBe(MONDAY);
    expect(await logWeekChances({ ...c, monday: '2026-11-30' }, '2026-11-30')).toBe(true);
    expect(posts.map((p) => [p['call'], p['subject'], p['date']])).toEqual([
      ['week-chances', 'nba:2026-11-23:1', MONDAY],
      ['week-chances', 'nba:2026-11-30:1', '2026-11-30'],
    ]);
    expect(posts[0]).toMatchObject({ kind: 'call', naive: 0.5, value: '{"w":9,"c":{"PTS":0.6},"s":null}' });
  });
});
