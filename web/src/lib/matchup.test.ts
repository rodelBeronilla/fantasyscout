import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { POINT_PRESETS } from './fantasy-league';
import { CATEGORY_WORDS } from './format';
import { categoryChance, closeBand, liveWeek, matchup, matchupCall, matchupWeights, swingCategory, usableScore, type WeekTotals, weekTotals } from './matchup';
import { normalCdf } from './standings';
import { PARAMS } from '../generated/parameters';

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
    const m = matchup('nba', cats, weekTotals(mine, cats), weekTotals(theirs, cats));
    expect(m.cats.map((r) => [r.cat, r.result])).toEqual([
      ['z_points', 'win'], // 80 to 75
      ['z_turnovers', 'loss'], // 11 to 6: more turnovers
      ['z_field_goal_pct', 'win'], // .471 to .400
    ]);
    expect([m.wins, m.losses, m.close]).toEqual([2, 1, 0]);
    expect(m.cats[1]!.edge).toBe(-5);
    // 100 to 97 with games to come is a coin flip near enough; with none left it is won (#869)
    const side = (points: number, games: number) => ({ cats: { z_points: points }, games, fpts: 0 });
    const near = matchup('nba', ['z_points'], side(100, 10), side(97, 10), 0.1);
    expect(near.cats[0]!.chance).toBeGreaterThan(0.5);
    expect(near.close).toBe(1);
    expect(matchup('nba', ['z_points'], side(100, 0), side(97, 0), 0.1).cats[0]!.result).toBe('win');
  });

  it("gives each category a chance from the week's spread: Φ(margin ÷ σ√games), a percentage's settling with the shots (#869)", () => {
    const sigma: Record<string, number> = PARAMS['matchup.game_spread']['nba'];
    const side = (points: number, made: number, attempted: number, games: number) => ({
      cats: { z_points: points, z_field_goal_pct: made / attempted },
      games,
      fpts: 0,
      shots: { z_field_goal_pct: [made, attempted] as [number, number] },
    });
    const m = matchup('nba', ['z_points', 'z_field_goal_pct'], side(110, 50, 100, 12), side(100, 45, 100, 8));
    expect(m.cats[0]!.chance).toBeCloseTo(normalCdf(10 / (sigma['z_points']! * Math.sqrt(20))), 12);
    const s = sigma['z_field_goal_pct']! * Math.sqrt(12 / 100 ** 2 + 8 / 100 ** 2);
    expect(m.cats[1]!.chance).toBeCloseTo(normalCdf(0.05 / s), 12);
    // the same percentages over twice the shots are surer
    const more = matchup('nba', ['z_field_goal_pct'], side(110, 100, 200, 12), side(100, 90, 200, 8));
    expect(more.cats[0]!.chance).toBeGreaterThan(m.cats[1]!.chance);
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
    const m = matchup('nba', cats, live.mine, live.theirs, 0);
    expect(m.cats.map((r) => r.result)).toEqual(['win', 'loss', 'win']);
    // a percentage's spread reads the shots so far and to come, over the games left
    expect(m.cats[2]!.chance).toBeCloseTo(categoryChance('nba', 'z_field_goal_pct', live.mine, live.theirs, m.cats[2]!.edge), 12);
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

  it('leads with the call: the count and the swing category, the chance nearest even (#817, #869)', () => {
    const totals = (c: Record<string, number>) => ({ cats: c, games: 10, fpts: 0 });
    const four = ['z_points', 'z_steals', 'z_blocks', 'z_turnovers'];
    // margins in each category's own spread over the 20 games: points ahead by half of it, steals
    // behind by a fifth, blocks behind by two, turnovers ahead by a tenth (fewer is better)
    const spread: Record<string, number> = PARAMS['matchup.game_spread']['nba'];
    const s = (c: string) => spread[c]! * Math.sqrt(20);
    const m = matchup(
      'nba',
      four,
      totals({ z_points: 100, z_steals: 20, z_blocks: 10, z_turnovers: 40 }),
      totals({ z_points: 100 - 0.5 * s('z_points'), z_steals: 20 + 0.2 * s('z_steals'), z_blocks: 10 + 2 * s('z_blocks'), z_turnovers: 40 + 0.1 * s('z_turnovers') }),
      0.1,
    );
    expect(swingCategory(m)).toBe('z_turnovers');
    expect(matchupCall(m, (c) => CATEGORY_WORDS[c] ?? c)).toBe('Winning 1, losing 1, 2 too close: turnovers is the swing category');
    expect(closeBand('nba', 0.1)).toBe('40% to 60%');
    const clear = matchup('nba', ['z_points'], totals({ z_points: 100 }), totals({ z_points: 50 }));
    expect(matchupCall(clear, (c) => CATEGORY_WORDS[c] ?? c)).toBe('Winning 1, losing 0: points is the swing category');
    expect(swingCategory(matchup('nba', [], totals({}), totals({})))).toBeNull();
  });

  it('weights the closest third of the categories most and the blowouts least', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((cat, i) => ({ cat, mine: 0, theirs: 0, edge: 0, share: i / 10, chance: 0.5 + i / 20, result: 'win' as const }));
    expect(matchupWeights(rows)).toEqual({ a: 1.5, b: 1.5, c: 1, d: 1, e: 0.5, f: 0.5 });
  });
});

interface MatchupFixture {
  cases: { league: 'nba' | 'wnba'; cats: string[]; mine: WeekTotals; theirs: WeekTotals; closeness?: number }[];
  expected?: unknown;
}

// The Python reference (ops/matchup.py) runs the backtest (#869); both are checked against the
// same figures. UPDATE_MATCHUP_PARITY=1 rewrites them from this module after a deliberate change.
describe('parity with ops/matchup.py (#869)', () => {
  const path = fileURLToPath(new URL('../../../tests/fixtures/matchup_parity.json', import.meta.url));
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as MatchupFixture;
  const computed = {
    cases: fixture.cases.map((c) => {
      const m = matchup(c.league, c.cats, { ...c.mine, fpts: 0 }, { ...c.theirs, fpts: 0 }, c.closeness);
      return { cats: m.cats.map((r) => ({ cat: r.cat, edge: r.edge, share: r.share, chance: r.chance, result: r.result })), wins: m.wins, losses: m.losses, close: m.close };
    }),
  };
  if (process.env['UPDATE_MATCHUP_PARITY']) writeFileSync(path, `${JSON.stringify({ ...fixture, expected: computed }, null, 1)}\n`);

  it('gives the figures the Python reference is checked against', () => {
    expect(fixture.expected).toBeDefined();
    const close = (a: unknown, b: unknown): void => {
      if (typeof a === 'number' && typeof b === 'number') expect(a).toBeCloseTo(b, 12);
      else if (a && typeof a === 'object' && b && typeof b === 'object') {
        expect(Object.keys(a)).toEqual(Object.keys(b));
        for (const k of Object.keys(a)) close((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]);
      } else expect(a).toEqual(b);
    };
    close(computed, fixture.expected);
  });
});
