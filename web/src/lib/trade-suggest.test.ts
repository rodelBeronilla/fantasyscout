import { describe, expect, it } from 'vitest';

import { combinations, findTrades, nearestInValue, openSide, suggestTrades } from './trade-suggest';

describe('trade suggestions', () => {
  it('enumerate every package up to the size allowed', () => {
    const all = combinations(['a', 'b', 'c'], 2);
    expect(all).toHaveLength(6);
    expect(all).toContainEqual(['a', 'b']);
    expect(all.some((c) => c.length === 3)).toBe(false);
    expect(combinations([], 2)).toEqual([]);
  });

  it('fill the side with nothing fixed, else the lighter side', () => {
    const rest = new Map([['a', 1], ['b', 5]]);
    expect(openSide([], ['b'], rest)).toBe('give');
    expect(openSide(['a'], [], rest)).toBe('get');
    expect(openSide(['a'], ['b'], rest)).toBe('give');
    expect(openSide(['b'], ['a'], rest)).toBe('get');
  });

  it('find the players worth about the same, nearest first, leaving out the targets, the excluded and the worthless', () => {
    const rest = new Map([['a', 10], ['b', 12], ['c', 3], ['d', 9], ['e', 0]]);
    expect(nearestInValue(['a'], rest, ['d'])).toEqual([
      { id: 'b', diff: 2 },
      { id: 'c', diff: -7 },
    ]);
    expect(nearestInValue(['a'], rest, [], 1)).toEqual([{ id: 'd', diff: -1 }]);
  });
});

describe('trade suggestions keep the positions covered (#489)', () => {
  it('leave out a package that takes the manager’s only center for a guard', () => {
    const rest = new Map([
      ['c1', 5],
      ['g1', 5],
      ['g2', 5],
      ['c2', 5],
    ]);
    const positions: Record<string, string> = { c1: 'C', g1: 'G', g2: 'G', c2: 'C' };
    const input = {
      give: ['c1'],
      get: [],
      mine: ['c1', 'g1'],
      theirs: ['g2', 'c2'],
      rest,
    };
    expect(suggestTrades(input).map((s) => s.get)).toEqual(expect.arrayContaining([['g2'], ['c2']]));
    expect(suggestTrades({ ...input, position: (id) => positions[id] }).map((s) => s.get)).toEqual([['c2']]);
  });
});

describe('trade suggestions count a player below replacement as zero', () => {
  it('never pad a package with a below-replacement player to make it look even', () => {
    // giving a 1.0 for their 2.0 star is lopsided; adding their -1.0 player only looks even if
    // negatives count (2.0 - 1.0 = 1.0), though a free agent is worth as much as that player
    const rest = new Map([
      ['mine', 1],
      ['star', 2],
      ['dud', -1],
    ]);
    const out = suggestTrades({
      give: ['mine'],
      get: [],
      mine: ['mine'],
      theirs: ['star', 'dud'],
      rest,
      tolerance: 0.15,
    });
    expect(out.some((s) => s.get.includes('dud'))).toBe(false);
    expect(out).toEqual([]);
  });
});

describe('trade suggestions in a categories league rank by the categories won (#663)', () => {
  // The manager gives "a" (value 5). The partner has: "fit" (value 3) and "wash" (value 2), which
  // raise the manager's categories; "star" (value 5), which barely does; and "steal" (value 8),
  // which raises them but costs the partner value and categories alike.
  const rest = new Map([
    ['a', 5],
    ['fit', 3],
    ['wash', 2],
    ['star', 5],
    ['steal', 8],
  ]);
  const effects: Record<string, { gain: number; partnerGain: number }> = {
    fit: { gain: 0.4, partnerGain: 0.1 },
    wash: { gain: 0.1, partnerGain: -0.1 },
    star: { gain: 0.01, partnerGain: 0 },
    steal: { gain: 0.2, partnerGain: -0.1 },
  };
  const out = suggestTrades({
    give: ['a'],
    get: [],
    mine: ['a'],
    theirs: ['fit', 'wash', 'star', 'steal'],
    rest,
    maxAdd: 1,
    effect: (_give, get) => ({ ...(effects[get[0]!] ?? { gain: 0, partnerGain: 0 }), ups: [], downs: [] }),
  });
  it('keeps packages that win the manager categories even when they give up value, biggest gain first', () => {
    expect(out.map((s) => s.get)).toEqual([['fit'], ['wash']]);
    expect(out[0]?.net).toBe(-2);
  });
  it('leaves out a package that wins nothing, and one the partner loses on in value and categories alike', () => {
    expect(out.some((s) => s.get.includes('star'))).toBe(false);
    expect(out.some((s) => s.get.includes('steal'))).toBe(false);
  });
});

describe('the trade finder (#664)', () => {
  const rest = new Map([
    ['m1', 5],
    ['m2', 3],
    ['p1', 4],
    ['p2', 6],
    ['q1', 4],
  ]);
  // what each trade does: the manager wants p1 (a fit), not p2; q1 helps the manager but costs the
  // other partner categories and value alike
  const effect = (_partner: number, give: string[], get: string[]) => {
    const gain = get.includes('p1') ? 0.3 : get.includes('q1') ? 0.2 : get.includes('p2') ? 0.01 : 0;
    const partnerGain = get.includes('q1') ? -0.1 : 0.05 - (give.length - 1) * 0.1;
    return { gain, partnerGain, ups: [], downs: [] };
  };
  const out = findTrades({
    mine: ['m1', 'm2'],
    partners: [
      { team: 1, roster: ['p1', 'p2'] },
      { team: 2, roster: ['q1'] },
    ],
    rest,
    effect,
    minGain: 0.05,
  });
  it('lists the trades that win the manager categories with a reason for the partner to say yes, biggest gain first', () => {
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((t) => t.get.includes('p1') || t.get.includes('q1'))).toBe(true);
    expect(out[0]?.get).toContain('p1');
    expect(out[0]?.partner).toBe(1);
  });
  it('leaves out a trade the partner loses on in categories and value alike', () => {
    // m2 (3) for q1 (4): the partner loses value and categories; m1 (5) for q1 gives them value
    expect(out.some((t) => t.partner === 2 && t.give.length === 1 && t.give[0] === 'm2')).toBe(false);
    expect(out.some((t) => t.partner === 2 && t.give[0] === 'm1')).toBe(true);
  });
  it('lists at most three trades a partner', () => {
    expect(out.filter((t) => t.partner === 1).length).toBeLessThanOrEqual(3);
  });
});
