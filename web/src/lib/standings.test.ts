import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { expectedWins, GAME_SPREAD, leagueStandings, matchupChance, normalCdf, powerRankings, rivals, standingsModel, standingWeights, teamTotals, winChances } from './standings';

const cats = ['z_points', 'z_steals', 'z_blocks'];

describe('normalCdf', () => {
  it('is the standard normal distribution', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
    expect(normalCdf(1) + normalCdf(-1)).toBeCloseTo(1, 6);
  });
});

describe('standingsModel', () => {
  it('spreads a noisy category wider than a steady one, and a week wider than a season', () => {
    const week = standingsModel('nba', cats, 13, 'h2h');
    const season = standingsModel('nba', cats, 13, 'roto', 60);
    expect(week.spread['z_steals']!).toBeGreaterThan(week.spread['z_points']!);
    expect(week.spread['z_steals']! / week.spread['z_points']!).toBeCloseTo(GAME_SPREAD.nba['z_steals']! / GAME_SPREAD.nba['z_points']!, 6);
    expect(season.spread['z_points']!).toBeLessThan(week.spread['z_points']!);
  });
});

describe('winChances and expectedWins', () => {
  const model = { cats, spread: { z_points: 2, z_steals: 2, z_blocks: 2 } };
  it('gives an even chance against an equal team and near certainty against a far weaker one', () => {
    const totals = [
      { z_points: 0, z_steals: 10, z_blocks: -10 },
      { z_points: 0, z_steals: 0, z_blocks: 0 },
    ];
    const chances = winChances(totals, 0, [1], model);
    expect(chances['z_points']).toBeCloseTo(0.5, 6);
    expect(chances['z_steals']!).toBeGreaterThan(0.99);
    expect(chances['z_blocks']!).toBeLessThan(0.01);
    expect(expectedWins(chances)).toBeCloseTo(1.5, 2);
  });
  it('averages over the rivals', () => {
    const totals = [{ z_points: 0 }, { z_points: 100 }, { z_points: -100 }];
    expect(winChances(totals, 0, [1, 2], { cats: ['z_points'], spread: { z_points: 1 } })['z_points']).toBeCloseTo(0.5, 6);
  });
});

describe('standingWeights', () => {
  it('weights a close category most and one decided either way least, averaging 1', () => {
    const model = { cats, spread: { z_points: 2, z_steals: 2, z_blocks: 2 } };
    // close in points, far ahead in steals, far behind in blocks (a punt)
    const totals = [
      { z_points: 0.5, z_steals: 12, z_blocks: -12 },
      { z_points: 0, z_steals: 0, z_blocks: 0 },
      { z_points: 1, z_steals: 1, z_blocks: 1 },
    ];
    const w = standingWeights(totals, 0, [1, 2], model)!;
    expect(w['z_points']!).toBeGreaterThan(2.9);
    expect(w['z_steals']!).toBeLessThan(0.01);
    expect(w['z_blocks']!).toBeLessThan(0.01);
    expect((w['z_points']! + w['z_steals']! + w['z_blocks']!) / 3).toBeCloseTo(1, 6);
  });
  it('is null with nobody to compare against', () => {
    expect(standingWeights([{ z_points: 1 }], 0, [], { cats: ['z_points'], spread: { z_points: 1 } })).toBeNull();
  });
});

describe('teamTotals', () => {
  it('sums the players by the share of games each is expected to play', () => {
    const values: Record<string, Record<string, number>> = { a: { z_points: 2, z_steals: 1 }, b: { z_points: 1, z_steals: -1 } };
    const totals = teamTotals(['a', 'b', 'missing'], ['z_points', 'z_steals'], (id) => values[id], (id) => (id === 'b' ? 0.5 : 1));
    expect(totals).toEqual({ z_points: 2.5, z_steals: 0.5 });
  });
});

describe('rivals', () => {
  it('leaves out the manager and teams with less than half a roster entered', () => {
    expect(rivals([['a', 'b'], ['c', 'd'], ['e'], []], 0, 4)).toEqual([1]);
  });
});

describe('leagueStandings (#712)', () => {
  const values: Record<string, Record<string, number>> = { a: { z_steals: 2 }, b: { z_steals: -1 }, c: { z_steals: 0 } };
  const base = { rosters: [['a'], ['b'], ['c']], mine: 0, rosterSpots: 1, il: [] as string[], format: 'h2h' as const };
  it('compares the team with every rival that has half a roster', () => {
    const s = leagueStandings('nba', base, ['z_steals'], (id) => values[id], () => 1, 0)!;
    expect(s.others).toEqual([1, 2]);
    expect(s.totals.map((t) => t['z_steals'])).toEqual([2, -1, 0]);
    expect(s.chances['z_steals']).toBeGreaterThan(0.5);
  });
  it('leaves out players on the injured list, and is null without a rival', () => {
    const s = leagueStandings('nba', { ...base, il: ['a'] }, ['z_steals'], (id) => values[id], () => 1, 0)!;
    expect(s.totals[0]?.['z_steals']).toBe(0);
    expect(leagueStandings('nba', { ...base, rosters: [['a'], [], []] }, ['z_steals'], (id) => values[id], () => 1, 0)).toBeNull();
  });
});

describe('powerRankings (#743)', () => {
  // three teams of one player, two categories: a strong at both, b in steals only, c weak
  const values: Record<string, Record<string, number>> = { a: { z_steals: 3, z_blocks: 3 }, b: { z_steals: 3, z_blocks: -3 }, c: { z_steals: -3, z_blocks: -3 } };
  const base = { rosters: [['a'], ['b'], ['c']], mine: 0, rosterSpots: 1, il: [] as string[], format: 'h2h' as const };
  const rank = (format: 'h2h' | 'roto') =>
    powerRankings('nba', { ...base, format }, ['z_steals', 'z_blocks'], (id) => values[id], () => 1, 60)!;

  it('orders every team with half a roster by what it projects to win', () => {
    const r = rank('h2h');
    expect(r.map((x) => x.team)).toEqual([0, 1, 2]);
    expect(r[0]!.expectedCats).toBeGreaterThan(r[1]!.expectedCats);
  });

  it('gives each head-to-head team a matchup win rate against the rest, which sum to half the matchups', () => {
    const r = rank('h2h');
    expect(r[0]!.matchupWin).toBeGreaterThan(0.5);
    expect(r[2]!.matchupWin).toBeLessThan(0.5);
    // every matchup has a winner, a loser or a tie split: the rates average a half
    expect(r.reduce((s, x) => s + (x.matchupWin ?? 0), 0) / r.length).toBeCloseTo(0.5, 5);
  });

  it('gives rotisserie teams expected points: one per category plus one per team beaten', () => {
    const r = rank('roto');
    expect(r[0]!.rotoPoints).toBeGreaterThan(r[2]!.rotoPoints!);
    // 3 teams, 2 categories: the points always sum to 2 × (1 + 2 + 3) = 12
    expect(r.reduce((s, x) => s + (x.rotoPoints ?? 0), 0)).toBeCloseTo(12, 5);
    expect(r[0]!.matchupWin).toBeNull();
  });

  it('is null with fewer than two teams in', () => {
    expect(powerRankings('nba', { ...base, rosters: [['a'], [], []] }, ['z_steals'], (id) => values[id], () => 1, 60)).toBeNull();
  });
});

describe('matchupChance (#743)', () => {
  it('counts more than half the categories a win and exactly half a split', () => {
    expect(matchupChance([1, 1, 0])).toBe(1);
    expect(matchupChance([0.5, 0.5])).toBeCloseTo(0.5, 10);
    // two coin flips and a sure win: win unless both flips lose (0.25), never a tie with three
    expect(matchupChance([0.5, 0.5, 1])).toBeCloseTo(0.75, 10);
  });
});

interface ParityFixture {
  cases: {
    league: 'nba' | 'wnba';
    format: 'h2h' | 'roto';
    cats: string[];
    rosters: string[][];
    rosterSpots: number;
    il: string[];
    mine: number;
    gamesLeft: number;
    values: Record<string, Record<string, number>>;
    availability: Record<string, number>;
  }[];
  models: { league: 'nba' | 'wnba'; cats: string[]; players: number; format: 'h2h' | 'roto'; gamesLeft: number }[];
  expected?: unknown;
}

// The Python reference (ops/standings.py) runs the backtest (#755); both are checked against the
// same figures. UPDATE_STANDINGS_PARITY=1 rewrites them from this module after a deliberate change.
describe('parity with ops/standings.py (#755)', () => {
  const path = fileURLToPath(new URL('../../../tests/fixtures/standings_parity.json', import.meta.url));
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as ParityFixture;
  const computed = {
    cases: fixture.cases.map((c) => {
      const setup = { rosters: c.rosters, mine: c.mine, rosterSpots: c.rosterSpots, il: c.il, format: c.format };
      const value = (id: string) => c.values[id];
      const availability = (id: string) => c.availability[id] ?? 1;
      const s = leagueStandings(c.league, setup, c.cats, value, availability, c.gamesLeft);
      const power = powerRankings(c.league, setup, c.cats, value, availability, c.gamesLeft);
      return { chances: s?.chances ?? null, weights: s?.weights ?? null, totals: s?.totals ?? null, others: s?.others ?? null, power };
    }),
    models: fixture.models.map((m) => standingsModel(m.league, m.cats, m.players, m.format, m.gamesLeft).spread),
  };
  if (process.env['UPDATE_STANDINGS_PARITY']) writeFileSync(path, `${JSON.stringify({ ...fixture, expected: computed }, null, 1)}\n`);

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
