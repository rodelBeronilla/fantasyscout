import { describe, expect, it } from 'vitest';

import { POINT_PRESETS } from './fantasy-league';
import { CATEGORY_WORDS } from './format';
import { liveWeek, matchup, matchupCall, matchupWeights, swingCategory, usableScore, weekTotals } from './matchup';

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

  it('counts the games a player starts when they are given, not every game his team has (#817)', () => {
    // the first player starts 2 of his 3 games; the second sits all of his: a full lineup
    const starts: Record<number, number> = { 20: 2, 10: 0 };
    const t = weekTotals(mine, cats, undefined, (r) => starts[r['proj_points_pg'] as number] ?? 0);
    expect(t.cats['z_points']).toBe(40);
    expect(t.games).toBe(2);
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

  it('starts from the score so far: counting totals add, percentages add the shots (#817)', () => {
    const rest = { mine: weekTotals(mine, cats), theirs: weekTotals(theirs, cats) };
    // so far: 300 points to 200, 20 turnovers to 10, 48 of 100 from the field to 45 of 90
    const live = liveWeek(
      cats,
      {
        mine: { totals: { z_points: 300, z_turnovers: 20 }, shots: { z_field_goal_pct: [48, 100] } },
        theirs: { totals: { z_points: 200, z_turnovers: 10 }, shots: { z_field_goal_pct: [45, 90] } },
      },
      rest,
    );
    expect(live.projectedOnly).toEqual([]);
    expect(live.mine.cats['z_points']).toBe(380); // 300 so far + 80 to come
    expect(live.theirs.cats['z_turnovers']).toBe(16);
    expect(live.mine.cats['z_field_goal_pct']).toBeCloseTo((48 + 32) / (100 + 68), 6);
    expect(live.theirs.cats['z_field_goal_pct']).toBeCloseTo((45 + 24) / (90 + 60), 6);
    // the games left stay the games left
    expect(live.mine.games).toBe(5);
    const m = matchup(cats, live.mine, live.theirs);
    expect(m.cats.map((r) => r.result)).toEqual(['win', 'loss', 'close']);
  });

  it('projects a category the score lacks on either side, for both sides (#817)', () => {
    const rest = { mine: weekTotals(mine, cats), theirs: weekTotals(theirs, cats) };
    const live = liveWeek(
      cats,
      { mine: { totals: { z_points: 300, z_turnovers: 20 }, shots: { z_field_goal_pct: [40, 100] } }, theirs: { totals: { z_points: 200 }, shots: {} } },
      rest,
    );
    expect(live.projectedOnly).toEqual(['z_turnovers', 'z_field_goal_pct']);
    expect(live.mine.cats['z_turnovers']).toBe(11);
    expect(live.mine.cats['z_field_goal_pct']).toBeCloseTo(32 / 68, 6);
    expect(live.mine.cats['z_points']).toBe(380);
  });

  it("starts a points league's week from the fantasy points so far, and needs them on both sides (#877)", () => {
    const rest = { mine: { cats: {}, games: 6, fpts: 210 }, theirs: { cats: {}, games: 4, fpts: 150 } };
    const soFar = { mine: { totals: { fpts: 300 }, shots: {} }, theirs: { totals: { fpts: 380.5 }, shots: {} } };
    const live = liveWeek([], soFar, rest);
    expect([live.mine.fpts, live.theirs.fpts]).toEqual([510, 530.5]);
    expect(live.projectedOnly).toEqual([]);
    expect(live.mine.games).toBe(6);
    // a category league's score carries no fantasy points: its fpts stay the projection
    expect(liveWeek([], { mine: { totals: { z_points: 1 }, shots: {} }, theirs: { totals: { z_points: 2 }, shots: {} } }, rest).mine.fpts).toBe(210);
    expect(usableScore(soFar, true)).toBe(soFar);
    expect(usableScore({ ...soFar, theirs: { totals: { z_points: 2 }, shots: {} } }, true)).toBe('no-score');
    expect(usableScore('stale', true)).toBe('stale');
    // a category league takes its score as it comes
    expect(usableScore({ ...soFar, theirs: { totals: {}, shots: {} } }, false)).not.toBe('no-score');
  });

  it('leads with the call: the count and the swing category, the closest by share (#817)', () => {
    const totals = (c: Record<string, number>) => ({ cats: c, games: 0, fpts: 0 });
    const four = ['z_points', 'z_steals', 'z_blocks', 'z_turnovers'];
    // points won by 10%, steals lost by 4% (too close), blocks lost by 50%, turnovers won by 2%
    const m = matchup(four, totals({ z_points: 100, z_steals: 24, z_blocks: 5, z_turnovers: 49 }), totals({ z_points: 90, z_steals: 25, z_blocks: 10, z_turnovers: 50 }));
    expect(swingCategory(m)).toBe('z_turnovers');
    expect(matchupCall(m, (c) => CATEGORY_WORDS[c] ?? c)).toBe('Winning 1, losing 1, 2 too close: turnovers is the swing category');
    const clear = matchup(['z_points'], totals({ z_points: 100 }), totals({ z_points: 50 }));
    expect(matchupCall(clear, (c) => CATEGORY_WORDS[c] ?? c)).toBe('Winning 1, losing 0: points is the swing category');
    expect(swingCategory(matchup([], totals({}), totals({})))).toBeNull();
  });

  it('weights the closest third of the categories most and the blowouts least', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((cat, i) => ({ cat, mine: 0, theirs: 0, edge: 0, share: i / 10, result: 'win' as const }));
    expect(matchupWeights(rows)).toEqual({ a: 1.5, b: 1.5, c: 1, d: 1, e: 0.5, f: 0.5 });
  });
});
