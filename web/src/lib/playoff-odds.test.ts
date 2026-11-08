import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { playoffOdds, pointsPlayoffOdds, roundRobin, seededRandom, simulateOdds } from './playoff-odds';

const cats = ['z_points', 'z_rebounds_total', 'z_assists'];
const spread = { z_points: 1, z_rebounds_total: 1, z_assists: 1 };
const level = (n: number) => Array.from({ length: n }, () => ({ z_points: 0, z_rebounds_total: 0, z_assists: 0 }));

describe('seededRandom', () => {
  it('draws the same numbers from the same seed, in [0, 1)', () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const draws = Array.from({ length: 1000 }, () => a());
    expect(draws).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(draws.every((x) => x >= 0 && x < 1)).toBe(true);
    // roughly uniform: the mean of a thousand draws is near a half
    expect(draws.reduce((s, x) => s + x, 0) / draws.length).toBeCloseTo(0.5, 1);
    expect(seededRandom(8)()).not.toBe(seededRandom(7)());
  });
});

describe('roundRobin', () => {
  it('pairs every team with every other once over n - 1 weeks, each team once a week', () => {
    const weeks = roundRobin(6, 5);
    const met = new Set<string>();
    for (const week of weeks) {
      const teams = week.flat();
      expect(new Set(teams).size).toBe(6);
      for (const [a, b] of week) met.add([a, b].sort().join('-'));
    }
    expect(met.size).toBe(15);
  });

  it('gives one team a bye each week in an odd league, and starts the cycle again after it', () => {
    const weeks = roundRobin(5, 6);
    expect(weeks.every((w) => w.length === 2)).toBe(true);
    expect(weeks[5]).toEqual(weeks[0]);
    expect(roundRobin(1, 3)).toEqual([[], [], []]);
  });
});

describe('simulateOdds (#821)', () => {
  it('is the same on every run, and the odds sum to the playoff spots', () => {
    const input = { totals: level(4), spread, cats, records: [], weeks: roundRobin(4, 6), tally: 'categories' as const, spots: 2, sims: 500 };
    const one = simulateOdds(input);
    expect(simulateOdds(input)).toEqual(one);
    expect(one.odds.reduce((s, p) => s + p, 0)).toBeCloseTo(2, 10);
    // four level teams: each about even for two spots of four
    for (const p of one.odds) expect(p).toBeGreaterThan(0.4);
    for (const p of one.odds) expect(p).toBeLessThan(0.6);
  });

  it('puts a far stronger team in nearly every time, and a far weaker one almost never', () => {
    const totals = level(4);
    totals[0] = { z_points: 3, z_rebounds_total: 3, z_assists: 3 };
    totals[3] = { z_points: -3, z_rebounds_total: -3, z_assists: -3 };
    const { odds } = simulateOdds({ totals, spread, cats, records: [], weeks: roundRobin(4, 9), tally: 'matchups', spots: 2, sims: 500 });
    expect(odds[0]).toBeGreaterThan(0.99);
    expect(odds[3]).toBeLessThan(0.01);
  });

  it('starts from the records: with no weeks left the table is settled', () => {
    const records = [
      { wins: 10, losses: 2, ties: 0, seed: null },
      { wins: 2, losses: 10, ties: 0, seed: null },
      { wins: 8, losses: 4, ties: 0, seed: null },
      { wins: 4, losses: 8, ties: 0, seed: null },
    ];
    const done = simulateOdds({ totals: level(4), spread, cats, records, weeks: [], tally: 'categories', spots: 2, sims: 50 });
    expect(done.odds).toEqual([1, 0, 1, 0]);
    expect(done.wins).toEqual([10, 2, 8, 4]);
  });

  it('counts each category in a categories tally and one result a week in a matchups tally', () => {
    const weeks = [[[0, 1]] as [number, number][]];
    const cat = simulateOdds({ totals: level(2), spread, cats, records: [], weeks, tally: 'categories', spots: 1, sims: 200 });
    expect(cat.wins[0]! + cat.losses[0]!).toBeCloseTo(3, 10);
    const match = simulateOdds({ totals: level(2), spread, cats, records: [], weeks, tally: 'matchups', spots: 1, sims: 200 });
    expect(match.wins[0]! + match.losses[0]!).toBeCloseTo(1, 10);
  });
});

describe('playoffOdds', () => {
  const rosters = [['a1', 'a2'], ['b1', 'b2'], ['c1', 'c2'], ['d1', 'd2']];
  const value = (id: string) => (id.startsWith('a') ? { z_points: 2, z_rebounds_total: 2, z_assists: 2 } : { z_points: 0, z_rebounds_total: 0, z_assists: 0 });
  const setup = { rosters, il: [], rosterSpots: 2, format: 'h2h' as const, playoffs: { teams: 2 } };
  const schedule = { weeks: roundRobin(4, 6), records: [], tally: 'categories' as const };

  it("plays the standings model forward: the strongest roster is the likeliest in", () => {
    const odds = playoffOdds('nba', setup, cats, value, () => 1, schedule, 400);
    expect(odds).not.toBeNull();
    expect(odds!.odds[0]).toBeGreaterThan(Math.max(...odds!.odds.slice(1)));
  });

  it('has none outside a head-to-head category league, or until every team has half a roster in', () => {
    expect(playoffOdds('nba', { ...setup, format: 'roto' }, cats, value, () => 1, schedule)).toBeNull();
    expect(playoffOdds('nba', setup, [], value, () => 1, schedule)).toBeNull();
    expect(playoffOdds('nba', { ...setup, rosters: [...rosters.slice(0, 3), []] }, cats, value, () => 1, schedule)).toBeNull();
  });
});

describe('pointsPlayoffOdds (#877)', () => {
  const rosters = [['a1', 'a2'], ['b1', 'b2'], ['c1', 'c2'], ['d1', 'd2']];
  const setup = { rosters, il: [], rosterSpots: 2, format: 'h2h' as const, playoffs: { teams: 2 } };
  const schedule = { weeks: roundRobin(4, 6), records: [] };

  it('plays each week out on fantasy points: the higher-scoring roster is the likelier in, level rosters split the spots', () => {
    const fpts = (id: string) => (id.startsWith('a') ? 40 : 30);
    const odds = pointsPlayoffOdds('nba', setup, fpts, () => 1, schedule, 400)!;
    expect(odds.odds[0]).toBeGreaterThan(Math.max(...odds.odds.slice(1)));
    expect(odds.odds.reduce((s, p) => s + p, 0)).toBeCloseTo(2, 6);
    // one result a week: six weeks, six games each
    expect(odds.wins[0]! + odds.losses[0]!).toBeCloseTo(6, 6);
    const level = pointsPlayoffOdds('nba', setup, () => 30, () => 1, schedule, 2000)!;
    for (const p of level.odds) expect(p).toBeCloseTo(0.5, 1);
  });

  it("counts a player by his share of the games, leaves the IL out, and starts from the records", () => {
    const fpts = () => 30;
    // team a's players are expected to miss most games, and one is on the IL
    const hurt = pointsPlayoffOdds('nba', { ...setup, il: ['a2'] }, fpts, (id) => (id.startsWith('a') ? 0.2 : 1), schedule, 400)!;
    expect(hurt.odds[0]).toBeLessThan(Math.min(...hurt.odds.slice(1)));
    const settled = pointsPlayoffOdds('nba', setup, fpts, () => 1, { weeks: [], records: [null, { wins: 9, losses: 1, ties: 0, seed: null }, { wins: 8, losses: 2, ties: 0, seed: null }, null] }, 50)!;
    expect(settled.odds).toEqual([0, 1, 1, 0]);
  });

  it('has none outside a head-to-head league, until every team has half a roster in, or without projections', () => {
    expect(pointsPlayoffOdds('nba', { ...setup, format: 'roto' }, () => 30, () => 1, schedule)).toBeNull();
    expect(pointsPlayoffOdds('nba', { ...setup, rosters: [...rosters.slice(0, 3), []] }, () => 30, () => 1, schedule)).toBeNull();
    expect(pointsPlayoffOdds('nba', setup, () => 0, () => 1, schedule)).toBeNull();
  });
});

describe('a lasting share (#872)', () => {
  const totals = level(4);
  totals[0] = { z_points: 0.8, z_rebounds_total: 0.8, z_assists: 0.8 };
  const base = { totals, spread, cats, records: [], weeks: roundRobin(4, 12), tally: 'matchups' as const, spots: 2, sims: 2000 };

  it('makes the odds less sure, since a team that is better than it looks stays better all season', () => {
    const independent = simulateOdds(base);
    const lasting = simulateOdds({ ...base, seasonShare: 0.5 });
    expect(lasting.odds[0]).toBeLessThan(independent.odds[0]!);
    expect(lasting.odds[0]).toBeGreaterThan(0.5);
    expect(lasting.odds.reduce((s, p) => s + p, 0)).toBeCloseTo(2, 10);
  });

  it('is the independent simulation at 0', () => {
    expect(simulateOdds({ ...base, seasonShare: 0 })).toEqual(simulateOdds(base));
  });
});

interface PlayoffsFixture {
  draws: { seed: number; count: number };
  robins: [number, number][];
  cases: {
    totals: Record<string, number>[];
    spread: Record<string, number>;
    cats: string[];
    records: ({ wins: number; losses: number; ties: number } | null)[];
    robin: [number, number];
    tally: 'categories' | 'matchups';
    spots: number;
    sims: number;
    seasonShare: number;
  }[];
  expected?: unknown;
}

// The Python reference (ops/playoffs.py) runs the backtest (#872) and makes the web's draws one for
// one. UPDATE_PLAYOFFS_PARITY=1 rewrites the figures from this module after a deliberate change.
describe('parity with ops/playoffs.py (#872)', () => {
  const path = fileURLToPath(new URL('../../../tests/fixtures/playoffs_parity.json', import.meta.url));
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as PlayoffsFixture;
  const random = seededRandom(fixture.draws.seed);
  const computed = {
    draws: Array.from({ length: fixture.draws.count }, () => random()),
    robins: fixture.robins.map(([t, w]) => roundRobin(t, w)),
    cases: fixture.cases.map((c) =>
      simulateOdds({
        totals: c.totals,
        spread: c.spread,
        cats: c.cats,
        records: c.records.map((r) => (r ? { ...r, seed: null } : null)),
        weeks: roundRobin(c.robin[0], c.robin[1]),
        tally: c.tally,
        spots: c.spots,
        sims: c.sims,
        seasonShare: c.seasonShare,
      }),
    ),
  };
  if (process.env['UPDATE_PLAYOFFS_PARITY']) writeFileSync(path, `${JSON.stringify({ ...fixture, expected: computed }, null, 1)}\n`);

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
