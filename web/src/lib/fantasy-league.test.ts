import { describe, expect, it } from 'vitest';

import { assign, DEFAULT_SETTINGS, draftPick, matchNames, nameKey, normalize, onTheClock, owners, toggleIl, undoPick } from './fantasy-league';

const base = normalize({ teams: 4, rosters: [['p1', 'p2'], ['p3'], [], []] }, DEFAULT_SETTINGS.nba);

describe('the stored league setup', () => {
  it('normalises sizes, names, rosters, the injured list, the manager and the picks', () => {
    const setup = normalize(
      { teams: 3, rosters: [['p1', 'p2'], ['p2', 'p3']], il: ['p3', 'zz', 'p3'], mine: 9, picks: [{ team: 0, player: 'p1' }, { team: 7, player: 'p9' }] },
      DEFAULT_SETTINGS.nba,
    );
    expect(setup.teams).toBe(4); // never fewer than four
    expect(setup.names).toEqual(['Team 1', 'Team 2', 'Team 3', 'Team 4']);
    expect(setup.rosters).toEqual([['p1', 'p2'], ['p3'], [], []]); // a player is on one team only
    expect(setup.il).toEqual(['p3']); // only rostered players, once
    expect(setup.mine).toBe(3);
    expect(setup.picks).toEqual([{ team: 0, player: 'p1' }]);
    expect(setup.rosterSpots).toBe(13);
    expect(setup.scoring).toBe('cats9');
  });

  it('moves a player between teams and off the injured list when released', () => {
    const moved = assign(toggleIl(base, 'p3'), 'p3', 0);
    expect(moved.rosters[0]).toEqual(['p1', 'p2', 'p3']);
    expect(moved.rosters[1]).toEqual([]);
    expect(moved.il).toEqual(['p3']); // still owned, still on the IL
    const released = assign(moved, 'p3', null);
    expect(released.il).toEqual([]);
    expect(owners(released).get('p3')).toBeUndefined();
    expect(owners(base).get('p1')).toBe(0);
  });

  it('snakes the draft and undoes the last pick', () => {
    let setup = normalize({ teams: 4, drafting: true }, DEFAULT_SETTINGS.nba);
    expect(onTheClock(setup)).toEqual({ overall: 1, round: 1, pick: 1, team: 0 });
    for (const player of ['a', 'b', 'c', 'd', 'e']) setup = draftPick(setup, player);
    expect(onTheClock(setup)).toEqual({ overall: 6, round: 2, pick: 2, team: 2 });
    expect(setup.rosters[3]).toEqual(['d', 'e']); // the last team picks twice in a row
    const undone = undoPick(setup);
    expect(undone.rosters[3]).toEqual(['d']);
    expect(undone.picks).toHaveLength(4);
    expect(undoPick(normalize({}, DEFAULT_SETTINGS.wnba)).picks).toEqual([]);
  });
});

describe('name matching', () => {
  it('reduces a name for matching: accents, suffixes, hyphens and case', () => {
    expect(nameKey('Kristaps Porziņģis')).toBe('kristaps porzingis');
    expect(nameKey('Gary Trent Jr.')).toBe('gary trent');
    expect(nameKey('Jimmy Butler III')).toBe('jimmy butler');
    expect(nameKey('Betnijah Laney-Hamilton')).toBe('betnijah laney hamilton');
  });

  it('matches pasted lines to players, extra text and all, and reports the rest', () => {
    const players = [
      { player_id: '1', full_name: 'Gary Trent Jr.' },
      { player_id: '2', full_name: 'Jalen Williams' },
      { player_id: '3', full_name: null },
    ];
    const result = matchNames('Gary Trent Jr. (POR - SG)\nJalen Williams\n\nNobody Known\njalen williams', players);
    expect(result).toEqual({ matched: ['1', '2'], unmatched: ['Nobody Known'] });
  });

  it('matches a name shortened to an initial when one player fits, and nobody when two do', () => {
    const players = [
      { player_id: '1', full_name: 'Nickeil Alexander-Walker' },
      { player_id: '2', full_name: 'Jalen Williams' },
      { player_id: '3', full_name: 'Jaylin Williams' },
      { player_id: '4', full_name: 'Nneka Ogwumike' },
    ];
    expect(matchNames('N. Alexander-Walker\nJ. Williams\nN. Ogwumike (SEA - F)\nX. Ogwumike', players)).toEqual({
      matched: ['1', '4'],
      unmatched: ['J. Williams', 'X. Ogwumike'],
    });
  });
});
