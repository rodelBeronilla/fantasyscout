import { describe, expect, it } from 'vitest';

import { combinations, nearestInValue, openSide } from './trade-suggest';

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
