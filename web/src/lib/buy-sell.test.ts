import { describe, expect, it } from 'vitest';

import { buySell } from './buy-sell';

// projected and last-ten value per game above replacement
const proj = new Map([
  ['hot', 2],
  ['steady', 3],
  ['cold', 4],
  ['cold-hurt', 4],
  ['cold-deep', 0.2],
  ['mine-cold', 3],
]);
const recent = new Map([
  ['hot', 4.5],
  ['steady', 3.2],
  ['cold', 1.5],
  ['cold-hurt', 0.5],
  ['cold-deep', -2],
  ['mine-cold', 1],
]);
const owner = new Map([
  ['hot', 0],
  ['steady', 0],
  ['mine-cold', 0],
  ['cold', 1],
  ['cold-hurt', 1],
  ['cold-deep', 2],
]);

const input = {
  mine: 0,
  owner,
  projected: (id: string) => proj.get(id) ?? 0,
  recent: (id: string) => recent.get(id) ?? 0,
  healthy: (id: string) => id !== 'cold-hurt',
  startLine: 1,
};

describe('buySell (#739)', () => {
  it('sells your players running well above their projection, the biggest run first', () => {
    expect(buySell(input).sellHigh.map((x) => x.id)).toEqual(['hot']);
    expect(buySell(input).sellHigh[0]!.form).toBeCloseTo(2.5);
  });

  it('buys players elsewhere in a slump below a projection that would start for you, healthy only', () => {
    const buy = buySell(input).buyLow;
    // cold: projected 4 (starts for you), playing at 1.5; cold-hurt is injured; cold-deep would not start
    expect(buy.map((x) => [x.id, x.team])).toEqual([['cold', 1]]);
  });

  it('never lists your own slumping player to buy, or a small swing either way', () => {
    const { buyLow, sellHigh } = buySell(input);
    expect(buyLow.map((x) => x.id)).not.toContain('mine-cold');
    expect(sellHigh.map((x) => x.id)).not.toContain('steady');
  });
});
