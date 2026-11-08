import { describe, expect, it } from 'vitest';

import { dropRule, reviewRoster, suggestUpgrades } from './roster-upgrades';

const rest = new Map([
  ['star', 12],
  ['solid', 6],
  ['weak', 1],
  ['free-good', 8],
  ['free-ok', 3],
  ['free-dud', 0],
  ['free-neg', -2],
]);
const catValue = (id: string) =>
  ({
    star: { pts: 3, reb: 3 },
    solid: { pts: 1, reb: 2 },
    weak: { pts: 0, reb: 0.5 },
    'free-good': { pts: 2.5, reb: 0 },
    'free-ok': { pts: 1, reb: 0 },
  })[id];
const totals = [
  { pts: 4, reb: 5.5 }, // the manager: star, solid, weak
  { pts: 5, reb: 4 },
  { pts: 3, reb: 6 },
];

describe('roster upgrades', () => {
  it('swap the weakest rostered player for a better available one, biggest gain first, each player once', () => {
    const out = suggestUpgrades({
      league: 'nba',
      mine: ['star', 'solid', 'weak'],
      available: ['free-good', 'free-ok', 'free-dud', 'free-neg'],
      rest,
      cats: ['pts', 'reb'],
      catValue,
      totals,
      myTeam: 0,
    });
    // free-good replaces weak (+7); free-ok is worth less than solid, and weak is already used, so no second swap
    expect(out.map((u) => [u.add, u.drop, u.gain])).toEqual([['free-good', 'weak', 7]]);
    expect(out[0]?.ups).toEqual(['pts']); // pts 4 -> 6.5 passes both rivals
    expect(out[0]?.downs).toEqual([]); // reb 5.5 -> 5 stays second
    expect(out[0]?.fit).toBe(1);
  });

  it('ignore swaps below the minimum gain and players worth nothing', () => {
    const out = suggestUpgrades({
      league: 'nba',
      mine: ['solid'],
      available: ['free-ok', 'free-dud', 'free-neg'],
      rest,
      cats: [],
      catValue,
      totals,
      myTeam: 0,
    });
    expect(out).toEqual([]);
    const loose = suggestUpgrades({
      league: 'nba',
      mine: ['weak'],
      available: ['free-ok'],
      rest,
      cats: [],
      catValue,
      totals,
      myTeam: 0,
      minGain: 5,
    });
    expect(loose).toEqual([]);
  });

  it('score a points league on value alone', () => {
    const out = suggestUpgrades({
      league: 'nba',
      mine: ['weak', 'solid'],
      available: ['free-good', 'free-ok'],
      rest,
      cats: [],
      catValue,
      totals: [],
      myTeam: 0,
    });
    expect(out).toEqual([
      { add: 'free-good', drop: 'weak', gain: 7, fit: 0, ups: [], downs: [] },
    ]);
  });

  it('answer nothing without a roster or without anyone available', () => {
    expect(suggestUpgrades({ league: 'nba', mine: [], available: ['free-good'], rest, cats: [], catValue, totals, myTeam: 0 })).toEqual([]);
    expect(suggestUpgrades({ league: 'nba', mine: ['weak'], available: [], rest, cats: [], catValue, totals, myTeam: 0 })).toEqual([]);
  });
});

describe('roster review', () => {
  const base = { league: 'nba' as const, rest, cats: [] as string[], catValue, totals: [], myTeam: 0 };

  it('names the players to replace when the wire beats them', () => {
    const review = reviewRoster({ ...base, mine: ['star', 'weak'], available: ['free-good', 'free-ok'] });
    expect(review.optimized).toBe(false);
    expect(review.replace).toEqual(['weak']);
    expect(review.rostered).toBe(2);
    expect(review.weakest).toEqual({ drop: 'weak', add: 'free-good', gap: 7 });
  });

  it('says the roster is optimized when nothing available beats a rostered player, and how close it was', () => {
    const review = reviewRoster({ ...base, mine: ['star', 'solid'], available: ['free-ok', 'free-dud'] });
    expect(review.optimized).toBe(true);
    expect(review.upgrades).toEqual([]);
    expect(review.replace).toEqual([]);
    expect(review.weakest).toEqual({ drop: 'solid', add: 'free-ok', gap: -3 });
  });

  it('holds with nobody available and is not a verdict without a roster', () => {
    expect(reviewRoster({ ...base, mine: ['weak'], available: [] }).weakest).toEqual({ drop: 'weak', add: null, gap: -1 });
    expect(reviewRoster({ ...base, mine: [], available: ['free-good'] })).toMatchObject({ optimized: false, weakest: null, rostered: 0 });
  });
});


describe('roster upgrades keep the positions covered (#489)', () => {
  const values = new Map([
    ['c1', 1],
    ['g1', 5],
    ['f1', 5],
    ['g-hi', 9],
    ['c-ok', 3],
  ]);
  const positions: Record<string, string> = { c1: 'C', g1: 'G', f1: 'F', 'g-hi': 'G', 'c-ok': 'F-C' };
  const input = {
    league: 'nba' as const,
    mine: ['c1', 'g1', 'f1'],
    available: ['g-hi', 'c-ok'],
    rest: values,
    cats: [],
    catValue: () => undefined,
    totals: [{}, {}],
    myTeam: 0,
  };

  it('never drops the only center for a non-center', () => {
    // without positions, the best guard replaces the center
    expect(suggestUpgrades(input).map((u) => [u.add, u.drop])[0]).toEqual(['g-hi', 'c1']);
    const out = suggestUpgrades({ ...input, position: (id) => positions[id] });
    expect(out.map((u) => [u.add, u.drop])).toEqual([
      ['g-hi', 'g1'],
      ['c-ok', 'c1'],
    ]);
  });
});

describe('a player other managers value is a trade, not a drop (#710)', () => {
  // the manager punts what "star" is good at: for the build, a free agent beats them
  const punted = new Map([
    ['star', 1],
    ['bench', 2],
    ['free-fit', 5],
  ]);
  const input = {
    league: 'nba' as const,
    mine: ['star', 'bench'],
    available: ['free-fit'],
    rest: punted,
    cats: [],
    catValue: () => undefined,
    totals: [{}, {}],
    myTeam: 0,
  };
  it('never drops a protected player, and lists them as a trade chip instead', () => {
    expect(reviewRoster(input).upgrades.map((u) => u.drop)).toEqual(['star']);
    const review = reviewRoster({ ...input, droppable: (id) => id !== 'star' });
    expect(review.upgrades.map((u) => [u.add, u.drop])).toEqual([['free-fit', 'bench']]);
    expect(review.chips).toEqual(['star']);
  });
  it('lists no chips when nobody is protected', () => {
    expect(reviewRoster(input).chips).toEqual([]);
  });
  it('names the weakest spot among the players who may go', () => {
    expect(reviewRoster(input).weakest?.drop).toBe('star');
    expect(reviewRoster({ ...input, droppable: (id) => id !== 'star' }).weakest?.drop).toBe('bench');
    // with nobody droppable, the lowest of all
    expect(reviewRoster({ ...input, droppable: () => false }).weakest?.drop).toBe('star');
  });
});

describe('dropRule (#710)', () => {
  // a 4-team league of 8: the top 20 are the starters
  const rows = [
    { player_id: 'star', rank_total: 5, market_rank: 40 },
    { player_id: 'market', rank_total: 60, market_rank: 12 },
    { player_id: 'mid', rank_total: 30, market_rank: 35 },
    { player_id: 'low', rank_total: 70, market_rank: null },
    { player_id: 'lower', rank_total: 90, market_rank: null },
  ];
  const mine = rows.map((r) => r.player_id);
  const rest = new Map([
    ['star', 9],
    ['market', 2],
    ['mid', 3],
    ['low', 1],
    ['lower', 0.5],
  ]);
  it('protects a player the board or the market ranks among the starters', () => {
    const may = dropRule(rows, mine, { league: 'nba', teams: 4, rosterSpots: 8 }, rest, false);
    expect(mine.filter(may)).toEqual(['mid', 'low', 'lower']);
  });
  it('judging the week, lets only the two lowest for the rest of the season go', () => {
    const may = dropRule(rows, mine, { league: 'nba', teams: 4, rosterSpots: 8 }, rest, true);
    expect(mine.filter(may)).toEqual(['low', 'lower']);
  });
});
