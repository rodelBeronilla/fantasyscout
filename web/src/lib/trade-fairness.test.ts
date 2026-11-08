import { describe, expect, it } from 'vitest';

import { judge, lens, marketValues } from './trade-fairness';

// Edwards + Davis + Markkanen (A) for Daniels + McDaniels + Duren + Holmgren (B), build of
// 2026-11-03: projected rest-of-season value favours B, the market (ESPN ranks priced on the
// board) favours A (#692).
const value: Record<string, number> = { edwards: 3.19, davis: 2.77, markkanen: 2.01, daniels: 3.03, mcdaniels: 2.88, duren: 2.21, holmgren: 2.38 };
const market: Record<string, number> = { edwards: 4.59, davis: 3.03, markkanen: 2.03, daniels: 2.18, mcdaniels: 1.37, duren: 2.52, holmgren: 1.62 };
const A = ['edwards', 'davis', 'markkanen'];
const B = ['daniels', 'mcdaniels', 'duren', 'holmgren'];
const v = (id: string) => value[id] ?? 0;
const m = (id: string) => market[id] ?? 0;

describe('lens', () => {
  it('sums each side, a player below replacement counting zero, and gives the net as a share of the larger side', () => {
    const l = lens(A, B, v);
    expect(l.give).toBeCloseTo(7.97, 2);
    expect(l.get).toBeCloseTo(10.5, 2);
    expect(l.share).toBeCloseTo((10.5 - 7.97) / 10.5, 3);
    expect(lens(['x'], ['y'], (id) => (id === 'x' ? -3 : 1)).net).toBe(1);
  });
});

describe('judge: the trade that looked even', () => {
  it('giving the stars: the projections favour you, the market calls it a loss, and the page says they disagree', () => {
    const f = judge(lens(A, B, v), lens(A, B, m), null, 0.05);
    expect(f.even).toBe(false);
    expect(f.disagree).toBe(true);
    expect(f.severity).toBe('bad');
    expect(f.reasons.join(' ')).toContain("ESPN's ranks");
  });
  it('giving the depth: the projections call it a loss, the market a win', () => {
    const f = judge(lens(B, A, v), lens(B, A, m), null, 0.05);
    expect(f.even).toBe(false);
    expect(f.disagree).toBe(true);
    expect(f.severity).toBe('bad');
    expect(f.reasons.join(' ')).toContain('projected value');
  });
  it('is even only when every lens is', () => {
    const even = { a: 3, b: 3.1 };
    const e = (id: string) => even[id as keyof typeof even] ?? 0;
    expect(judge(lens(['a'], ['b'], e), lens(['a'], ['b'], e), 0, 0.05).even).toBe(true);
    expect(judge(lens(['a'], ['b'], e), lens(['a'], ['b'], e), -0.2, 0.05).even).toBe(false);
  });
  it('calls a big loss on any lens terrible', () => {
    const lopsided = (id: string) => (id === 'star' ? 10 : 2);
    expect(judge(lens(['star'], ['bench'], lopsided), null, null, 0.05).severity).toBe('terrible');
    const even = (id: string) => (id === 'star' ? 5 : 5);
    expect(judge(lens(['star'], ['bench'], even), null, -0.3, 0.05).severity).toBe('terrible');
  });
});

describe('marketValues', () => {
  it("prices each player at the board's value for his ESPN rank, and keeps his own value without a rank", () => {
    const players = [
      { player_id: 'a', market_rank: 3 },
      { player_id: 'b', market_rank: 1 },
      { player_id: 'c', market_rank: null },
    ];
    const own: Record<string, number> = { a: 9, b: 5, c: 2 };
    const out = marketValues(players, (id) => own[id] ?? 0);
    expect(out.get('b')).toBe(9);
    expect(out.get('a')).toBe(2);
    expect(out.get('c')).toBe(2);
  });
});
