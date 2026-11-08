import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { dropRule, type DropRow, reviewRoster } from './roster-upgrades';

interface RosterCase {
  name: string;
  teams: number;
  rosterSpots: number;
  week: boolean;
  rows: DropRow[];
  rosters: string[][];
  myTeam: number;
  available: string[];
  rest: Record<string, number>;
  cats: string[];
  values: Record<string, Record<string, number>>;
  totals: Record<string, number>[];
  minGains: number[];
}

interface ParityFixture {
  cases: RosterCase[];
  expected?: unknown;
}

function compute(c: RosterCase) {
  const mine = c.rosters[c.myTeam] ?? [];
  const rest = new Map(Object.entries(c.rest));
  const droppable = dropRule(c.rows, mine, { teams: c.teams, rosterSpots: c.rosterSpots }, rest, c.week);
  const base = { mine, available: c.available, rest, cats: c.cats, catValue: (id: string) => c.values[id], totals: c.totals, myTeam: c.myTeam };
  return {
    droppable: Object.fromEntries(mine.map((id) => [id, droppable(id)])),
    reviews: c.minGains.map((minGain) => ({
      rule: reviewRoster({ ...base, minGain, droppable }),
      anyone: reviewRoster({ ...base, minGain }),
    })),
  };
}

// The Python reference (ops/roster.py) runs the backtest (#757); both are checked against the
// same figures. UPDATE_ROSTER_PARITY=1 rewrites them from this module after a deliberate change.
describe('parity with ops/roster.py (#757)', () => {
  const path = fileURLToPath(new URL('../../../tests/fixtures/roster_parity.json', import.meta.url));
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as ParityFixture;
  const computed = { cases: fixture.cases.map(compute) };
  if (process.env['UPDATE_ROSTER_PARITY']) writeFileSync(path, `${JSON.stringify({ ...fixture, expected: computed }, null, 1)}\n`);

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

  it('exercises the rule, the swaps and the chips', () => {
    const all = computed.cases.flatMap((c) => c.reviews.map((r) => r.rule));
    expect(all.some((r) => r.upgrades.length > 0)).toBe(true);
    expect(all.some((r) => r.chips.length > 0)).toBe(true);
    expect(computed.cases.some((c) => Object.values(c.droppable).includes(false))).toBe(true);
  });
});
