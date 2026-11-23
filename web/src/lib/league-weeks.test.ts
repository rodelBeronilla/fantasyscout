import { describe, expect, it } from 'vitest';

import { type LeagueWeek, missingWeeks, rank, seasonTable, showTotal, weekTable } from './league-weeks';
import type { ScoreSoFar } from './matchup';

const CATS = ['z_points', 'z_turnovers', 'z_field_goal_pct'];
const team = (pts: number, to: number, made: number, att: number): ScoreSoFar => ({ totals: { z_points: pts, z_turnovers: to }, shots: { z_field_goal_pct: [made, att] } });

describe('the league, week by week (#1054)', () => {
  it('ranks competition style: ties share a rank and the next skips; turnovers rank fewest first', () => {
    expect(rank([10, 20, 20, 5], false)).toEqual([3, 1, 1, 4]);
    expect(rank([10, 20, 20, 5], true)).toEqual([2, 3, 3, 1]);
    expect(rank([10, null, 5], false)).toEqual([1, null, 2]);
  });

  it("a week's table: every number is a Yahoo total, a percentage from its makes and attempts", () => {
    const week: LeagueWeek = { week: 1, final: true, teams: [team(500, 60, 200, 400), team(450, 50, 180, 400), team(500, 70, 190, 400)] };
    const [a, b, c] = weekTable(week, CATS);
    expect(a!.values).toEqual({ z_points: 500, z_turnovers: 60, z_field_goal_pct: 0.5 });
    // a tie on points: both first
    expect([a!.ranks['z_points'], b!.ranks['z_points'], c!.ranks['z_points']]).toEqual([1, 3, 1]);
    expect([a!.ranks['z_turnovers'], b!.ranks['z_turnovers'], c!.ranks['z_turnovers']]).toEqual([2, 1, 3]);
    // all-play in categories: each team against each other, every category; the tie counts as a tie
    expect(a!.allPlay).toEqual({ won: 4, lost: 1, tied: 1 });
    const results = [a!, b!, c!].reduce((s, r) => s + r.allPlay.won + r.allPlay.lost + r.allPlay.tied, 0);
    expect(results).toBe(3 * 2 * CATS.length);
  });

  it('an eight-team nine-category week is 63 results a team: 7 opponents times 9 categories', () => {
    const teams = Array.from({ length: 8 }, (_, i) => ({
      totals: { z_points: 400 + i, z_rebounds_total: 200 - i, z_assists: 100, z_steals: 30 + (i % 3), z_blocks: 20, z_three_pointers_made: 50 + i, z_turnovers: 60 - i },
      shots: { z_field_goal_pct: [200 + i, 420] as [number, number], z_free_throw_pct: [90, 120] as [number, number] },
    }));
    const rows = weekTable({ week: 2, final: true, teams });
    for (const r of rows) expect(r.allPlay.won + r.allPlay.lost + r.allPlay.tied).toBe(63);
  });

  it('the season averages each finished week and leaves the week under way out', () => {
    const weeks: LeagueWeek[] = [
      { week: 1, final: true, teams: [team(500, 60, 200, 400), team(450, 50, 180, 400)] },
      { week: 2, final: true, teams: [team(400, 60, 200, 400), team(450, 50, 180, 400)] },
      { week: 3, final: false, teams: [team(10, 1, 2, 4), team(900, 9, 9, 10)] },
    ];
    const [a] = seasonTable(weeks, 2, CATS);
    expect(a!.average['z_points']).toBe(1.5);
    expect(a!.weeks).toBe(2);
    // fewer than four finished weeks: no trend yet
    expect(a!.trend['z_points']).toBeNull();
    expect(showTotal('z_field_goal_pct', 0.4567)).toBe('45.7%');
    expect(showTotal('z_points', 500)).toBe('500');
  });

  it("the trend's half-rank edge is exact: ranks 1, 1, 6, 1, 1, 3 are rising by exactly half a rank (#1064)", () => {
    // seven other teams on fixed points; the first team's points give it these ranks, week by week
    const others = [700, 600, 500, 400, 300, 200, 100];
    const pointsFor = { 1: 800, 3: 550, 6: 250 } as Record<number, number>;
    const weeks: LeagueWeek[] = [1, 1, 6, 1, 1, 3].map((r, i) => ({ week: i + 1, final: true, teams: [pointsFor[r]!, ...others].map((p) => team(p, 50, 200, 400)) }));
    const [a] = seasonTable(weeks, 8, ['z_points']);
    // the season's 13/6 against the last three's 5/3 is half a rank; floating point makes it a hair less
    expect(a!.trend['z_points']).toBeGreaterThan(-0.5);
    expect(a!.move['z_points']).toBe('rising');
    // a team whose ranks do not move has no arrow
    expect(seasonTable(weeks, 8, ['z_points'])[1]!.move['z_points']).toBeNull();
  });

  it('a team Yahoo gave no totals for is named with its weeks; its season is over the weeks it has (#1064)', () => {
    const eight = (missing: number | null) => Array.from({ length: 8 }, (_, i) => (i === missing ? null : team(400 + i, 50, 200, 400)));
    const weeks: LeagueWeek[] = [
      { week: 1, final: true, teams: eight(null) },
      { week: 2, final: true, teams: eight(4) },
      { week: 3, final: false, teams: eight(4) },
    ];
    expect(missingWeeks(weeks, 8)).toEqual([{ team: 4, weeks: [2, 3] }]);
    expect(missingWeeks([weeks[0]!], 8)).toEqual([]);
    // in week 2 the others play six teams, not seven: 54 results; the missing team has none
    const rows = weekTable(weeks[1]!, CATS);
    expect(rows[0]!.allPlay.won + rows[0]!.allPlay.lost + rows[0]!.allPlay.tied).toBe(6 * CATS.length);
    expect(rows[4]!.allPlay).toEqual({ won: 0, lost: 0, tied: 0 });
    expect(rows[4]!.ranks['z_points']).toBeNull();
    const season = seasonTable(weeks, 8, CATS);
    expect(season[4]!.weeks).toBe(1);
    expect(season[0]!.weeks).toBe(2);
  });
});
