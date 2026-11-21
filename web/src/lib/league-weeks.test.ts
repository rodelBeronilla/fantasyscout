import { describe, expect, it } from 'vitest';

import { type LeagueWeek, rank, seasonTable, showTotal, weekTable } from './league-weeks';
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
});
