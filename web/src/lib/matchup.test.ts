import { describe, expect, it } from 'vitest';

import { POINT_PRESETS } from './fantasy-league';
import { matchup, matchupWeights, weekTotals } from './matchup';

const cats = ['z_points', 'z_turnovers', 'z_field_goal_pct'];
const mine = [
  { proj_points_pg: 20, proj_turnovers_pg: 3, proj_fgm_pg: 8, proj_fga_pg: 16, games_this_week: 3 },
  { proj_points_pg: 10, proj_turnovers_pg: 1, proj_fgm_pg: 4, proj_fga_pg: 10, games_this_week: 2 },
  { proj_points_pg: 30, proj_turnovers_pg: 5, proj_fgm_pg: 10, proj_fga_pg: 20, games_this_week: null }, // no game left
];
const theirs = [{ proj_points_pg: 25, proj_turnovers_pg: 2, proj_fgm_pg: 8, proj_fga_pg: 20, games_this_week: 3 }];

describe('the head-to-head week', () => {
  it('totals the projected line over the games left, percentages as made over attempted', () => {
    const t = weekTotals(mine, cats, POINT_PRESETS['espn']!.weights);
    expect(t.cats['z_points']).toBe(80); // 20×3 + 10×2
    expect(t.cats['z_turnovers']).toBe(11);
    expect(t.cats['z_field_goal_pct']).toBeCloseTo((24 + 8) / (48 + 20), 6);
    expect(t.games).toBe(5);
    // ESPN points: pts 1, to -2, fgm 2, fga -1, over the games
    expect(t.fpts).toBeCloseTo((20 - 6 + 16 - 16) * 3 + (10 - 2 + 8 - 10) * 2, 6);
  });

  it('calls each category won, lost or too close, turnovers to the lower total', () => {
    const m = matchup(cats, weekTotals(mine, cats), weekTotals(theirs, cats));
    expect(m.cats.map((r) => [r.cat, r.result])).toEqual([
      ['z_points', 'win'], // 80 to 75
      ['z_turnovers', 'loss'], // 11 to 6: more turnovers
      ['z_field_goal_pct', 'win'], // .471 to .400
    ]);
    expect([m.wins, m.losses, m.close]).toEqual([2, 1, 0]);
    expect(m.cats[1]!.edge).toBe(-5);
    expect(matchup(['z_points'], { cats: { z_points: 100 }, games: 0, fpts: 0 }, { cats: { z_points: 97 }, games: 0, fpts: 0 }).close).toBe(1);
  });

  it('weights the closest third of the categories most and the blowouts least', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((cat, i) => ({ cat, mine: 0, theirs: 0, edge: 0, share: i / 10, result: 'win' as const }));
    expect(matchupWeights(rows)).toEqual({ a: 1.5, b: 1.5, c: 1, d: 1, e: 0.5, f: 0.5 });
  });
});
