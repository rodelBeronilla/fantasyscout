import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, normalize } from './fantasy-league';
import { type ReviewRow, teamReview } from './team-review';
import { leagueValues } from './valuation';

// one category carries the value: the higher z_points, the better the player
const row = (id: string, z: number, rank: number, position = 'G', games = 3): ReviewRow => ({
  player_id: id,
  position,
  rank_total: rank,
  z_points: z,
  recent_z_points: z,
  games_this_week: games,
});
const rows: ReviewRow[] = [
  row('star', 6, 3),
  row('mid', 2, 40),
  row('low', 0.5, 80, 'F'),
  row('hurt', 0.2, 90),
  row('fa', 4, 30),
  row('fa-c', 3, 35, 'C'),
  ...Array.from({ length: 30 }, (_, i) => row(`pool-${i}`, -1 - i / 10, 100 + i)),
];
const setup = normalize(
  { teams: 4, rosterSpots: 6, rosters: [['star', 'mid', 'low', 'hurt'], ['pool-0'], ['pool-1'], ['pool-2']], il: ['hurt'], mine: 0 },
  DEFAULT_SETTINGS.nba,
);

describe('the team review Pickups and My Team share (#819)', () => {
  it('judges the active roster and never names a ranked starter or a player on the IL to drop', () => {
    const v = leagueValues(rows, setup);
    const out = teamReview('nba', rows, setup, v, false);
    expect(out?.mine).toEqual(['star', 'mid', 'low']);
    expect(out?.review.rostered).toBe(3);
    expect(out?.drops).not.toContain('star');
    expect(out?.drops).not.toContain('hurt');
    // the review's own swaps first, then the lowest-valued player who may go
    expect(out?.drops[0]).toBe(out?.review.replace[0] ?? 'low');
    expect(out?.drops).toEqual(expect.arrayContaining(['low', 'mid']));
  });

  it('the week unit drops only from the two lowest for the rest of the season', () => {
    const v = leagueValues(rows, setup);
    const out = teamReview('nba', rows, setup, v, true);
    expect(out?.drops.every((id) => ['low', 'mid'].includes(id))).toBe(true);
  });

  it('waits while a draft is under way, and has nothing without a team', () => {
    const v = leagueValues(rows, setup);
    expect(teamReview('nba', rows, { ...setup, drafting: true }, v, false)).toBeNull();
    expect(teamReview('nba', rows, { ...setup, rosters: setup.rosters.map(() => []) }, v, false)).toBeNull();
  });

  it('a points league values by fantasy points, with no category values', () => {
    const v = leagueValues(rows, { ...setup, scoring: 'points' });
    expect(v.points).toBe(true);
    expect(v.leagueCats).toBeNull();
    expect(v.leaguePoints?.size).toBe(rows.length);
    expect(v.perGame('star')).toBe(v.leaguePoints?.get('star')?.value);
  });

  it('a category league leaves its punts out of the values', () => {
    const v = leagueValues(rows, { ...setup, punts: ['z_points'] });
    expect(v.activeCats).not.toContain('z_points');
    expect(v.perGame('star')).toBe(v.perGame('low'));
  });
});
