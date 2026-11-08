import { describe, expect, it } from 'vitest';

import { acceptable, type FairnessModel, leagueState, marketMap, playerWorth, tradeLenses } from './league-model';

const rows = [
  { player_id: 'a', games_share: 1, ros_factor: 0.5, season_complete: false, games_this_week: 3, availability_multiplier: 0.9, games_remaining: 40, market_rank: 2 },
  { player_id: 'b', games_share: 0.5, ros_factor: 0.5, season_complete: false, games_this_week: 2, availability_multiplier: null, games_remaining: 41, market_rank: 1 },
  { player_id: 'c', games_share: 1, ros_factor: 0.5, season_complete: false, games_this_week: 0, availability_multiplier: 1, games_remaining: 39, market_rank: null },
];
const catValues = new Map([
  ['a', { z_points: 2, z_blocks: 1 }],
  ['b', { z_points: 1, z_blocks: 3 }],
  ['c', { z_points: -1, z_blocks: -1 }],
]);

describe('playerWorth', () => {
  it('sums the kept categories and scales them to the season and the rest of it', () => {
    const worth = playerWorth(rows, { points: false, cats: ['z_points'], catWeight: { z_points: 1 }, catValues, pointValues: null, recentCats: null });
    expect(worth.get('a')).toMatchObject({ perGame: 2, season: 2, rest: 1, cats: { z_points: 2 }, fpts: null });
    // a punted category is not in the kept ones, so blocks count for nothing
    expect(worth.get('b')?.perGame).toBe(1);
    expect(worth.get('b')?.rest).toBe(0.25);
    // below replacement is not scaled
    expect(worth.get('c')?.rest).toBe(-1);
  });
});

describe('leagueState', () => {
  const worth = playerWorth(rows, { points: false, cats: ['z_points', 'z_blocks'], catWeight: { z_points: 1, z_blocks: 1 }, catValues, pointValues: null, recentCats: null });
  const base = { league: 'nba' as const, format: 'h2h' as const, points: false, cats: ['z_points', 'z_blocks'], rosters: [['a'], ['c']], il: [], rosterSpots: 1, worth, week: false };

  it('lists the free agents best first and reads availability and the games left', () => {
    const state = leagueState(rows, { ...base, owner: new Map([['a', 0], ['c', 1]]) })!;
    expect(state.freeAgents).toEqual(['b']);
    expect(state.availability('a')).toBe(0.9);
    expect(state.availability('b')).toBe(1);
    expect(state.gamesLeft).toBe(41);
    expect(state.rest('a')).toBe(1.5);
  });

  it('is null in a points league or without rosters', () => {
    expect(leagueState(rows, { ...base, owner: new Map() })).toBeNull();
    expect(leagueState(rows, { ...base, points: true, owner: new Map([['a', 0]]) })).toBeNull();
  });
});

describe('the fairness check', () => {
  const value: Record<string, number> = { a: 10, b: 4, c: 1 };
  const model: FairnessModel = {
    league: 'nba',
    state: null,
    mine: 0,
    value: (id) => value[id] ?? 0,
    market: marketMap(rows, new Map(Object.entries(value).map(([id, v]) => [id, { perGame: v, season: v, rest: v, week: v, cats: {}, fpts: null }]))),
    ranked: (id) => typeof rows.find((r) => r.player_id === id)?.market_rank === 'number',
  };

  it('prices the market by rank on the board value curve', () => {
    // the market's first pick is priced at the board's best value
    expect(model.market.get('b')).toBe(10);
    expect(model.market.get('a')).toBe(4);
  });

  it('turns down a trade that gives far more value than it gets, and keeps an even one', () => {
    expect(acceptable(model, -1, ['a'], ['c'])).toBe(false);
    expect(tradeLenses(model, -1, ['a'], ['a']).value.share).toBe(0);
    // a for b: less projected value, but the market's top pick
    expect(tradeLenses(model, -1, ['a'], ['b']).market?.net).toBe(6);
  });
});
