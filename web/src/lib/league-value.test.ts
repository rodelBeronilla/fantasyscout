import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from './fantasy-league';
import { restValues, scoreRows } from './board-model';
import { CATEGORIES } from './format';
import { categoryReplacement, categoryValues, fantasyPoints, fitWeights, leagueTiers, marketPriorShift, naturalBreaks, pointValues, primaryPosition, replacementLevel, scaleValue } from './league-value';
import { playerWorth } from './league-model';
import { teamValues } from './team-review';

const rows = [10, 8, 6, 4, 2].map((v, i) => ({ player_id: `p${i + 1}`, v, w: v / 2 }));

describe('replacement level', () => {
  it('is the mean of the players ranked just outside the pool', () => {
    // pool 2, teams 2: ranks 3 and 4 by v (6 and 4)
    expect(replacementLevel(rows, ['v', 'w'], (r) => r['v'] as number, 2, 2)).toEqual({ v: 5, w: 2.5 });
  });

  it('moves the band in when the board is smaller than the pool', () => {
    // five players, pool 10: the band is the last two
    expect(replacementLevel(rows, ['v'], (r) => r['v'] as number, 10, 2)).toEqual({ v: 3 });
  });

  it('is zero with nobody to measure', () => {
    expect(replacementLevel([], ['v'], () => 0, 2, 2)).toEqual({ v: 0 });
  });
});

describe('category and point values', () => {
  it('subtract the replacement level from every player, so the pool is positive and the rest not', () => {
    const values = categoryValues(rows, ['v'], 2, 2);
    expect(values.get('p1')).toEqual({ v: 5 });
    expect(values.get('p5')).toEqual({ v: -3 });
  });

  it('measure a window from the projection replacement level, not its own (ADR 0019)', () => {
    // projected v: replacement 5 (ranks 3 and 4); the window's own band would be 1 and 0
    const window = [9, 7, 3, 1, 0].map((v, i) => ({ player_id: `p${i + 1}`, v }));
    const values = categoryValues(window, ['v'], 2, 2, rows);
    expect(values.get('p1')).toEqual({ v: 4 });
    expect(values.get('p5')).toEqual({ v: -5 });
    expect(categoryReplacement(rows, ['v'], 2, 2)).toEqual({ v: 5 });
  });

  it('score fantasy points with the league weights over the projected line', () => {
    const weights = { ...DEFAULT_SETTINGS.nba.weights, points: 1, rebounds: 2, turnovers: -1, assists: 0, steals: 0, blocks: 0, threes: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 };
    expect(fantasyPoints({ proj_points_pg: 20, proj_rebounds_total_pg: 5, proj_turnovers_pg: 3 }, weights)).toBe(27);
    expect(fantasyPoints({ proj_points_pg: 'n/a', proj_rebounds_total_pg: null }, weights)).toBe(0);
  });

  it('value points above replacement by player id', () => {
    const weights = { ...DEFAULT_SETTINGS.nba.weights, points: 1, rebounds: 0, turnovers: 0, assists: 0, steals: 0, blocks: 0, threes: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 };
    const pts = [30, 20, 10, 5, 0].map((v, i) => ({ player_id: `p${i + 1}`, proj_points_pg: v }));
    const values = pointValues(pts, weights, 2, 2);
    expect(values.get('p1')).toEqual({ fpts: 30, value: 22.5 }); // replacement: mean of 10 and 5
    expect(values.get('p4')).toEqual({ fpts: 5, value: -2.5 });
  });
});

describe('tiers', () => {
  it('break a sorted list where the values separate', () => {
    expect(naturalBreaks([10, 9, 8, 2, 1], 2)).toEqual([0, 3]);
    expect(naturalBreaks([], 3)).toEqual([]);
    expect(naturalBreaks([5], 3)).toEqual([0]);
  });

  it('cover the players a league rosters and say which draft rounds they fall in', () => {
    const tiers = leagueTiers([10, 9, 2, 1, 0.5], 2, 2);
    expect(tiers).toEqual([
      { tier: 1, start: 0, end: 1, high: 10, low: 9, firstRound: 1, lastRound: 1 },
      { tier: 2, start: 2, end: 3, high: 2, low: 1, firstRound: 2, lastRound: 2 },
    ]);
  });

  it("weight the weakest third of a team's categories most", () => {
    expect(fitWeights({ a: 1, b: 2, c: 3 })).toEqual({ a: 1.5, b: 1, c: 0.5 });
  });

  it('read the primary position from the listing', () => {
    expect(primaryPosition('G-F')).toBe('G');
    expect(primaryPosition(' c ')).toBe('C');
    expect(primaryPosition(null)).toBe('');
  });
});

describe('scaleValue', () => {
  const row = { games_share: 0.5, ros_factor: 0.4, season_complete: false };
  it('scales only a positive value by the games share and the rest of the season, as mart_board does', () => {
    expect(scaleValue(10, row)).toBeCloseTo(2); // 10 × 0.5 × 0.4: value_rest_of_season
    expect(scaleValue(10, row, { restOfSeason: false })).toBeCloseTo(5); // value_total
    expect(scaleValue(10, row, { countGames: false })).toBeCloseTo(4);
    expect(scaleValue(10, row, { countGames: false, restOfSeason: false })).toBe(10);
  });
  it('leaves a value at or below replacement as it is: a missed game by such a player costs nothing', () => {
    expect(scaleValue(-3, row)).toBe(-3);
    expect(scaleValue(0, row)).toBe(0);
  });
  it('ignores the rest-of-season factor once the season is over, and treats missing fields as 1', () => {
    expect(scaleValue(10, { ...row, season_complete: true })).toBeCloseTo(5);
    expect(scaleValue(10, {})).toBe(10);
  });
});

describe('the market prior on the league scale (#848, ADR 0020)', () => {
  // mart_board's unit test (market_prior_prices_the_draft_rank_and_fades): own values 2, 1, 0, -1
  // and -2 in points only, the prior at weight 0.5 fading by four games. Its z_total is the
  // published value per game.
  const zero = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const board = [
    { player_id: 'a', z_points: 2, market_prior_weight: 0.25, market_prior_value: 0, value_per_game: 1.5 },
    { player_id: 'b', z_points: 1, market_prior_weight: 0, market_prior_value: 1, value_per_game: 1 },
    { player_id: 'c', z_points: 0, market_prior_weight: 0, market_prior_value: null, value_per_game: 0 },
    { player_id: 'd', z_points: -1, market_prior_weight: 0, market_prior_value: null, value_per_game: -1 },
    { player_id: 'e', z_points: -2, market_prior_weight: 0.5, market_prior_value: 2, value_per_game: 0 },
  ].map((r) => ({ ...zero, position: 'G', games_share: 1, ros_factor: 1, season_complete: false, rank_total: 1, ...r, recent_z_points: r.z_points }));
  // a pool of two in a one-team league: the replacement level is c's, zero, as at the default size
  const pool = 2;
  const teams = 1;
  const valueOf = (activeCats: string[], rows = board) =>
    scoreRows(rows, {
      view: 'value',
      points: false,
      leaguePoints: null,
      leagueCats: categoryValues(rows, activeCats, pool, teams),
      activeCats,
      countGames: false,
      restOfSeason: false,
      weights: null,
    }).map((s) => s.value);

  it('is the weight times the market price less the nine categories, and nothing without a weight or a price', () => {
    expect(board.map(marketPriorShift)).toEqual([-0.5, 0, 0, 0, 2]);
    expect(marketPriorShift({ z_points: 3, market_prior_weight: null, market_prior_value: 5 })).toBe(0);
    expect(marketPriorShift({ z_points: 3, market_prior_weight: 0.5 })).toBe(0);
  });

  it("puts the Board's value on the published value per game at the default league size, with no punts", () => {
    expect(valueOf(CATEGORIES)).toEqual(board.map((r) => r.value_per_game));
  });

  it('keeps the shift whole in a punt build, which subtracts only the punted categories', () => {
    const withAssists = board.map((r) => ({ ...r, z_assists: r.player_id === 'a' ? 1 : 0 }));
    // a: own 3 over the nine against the market's 0, at a quarter weight: a shift of -0.75
    const kept = CATEGORIES.filter((c) => c !== 'z_assists');
    expect(valueOf(kept, withAssists)[0]).toBeCloseTo(2 - 0.75);
    expect(valueOf(CATEGORIES, withAssists)[0]).toBeCloseTo(3 - 0.75);
  });

  it('is a no-op when the weight is 0, as in the WNBA and past the fade', () => {
    const off = board.map((r) => ({ ...r, market_prior_weight: 0 }));
    expect(valueOf(CATEGORIES, off)).toEqual(off.map((r) => r.z_points));
  });

  it('reaches My Team and Trade: the projection carries it; last-ten form and a points league do not', () => {
    const leagueCats = categoryValues(board, CATEGORIES, pool, teams);
    expect(restValues(board, { points: false, leaguePoints: null, leagueCats, activeCats: CATEGORIES }).get('a')).toBeCloseTo(1.5);
    const catWeight = Object.fromEntries(CATEGORIES.map((c) => [c, 1]));
    const worth = playerWorth(board, { points: false, cats: CATEGORIES, catWeight, catValues: leagueCats, pointValues: null, recentCats: null });
    expect(worth.get('a')?.perGame).toBeCloseTo(1.5);
    const settings = { scoring: 'cats9' as const, punts: [], weights: DEFAULT_SETTINGS.nba.weights, teams, rosterSpots: pool };
    const v = teamValues(board, settings);
    expect(v.perGame('a')).toBeCloseTo(1.5);
    expect(v.perGame('a', true)).toBeCloseTo(2);
    const off = board.map((r) => ({ ...r, market_prior_weight: 0 }));
    const points = { ...settings, scoring: 'points' as const };
    expect(teamValues(board, points).perGame('e')).toBe(teamValues(off, points).perGame('e'));
  });
});
