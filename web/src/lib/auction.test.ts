import { describe, expect, it } from 'vitest';

import { auctionValues } from './auction';

describe('auctionValues (#741)', () => {
  // 2 teams of 2: four players rostered, $400 in the league
  const values = new Map([
    ['a', 10],
    ['b', 6],
    ['c', 3],
    ['d', 1],
    ['e', 0.5], // outside the rostered pool
  ]);

  it('spends the whole league budget on the players a league this size rosters', () => {
    const $ = auctionValues(values, { teams: 2, rosterSpots: 2, budget: 200 });
    const total = ['a', 'b', 'c', 'd'].reduce((s, id) => s + ($.get(id) ?? 0), 0);
    expect(total).toBeCloseTo(400, 0);
    expect($.get('e')).toBe(0);
  });

  it('pays a dollar each, and the rest in proportion to value above replacement', () => {
    const $ = auctionValues(values, { teams: 2, rosterSpots: 2, budget: 200 });
    // $396 beyond the minimums, over 20 points of value: $19.80 a point
    expect($.get('a')).toBeCloseTo(1 + 10 * 19.8, 5);
    expect($.get('d')).toBeCloseTo(1 + 19.8, 5);
  });

  it('prices a rostered player below replacement at the minimum bid', () => {
    const $ = auctionValues(new Map([['a', 5], ['b', -1]]), { teams: 1, rosterSpots: 2, budget: 100 });
    expect($.get('b')).toBe(1);
    expect($.get('a')).toBe(99);
  });
});
