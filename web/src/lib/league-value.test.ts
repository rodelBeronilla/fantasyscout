import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from './fantasy-league';
import { categoryValues, fantasyPoints, fitWeights, leagueTiers, naturalBreaks, pointValues, primaryPosition, replacementLevel } from './league-value';

const rows = [10, 8, 6, 4, 2].map((v, i) => ({ player_id: `p${i + 1}`, v, w: v / 2 }));

describe('replacement level', () => {
  it('is the mean of the players ranked just outside the pool', () => {
    // pool 2, teams 2: ranks 3 and 4 by v (6 and 4)
    expect(replacementLevel(rows, ['v', 'w'], (r) => r['v'] as number, 2, 2)).toEqual({ v: 5, w: 2.5 });
  });

  it('moves the band in when the board is smaller than the pool', () => {
    // five players, pool 10: the band is the last two
    expect(replacementLevel(rows, ['v'], (r) => r['v'] as number, 10, 2)).toEqual({ v: 3 });
  });

  it('is zero with nobody to measure', () => {
    expect(replacementLevel([], ['v'], () => 0, 2, 2)).toEqual({ v: 0 });
  });
});

describe('category and point values', () => {
  it('subtract the replacement level from every player, so the pool is positive and the rest not', () => {
    const values = categoryValues(rows, ['v'], 2, 2);
    expect(values.get('p1')).toEqual({ v: 5 });
    expect(values.get('p5')).toEqual({ v: -3 });
  });

  it('score fantasy points with the league weights over the projected line', () => {
    const weights = { ...DEFAULT_SETTINGS.nba.weights, points: 1, rebounds: 2, turnovers: -1, assists: 0, steals: 0, blocks: 0, threes: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 };
    expect(fantasyPoints({ proj_points_pg: 20, proj_rebounds_total_pg: 5, proj_turnovers_pg: 3 }, weights)).toBe(27);
    expect(fantasyPoints({ proj_points_pg: 'n/a', proj_rebounds_total_pg: null }, weights)).toBe(0);
  });

  it('value points above replacement by player id', () => {
    const weights = { ...DEFAULT_SETTINGS.nba.weights, points: 1, rebounds: 0, turnovers: 0, assists: 0, steals: 0, blocks: 0, threes: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 };
    const pts = [30, 20, 10, 5, 0].map((v, i) => ({ player_id: `p${i + 1}`, proj_points_pg: v }));
    const values = pointValues(pts, weights, 2, 2);
    expect(values.get('p1')).toEqual({ fpts: 30, value: 22.5 }); // replacement: mean of 10 and 5
    expect(values.get('p4')).toEqual({ fpts: 5, value: -2.5 });
  });
});

describe('tiers', () => {
  it('break a sorted list where the values separate', () => {
    expect(naturalBreaks([10, 9, 8, 2, 1], 2)).toEqual([0, 3]);
    expect(naturalBreaks([], 3)).toEqual([]);
    expect(naturalBreaks([5], 3)).toEqual([0]);
  });

  it('cover the players a league rosters and say which draft rounds they fall in', () => {
    const tiers = leagueTiers([10, 9, 2, 1, 0.5], 2, 2);
    expect(tiers).toEqual([
      { tier: 1, start: 0, end: 1, high: 10, low: 9, firstRound: 1, lastRound: 1 },
      { tier: 2, start: 2, end: 3, high: 2, low: 1, firstRound: 2, lastRound: 2 },
    ]);
  });

  it("weight the weakest third of a team's categories most", () => {
    expect(fitWeights({ a: 1, b: 2, c: 3 })).toEqual({ a: 1.5, b: 1, c: 0.5 });
  });

  it('read the primary position from the listing', () => {
    expect(primaryPosition('G-F')).toBe('G');
    expect(primaryPosition(' c ')).toBe('C');
    expect(primaryPosition(null)).toBe('');
  });
});
