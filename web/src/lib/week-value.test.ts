import { describe, expect, it } from 'vitest';

import { hasWeekGames, recentForm, UNIT_LABEL, weekValue } from './week-value';

describe('the fantasy-week unit', () => {
  it('puts the last-ten z-score in place of the projected one, and keeps the projection without one', () => {
    const rows = [
      { player_id: 'a', z_points: 1, recent_z_points: 2.5, z_rebounds_total: 0.5, recent_z_rebounds_total: null },
      { player_id: 'b', z_points: -1, z_rebounds_total: 0 },
    ];
    const out = recentForm(rows, ['z_points', 'z_rebounds_total']);
    expect(out.map((r) => [r['z_points'], r['z_rebounds_total']])).toEqual([
      [2.5, 0.5],
      [-1, 0],
    ]);
    // the input is left alone
    expect(rows[0]!.z_points).toBe(1);
  });

  it('counts games only for value above replacement', () => {
    expect(weekValue(2, 3)).toBe(6);
    expect(weekValue(2, 0)).toBe(0);
    expect(weekValue(2, null)).toBe(0);
    expect(weekValue(-1.5, 4)).toBe(-1.5);
    expect(weekValue(0, 4)).toBe(0);
  });

  it('is offered only when someone has a game left this week', () => {
    expect(hasWeekGames([{ games_this_week: 0 }, { games_this_week: null }, {}])).toBe(false);
    expect(hasWeekGames([{ games_this_week: 0 }, { games_this_week: 2 }])).toBe(true);
    expect(UNIT_LABEL.week).toBe('this week');
  });
});
