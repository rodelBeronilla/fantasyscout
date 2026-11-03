import { describe, expect, it } from 'vitest';

import { combinations, nearestInValue, openSide, suggestTrades } from './trade-suggest';

describe('trade suggestions', () => {
  it('enumerate every package up to the size allowed', () => {
    const all = combinations(['a', 'b', 'c'], 2);
    expect(all).toHaveLength(6);
    expect(all).toContainEqual(['a', 'b']);
    expect(all.some((c) => c.length === 3)).toBe(false);
    expect(combinations([], 2)).toEqual([]);
  });

  it('fill the side with nothing fixed, else the lighter side', () => {
    const rest = new Map([['a', 1], ['b', 5]]);
    expect(openSide([], ['b'], rest)).toBe('give');
    expect(openSide(['a'], [], rest)).toBe('get');
    expect(openSide(['a'], ['b'], rest)).toBe('give');
    expect(openSide(['b'], ['a'], rest)).toBe('get');
  });

  it('find the players worth about the same, nearest first, leaving out the targets, the excluded and the worthless', () => {
    const rest = new Map([['a', 10], ['b', 12], ['c', 3], ['d', 9], ['e', 0]]);
    expect(nearestInValue(['a'], rest, ['d'])).toEqual([
      { id: 'b', diff: 2 },
      { id: 'c', diff: -7 },
    ]);
    expect(nearestInValue(['a'], rest, [], 1)).toEqual([{ id: 'd', diff: -1 }]);
  });
});

describe('trade suggestions keep the positions covered (#489)', () => {
  it('leave out a package that takes the manager’s only center for a guard', () => {
    const rest = new Map([
      ['c1', 5],
      ['g1', 5],
      ['g2', 5],
      ['c2', 5],
    ]);
    const positions: Record<string, string> = { c1: 'C', g1: 'G', g2: 'G', c2: 'C' };
    const input = {
      give: ['c1'],
      get: [],
      mine: ['c1', 'g1'],
      theirs: ['g2', 'c2'],
      rest,
      cats: [],
      catValue: () => undefined,
      totals: [{}, {}],
      myTeam: 0,
      partnerTeam: 1,
    };
    expect(suggestTrades(input).map((s) => s.get)).toEqual(expect.arrayContaining([['g2'], ['c2']]));
    expect(suggestTrades({ ...input, position: (id) => positions[id] }).map((s) => s.get)).toEqual([['c2']]);
  });
});
