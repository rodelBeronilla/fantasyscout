import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, normalize } from './fantasy-league';
import nbaBoard from '../../tests/fixtures/data/builds/fixture/board/nba.json';
import wnbaBoard from '../../tests/fixtures/data/builds/fixture/board/wnba.json';
import { applyYahooImport, parseYahooHash, rosterName, teamPageNames, yahooHashVersion } from './yahoo-bookmarklet';

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

describe("a team's name read from its own page (#1047)", () => {
  const home = 'Springfield Hoops | Fantasy Basketball | Yahoo! Sports';
  const title = (league: string, team: string) => `${league} - ${team} | Fantasy Basketball | Yahoo! Sports`;
  const one = (page: { title: string; said?: string[] }, homeTitle = home, others: string[] = []) => teamPageNames(homeTitle, [{ said: [], ...page }], others)[0];

  it("reads Yahoo's title once the league's name is taken off the front, and agrees with the team element and the caption", () => {
    expect(one({ title: title('Springfield Hoops', 'Rim Reapers') })).toBe('Rim Reapers');
    expect(one({ title: title('Springfield Hoops', 'Rim Reapers'), said: ['Rim Reapers', ' Rim  Reapers '] })).toBe('Rim Reapers');
    // a long league name, and a league or team whose name holds Yahoo's separators
    const long = 'The Springfield and District Winter Hoops League of Champions and Friends';
    expect(one({ title: title(long, 'Fourth Quarter') }, `${long} | Fantasy Basketball | Yahoo! Sports`)).toBe('Fourth Quarter');
    expect(one({ title: title('North - South', 'Run - Gun') }, 'North - South | Fantasy Basketball | Yahoo! Sports')).toBe('Run - Gun');
    expect(one({ title: title('Springfield Hoops', 'Pick | Roll') })).toBe('Pick | Roll');
    expect(one({ title: title('Hoops | Fantasy Friends', 'Rim Reapers') }, 'Hoops | Fantasy Friends | Fantasy Basketball | Yahoo! Sports')).toBe('Rim Reapers');
    // a team named like the site
    expect(one({ title: title('Springfield Hoops', 'Fantasy Kings') })).toBe('Fantasy Kings');
    expect(one({ title: title('Springfield Hoops', 'Yahoo Killers') })).toBe('Yahoo Killers');
  });

  it('takes the team element or the caption alone when the title cannot be read', () => {
    expect(one({ title: '', said: ['Rim Reapers'] }, '')).toBe('Rim Reapers');
    expect(one({ title: title('Springfield Hoops', 'Rim Reapers'), said: ['Rim Reapers'] }, '')).toBe('Rim Reapers');
  });

  it('is unsure, so Team N, on anything else', () => {
    // a title that holds only the league, only the site's name, or the league's name not known
    expect(one({ title: home })).toBe('');
    expect(one({ title: 'Fantasy Basketball | Yahoo! Sports' })).toBe('');
    expect(one({ title: 'Yahoo Sports' })).toBe('');
    expect(one({ title: title('Springfield Hoops', 'Rim Reapers') }, '')).toBe('');
    expect(one({ title: title('Springfield Hoops', 'Rim Reapers') }, 'Error | Yahoo')).toBe('');
    // another shape, or another league's name in front
    expect(one({ title: 'Rim Reapers - Yahoo Fantasy Basketball' })).toBe('');
    expect(one({ title: title('Shelbyville Hoops', 'Rim Reapers') })).toBe('');
    // the sources disagree, or the name is longer than a team name is kept to
    expect(one({ title: title('Springfield Hoops', 'Rim Reapers'), said: ['Dunk Dynasty'] })).toBe('');
    expect(one({ title: '', said: ['Rim Reapers', 'Dunk Dynasty'] })).toBe('');
    expect(one({ title: title('Springfield Hoops', 'R'.repeat(61)) })).toBe('');
  });

  it('never gives two teams the same name', () => {
    const pages = [{ title: title('Springfield Hoops', 'Rim Reapers'), said: [] }, { title: '', said: ['Rim Reapers'] }, { title: '', said: ['Dunk Dynasty'] }];
    expect(teamPageNames(home, pages, [])).toEqual(['', '', 'Dunk Dynasty']);
    expect(teamPageNames(home, pages.slice(2), ['Dunk Dynasty'])).toEqual(['']);
  });
});
