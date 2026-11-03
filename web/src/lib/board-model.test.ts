import { describe, expect, it } from 'vitest';

import { isLine, num, rankAndTier, restValues, scoreRows, zKey, type ModelRow } from './board-model';

const row = (player_id: string, position: string | null, extra: Record<string, unknown> = {}): ModelRow => ({
  player_id,
  position,
  games_share: 1,
  ros_factor: 1,
  season_complete: false,
  ...extra,
});

const cats = new Map([
  ['a', { z_points: 2, z_assists: 1 }],
  ['b', { z_points: -1, z_assists: 0.5 }],
]);
const none = { points: false, leaguePoints: null, leagueCats: cats, activeCats: ['z_points', 'z_assists'] };

describe('board model', () => {
  it('names the windowed columns and reads numbers', () => {
    expect(zKey('season', 'z_points')).toBe('season_z_points');
    expect(zKey('value', 'z_points')).toBe('z_points');
    expect(isLine('projected')).toBe(true);
    expect(isLine('season')).toBe(false);
    expect(num({ x: 3, y: 'no', z: Number.NaN }, 'x')).toBe(3);
    expect(num({ x: 3, y: 'no', z: Number.NaN }, 'y')).toBeNull();
    expect(num({ x: 3, y: 'no', z: Number.NaN }, 'z')).toBeNull();
  });

  it('values the rest of the season over the active categories, positive value scaled', () => {
    const rows = [row('a', 'G', { games_share: 0.5, ros_factor: 0.8 }), row('b', 'C', { games_share: 0.5, ros_factor: 0.8 })];
    const out = restValues(rows, none);
    expect(out.get('a')).toBeCloseTo(3 * 0.5 * 0.8);
    // a negative value is not scaled by games or by the season left (#478)
    expect(out.get('b')).toBeCloseTo(-0.5);
    // a points league reads the points values
    const pts = restValues(rows, { ...none, points: true, leaguePoints: new Map([['a', { fpts: 30, value: 4 }]]) });
    expect(pts.get('a')).toBeCloseTo(4 * 0.5 * 0.8);
    expect(pts.get('b')).toBe(0);
  });

  it('scores each view: league value with its fit, a stat line, or the window z-score sum', () => {
    const rows = [row('a', 'G', { points_pg: 20, season_z_points: 1, season_z_assists: 0.5 }), row('b', 'C', { points_pg: 9 })];
    const base = { ...none, countGames: true, restOfSeason: false, weights: { z_points: 2, z_assists: 0 } };
    const value = scoreRows(rows, { ...base, view: 'value' });
    expect(value.map((s) => [s.value, s.fit])).toEqual([
      [3, 4],
      [-0.5, -2],
    ]);
    expect(scoreRows(rows, { ...base, view: 'pergame' }).map((s) => s.value)).toEqual([20, 9]);
    // a window with no z-scores for the player has no value
    expect(scoreRows(rows, { ...base, view: 'season' }).map((s) => s.value)).toEqual([1.5, null]);
  });

  it('ranks by position and tiers the value view, counting the players on no roster', () => {
    const rows = [row('g1', 'G'), row('g2', 'G-F'), row('c1', 'C'), row('x', null)];
    const scored = [
      { row: rows[0]!, value: 5, fit: null },
      { row: rows[1]!, value: 3, fit: null },
      { row: rows[2]!, value: 4, fit: null },
      { row: rows[3]!, value: null, fit: null },
    ];
    const lines = rankAndTier(scored, { view: 'season', teams: 2, rosterSpots: 1, owned: () => false });
    expect(Object.fromEntries(lines.posRank)).toEqual({ g1: 'G1', c1: 'C1', g2: 'G2' });
    expect(Object.fromEntries(lines.overall)).toEqual({ g1: 1, c1: 2, g2: 3 });
    expect(lines.tiers).toBeNull();
    const tiered = rankAndTier(scored, { view: 'value', teams: 2, rosterSpots: 1, owned: (id) => id === 'g1' });
    expect(tiered.tiers).not.toBeNull();
    const members = [...(tiered.tiers?.of.keys() ?? [])].sort();
    // the tiers cover the rostered pool (2 teams x 1 spot); g2 is beyond it
    expect(members).toEqual(['c1', 'g1']);
    const left = [...(tiered.tiers?.left.values() ?? [])].reduce((s, n) => s + n, 0);
    expect(left).toBe(1);
  });
});
