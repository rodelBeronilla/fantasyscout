import { describe, expect, it } from 'vitest';

import { reviewRoster, suggestUpgrades } from './roster-upgrades';

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
    expect(suggestUpgrades({ mine: [], available: ['free-good'], rest, cats: [], catValue, totals, myTeam: 0 })).toEqual([]);
    expect(suggestUpgrades({ mine: ['weak'], available: [], rest, cats: [], catValue, totals, myTeam: 0 })).toEqual([]);
  });
});

describe('roster review', () => {
  const base = { rest, cats: [] as string[], catValue, totals: [], myTeam: 0 };

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

