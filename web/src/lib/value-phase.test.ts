import { describe, expect, it } from 'vitest';

import { judgedFrom, preseasonBadge, valuePhase } from './value-phase';

// a regular who has played every game and a bench player with fewer, in an 82-game season
const nba = (played: number) => [
  { games_current: played, games_remaining: 82 - played, season_complete: false },
  { games_current: Math.floor(played / 2), games_remaining: 82 - played, season_complete: false },
];
// the same in a 44-game WNBA season
const wnba = (played: number) => [{ games_current: played, games_remaining: 44 - played, season_complete: false }];

describe('the judged window (ADR 0031)', () => {
  it('starts at the market prior fade in the NBA and at a tenth of the season in the WNBA', () => {
    expect(judgedFrom('nba', 82)).toBe(20); // the fade (20) is later than a tenth (8.2)
    expect(judgedFrom('wnba', 44)).toBeCloseTo(4.4); // no prior: a tenth
  });
});

describe('valuePhase', () => {
  it('is preseason before the first game', () => {
    expect(valuePhase('nba', nba(0))).toBe('preseason');
    expect(valuePhase('wnba', wnba(0))).toBe('preseason');
  });

  it('is preseason once the regular season is over, when values project the next', () => {
    expect(valuePhase('nba', [{ games_current: 82, games_remaining: 0, season_complete: true }])).toBe('preseason');
  });

  it('is preseason for an empty board', () => {
    expect(valuePhase('nba', [])).toBe('preseason');
  });

  it('stays early in the NBA while the market prior still weighs', () => {
    expect(valuePhase('nba', nba(1))).toBe('early');
    expect(valuePhase('nba', nba(19))).toBe('early');
    expect(valuePhase('nba', nba(20))).toBe('in-season');
  });

  it('stays early in the WNBA until a tenth of the season', () => {
    expect(valuePhase('wnba', wnba(4))).toBe('early');
    expect(valuePhase('wnba', wnba(5))).toBe('in-season');
  });

  it('reads missing counts as none', () => {
    expect(valuePhase('nba', [{ games_current: null, games_remaining: null, season_complete: null }])).toBe('preseason');
  });
});

describe('preseasonBadge', () => {
  it('shows everywhere but the judged in-season window', () => {
    expect(preseasonBadge('preseason')).toBe(true);
    expect(preseasonBadge('early')).toBe(true);
    expect(preseasonBadge('in-season')).toBe(false);
  });
});
