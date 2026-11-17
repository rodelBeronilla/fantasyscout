import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, normalize } from './fantasy-league';
import nbaBoard from '../../tests/fixtures/data/builds/fixture/board/nba.json';
import wnbaBoard from '../../tests/fixtures/data/builds/fixture/board/wnba.json';
import { applyYahooImport, parseYahooHash, rosterName, yahooHashVersion } from './yahoo-bookmarklet';

const hash = (payload: unknown) => `#yahoo=${encodeURIComponent(JSON.stringify(payload))}`;

describe('the Yahoo import', () => {
  it('reads a version 4 payload and nothing else; an older bookmark is told apart by its version (#1018)', () => {
    expect(parseYahooHash('')).toBeNull();
    expect(parseYahooHash('#yahoo=not-json')).toBeNull();
    expect(parseYahooHash(hash({ v: 4, teams: [] }))).toBeNull();
    for (const v of [1, 2, 3, 5]) expect(parseYahooHash(hash({ v, teams: [{ id: 1, players: [{ name: 'A One' }] }] }))).toBeNull();
    expect(yahooHashVersion('')).toBeNull();
    expect(yahooHashVersion(hash({ v: 3, teams: [] }))).toBe(3);
    expect(yahooHashVersion('#yahoo=not-json')).toBe(0);
    const v4 = parseYahooHash(
      hash({
        v: 4,
        leagueId: 'L1',
        mine: 3,
        teams: [{ id: 3, name: 'Hoops', players: [{ name: 'C Three', il: 1, slot: 'il' }, { name: 'D Four', slot: 'Util' }, { nope: true }] }, 'junk'],
        rejected: [{ name: 'E Five', reason: 'not in a roster row with a slot' }, 'junk'],
        settings: { rows: [['Max Acquisitions per Week', '4'], ['bad']] },
      }),
    );
    expect(v4).toMatchObject({ v: 4, leagueId: 'L1', mine: 3, rejected: [{ name: 'E Five', reason: 'not in a roster row with a slot' }] });
    expect(v4?.teams).toEqual([{ id: 3, name: 'Hoops', players: [{ name: 'C Three', il: true, slot: 'IL' }, { name: 'D Four', il: false, slot: 'UTIL' }] }]);
    expect(v4?.settings?.rows).toEqual([['Max Acquisitions per Week', '4']]);
  });

  it('reads every board name as a name, and a name holding an action word too (#1018)', () => {
    const names = [...(nbaBoard as { full_name: string | null }[]), ...(wnbaBoard as { full_name: string | null }[])]
      .map((r) => r.full_name)
      .filter((n): n is string => !!n);
    expect(names.length).toBeGreaterThan(500);
    expect(names.filter((n) => !rosterName(n))).toEqual([]);
    // each word the old filter matched anywhere in the text, inside a name
    for (const n of ['Saddiq Bey', 'Dropa Smith', 'Tradell Jones', 'Notesha Brown', 'Newsome Hill', 'Comparetto Lee', 'Stats Kowalski', 'Watchman Reid', 'Addison Rae', 'Nenê'])
      expect(rosterName(n), n).toBe(true);
    // a link whose whole text is an action is not a name
    for (const n of ['Add', 'Drop', 'Trade', 'Note', 'Notes', 'News', 'Compare', 'Stats', 'Watch', ' watchlist ', '', 'x', '42'])
      expect(rosterName(n), n).toBe(false);
  });

  it('builds the league from the import: rosters by name, the injured list, the manager, the rest reported', () => {
    const players = [
      { player_id: '1', full_name: 'A One' },
      { player_id: '2', full_name: 'B Two' },
      { player_id: '3', full_name: 'C Three' },
    ];
    const payload = parseYahooHash(
      hash({
        v: 4,
        leagueId: 'L',
        mine: 20,
        teams: [
          { id: 10, name: 'First', players: [{ name: 'A One' }, { name: 'Nobody' }] },
          { id: 20, name: 'Second', players: [{ name: 'B Two', il: true }, { name: 'C Three' }] },
        ],
      }),
    )!;
    const result = applyYahooImport(normalize({ teams: 12 }, DEFAULT_SETTINGS.nba), payload, players, 1234);
    // when the bookmark ran, for My Team's "Last synced" (#815)
    expect(result.setup.source).toMatchObject({ host: 'yahoo', leagueId: 'L', syncedAt: 1234, changes: null });
    expect(result.matched).toBe(3);
    expect(result.unmatched).toEqual(['Nobody']);
    expect(result.il).toBe(1);
    expect(result.setup.teams).toBe(4); // two teams imported, four is the floor
    expect(result.setup.names.slice(0, 2)).toEqual(['First', 'Second']);
    expect(result.setup.rosters.slice(0, 2)).toEqual([['1'], ['2', '3']]);
    expect(result.setup.il).toEqual(['2']);
    expect(result.setup.mine).toBe(1);
    expect(result.setup.drafting).toBe(false);
  });
});
