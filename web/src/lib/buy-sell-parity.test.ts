import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buySell } from './buy-sell';
import { median } from './punt-chips';

interface BuySellCase {
  name: string;
  mine: number;
  owner: [string, number][];
  projected: Record<string, number>;
  recent: Record<string, number>;
  unhealthy: string[];
  minSwings: (number | null)[];
}

interface ParityFixture {
  cases: BuySellCase[];
  expected?: unknown;
}

function compute(c: BuySellCase) {
  const owner = new Map(c.owner);
  const projected = (id: string) => c.projected[id] ?? 0;
  const startLine = median(c.owner.filter(([, t]) => t === c.mine).map(([id]) => projected(id)));
  return {
    startLine,
    lists: c.minSwings.map((minSwing) =>
      buySell({
        league: 'nba',
        mine: c.mine,
        owner,
        projected,
        recent: (id) => c.recent[id] ?? 0,
        healthy: (id) => !c.unhealthy.includes(id),
        startLine,
        ...(minSwing === null ? {} : { minSwing }),
      }),
    ),
  };
}

// The Python reference (ops/buy_sell.py) runs the backtest (#758); both are checked against the
// same lists. UPDATE_BUY_SELL_PARITY=1 rewrites them from this module after a deliberate change.
describe('parity with ops/buy_sell.py (#758)', () => {
  const path = fileURLToPath(new URL('../../../tests/fixtures/buy_sell_parity.json', import.meta.url));
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as ParityFixture;
  const computed = { cases: fixture.cases.map(compute) };
  if (process.env['UPDATE_BUY_SELL_PARITY']) writeFileSync(path, `${JSON.stringify({ ...fixture, expected: computed }, null, 1)}\n`);

  it('gives the lists the Python reference is checked against', () => {
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

  it('fills both lists and cuts them at the rows shown', () => {
    const all = computed.cases.flatMap((c) => c.lists);
    expect(all.some((l) => l.buyLow.length > 0 && l.sellHigh.length > 0)).toBe(true);
    expect(all.some((l) => l.buyLow.length === 6 || l.sellHigh.length === 6)).toBe(true);
  });
});
