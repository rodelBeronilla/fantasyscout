import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, normalize } from './fantasy-league';
import { CATEGORIES } from './format';
import { categoryReplacement, categoryValues, marketPriorShift } from './league-value';
import { ownSettings, playerLeagueValue } from './player-league';
import { leagueValues, partnerSettings, puntedCategories } from './valuation';

// three categories carry the value: a scorer (points, threes, assists) and a big (rebounds, blocks)
const player = (id: string, z: Partial<Record<string, number>>) => ({
  player_id: id,
  position: 'C',
  games_share: 1,
  ros_factor: 1,
  season_complete: false,
  ...Object.fromEntries(CATEGORIES.map((c) => [c, z[c] ?? 0])),
  ...Object.fromEntries(CATEGORIES.map((c) => [`recent_${c}`, (z[c] ?? 0) / 2])),
});
const rows = [
  player('scorer', { z_points: 3, z_three_pointers_made: 2, z_assists: 2 }),
  player('big', { z_rebounds_total: 2, z_blocks: 2 }),
  player('wing', { z_steals: 1, z_points: 1 }),
  ...Array.from({ length: 12 }, (_, i) => player(`bench-${i}`, { z_rebounds_total: -i / 10 })),
];
const PUNTS = ['z_points', 'z_three_pointers_made', 'z_assists'];
const base = { scoring: 'cats9' as const, punts: [] as string[], weights: DEFAULT_SETTINGS.nba.weights, teams: 2, rosterSpots: 3 };

describe('one valuation for every page (#938)', () => {
  it("matches the board's own computation: category values above this league's replacement level, plus the market prior", () => {
    const v = leagueValues(rows, { ...base, punts: PUNTS });
    const kept = CATEGORIES.filter((c) => !PUNTS.includes(c));
    expect(v.activeCats).toEqual(kept);
    expect(v.punted).toEqual(CATEGORIES.filter((c) => PUNTS.includes(c)));
    expect(v.leagueCats).toEqual(categoryValues(rows, kept, 6, 2));
    expect(v.replacement).toEqual(categoryReplacement(rows, kept, 6, 2));
    const cats = v.leagueCats?.get('big') ?? {};
    expect(v.perGame('big')).toBeCloseTo(kept.reduce((s, c) => s + (cats[c] ?? 0), 0) + marketPriorShift(rows[1]!));
  });

  it('counts a punted category for nothing: a punt build ranks the big above the scorer', () => {
    const all = leagueValues(rows, base);
    expect(all.seasonValue('scorer')).toBeGreaterThan(all.seasonValue('big'));
    const punt = leagueValues(rows, { ...base, punts: PUNTS });
    expect(punt.seasonValue('big')).toBeGreaterThan(punt.seasonValue('scorer'));
    expect(punt.restValue.get('big')).toBeCloseTo(punt.seasonValue('big'));
  });

  it('values a trade partner on every category the league scores: no team punts are stored or guessed', () => {
    const s = { ...base, punts: PUNTS };
    expect(partnerSettings(s).punts).toEqual([]);
    expect(leagueValues(rows, partnerSettings(s)).activeCats).toEqual(CATEGORIES);
    // an 8-category league leaves turnovers out for the partner too
    expect(leagueValues(rows, partnerSettings({ ...s, scoring: 'cats8' })).activeCats).not.toContain('z_turnovers');
  });

  it('names what counts for nothing: the punts, turnovers in an 8-category league, none in a points league', () => {
    expect(puntedCategories({ scoring: 'cats9', punts: ['z_points'] })).toEqual(['z_points']);
    expect(puntedCategories({ scoring: 'cats8', punts: [] })).toEqual(['z_turnovers']);
    expect(puntedCategories({ scoring: 'points', punts: ['z_points'] })).toEqual([]);
  });

  it('reads last-ten form on the projection scale, without the market prior', () => {
    const v = leagueValues(rows, base);
    expect(v.perGame('big', true)).not.toBe(v.perGame('big'));
    expect(v.recentCats?.get('big')?.['z_blocks']).toBeCloseTo(1 - (v.replacement?.['z_blocks'] ?? 0));
  });
});

describe("the player page under the manager's league (#938)", () => {
  const setup = normalize({ ...base, punts: PUNTS, rosters: [[], []] }, DEFAULT_SETTINGS.nba);

  it('ranks and values the player under the punts, the same as Rankings', () => {
    const mine = playerLeagueValue(rows, setup, 'big');
    const v = leagueValues(rows, setup);
    expect(mine?.rank).toBe(1);
    expect(mine?.perGame).toBe(v.perGame('big'));
    expect(mine?.season).toBe(v.seasonValue('big'));
    expect(mine?.punted).toEqual(CATEGORIES.filter((c) => PUNTS.includes(c)));
    expect(playerLeagueValue(rows, normalize({ teams: 2, rosterSpots: 3 }, DEFAULT_SETTINGS.nba), 'big')?.rank).toBe(2);
    expect(playerLeagueValue(rows, setup, 'nobody')).toBeNull();
  });

  it('reads the board only for a league whose settings are its own', () => {
    expect(ownSettings('nba', normalize({}, DEFAULT_SETTINGS.nba))).toBe(false);
    expect(ownSettings('nba', setup)).toBe(true);
  });
});
