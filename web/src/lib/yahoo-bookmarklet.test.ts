import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, normalize } from './fantasy-league';
import { applyYahooImport, parseYahooHash } from './yahoo-bookmarklet';

const hash = (payload: unknown) => `#yahoo=${encodeURIComponent(JSON.stringify(payload))}`;

describe('the Yahoo import', () => {
  it('reads a version 1 or 2 payload from the fragment and nothing else', () => {
    expect(parseYahooHash('')).toBeNull();
    expect(parseYahooHash('#yahoo=not-json')).toBeNull();
    expect(parseYahooHash(hash({ v: 3, teams: [{ id: 1, players: ['A'] }] }))).toBeNull();
    expect(parseYahooHash(hash({ v: 1, teams: [] }))).toBeNull();
    const v1 = parseYahooHash(hash({ v: 1, leagueId: 'L1', teams: [{ id: 7, name: 'Hoops', players: ['A One', 'B Two'] }, 'junk'] }));
    expect(v1).toEqual({ v: 2, leagueId: 'L1', mine: null, teams: [{ id: 7, name: 'Hoops', players: [{ name: 'A One', il: false }, { name: 'B Two', il: false }] }] });
    const v2 = parseYahooHash(hash({ v: 2, mine: 3, teams: [{ id: 3, players: [{ name: 'C Three', il: 1 }, { nope: true }] }] }));
    expect(v2?.mine).toBe(3);
    expect(v2?.teams[0]).toEqual({ id: 3, name: 'Team 3', players: [{ name: 'C Three', il: true }] });
  });

  it('builds the league from the import: rosters by name, the injured list, the manager, the rest reported', () => {
    const players = [
      { player_id: '1', full_name: 'A One' },
      { player_id: '2', full_name: 'B Two' },
      { player_id: '3', full_name: 'C Three' },
    ];
    const payload = parseYahooHash(
      hash({
        v: 2,
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
