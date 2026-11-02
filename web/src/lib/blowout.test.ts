import { describe, expect, it } from 'vitest';

import { blowout, nextGames } from './blowout';

const games = [
  { game_date: '2026-11-03', days_ahead: 1, home_team_id: 'A', away_team_id: 'B', home_spread: -12.5 },
  { game_date: '2026-11-02', days_ahead: 0, home_team_id: 'C', away_team_id: 'A', home_spread: 3 },
  { game_date: '2026-11-01', days_ahead: -1, home_team_id: 'B', away_team_id: 'C', home_spread: 20 },
  { game_date: '2026-11-04', days_ahead: 2, home_team_id: 'D', away_team_id: 'E', home_spread: null },
];

describe('blowout', () => {
  it("takes each team's next game from today on", () => {
    const next = nextGames(games);
    expect(next.get('A')?.game_date).toBe('2026-11-02');
    expect(next.get('B')?.game_date).toBe('2026-11-03');
    expect(next.has('F')).toBe(false);
  });
  it('flags a starter only, at a spread of 10 or more, with the league rate per 5 points', () => {
    const next = nextGames(games);
    expect(blowout('nba', 'starter', next.get('B'))).toEqual({ spread: 12.5, minutes: 2.5 * 0.73 });
    expect(blowout('wnba', 'starter', next.get('B'))?.minutes).toBeCloseTo(2.5 * 0.37);
    expect(blowout('nba', 'bench', next.get('B'))).toBeNull();
    expect(blowout('nba', 'starter', next.get('A'))).toBeNull(); // a 3-point game
    expect(blowout('nba', 'starter', next.get('D'))).toBeNull(); // no line
    expect(blowout('nba', 'starter', undefined)).toBeNull();
  });
});
