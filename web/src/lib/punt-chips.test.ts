import { describe, expect, it } from 'vitest';

import { median, ranks, tradeChips, tradeTargets } from './punt-chips';

// value over every category, and over a punt of PTS, 3PM and AST
const all: Record<string, number> = { star: 13, scorer: 9, guard: 8, big: 6, wing: 4, rim: 3, glass: 2, dud: -1 };
const kept: Record<string, number> = { star: 9.6, scorer: 0.5, guard: 0.2, big: 8, wing: 2.4, rim: 6, glass: 2.2, dud: -0.5 };
const ids = Object.keys(all);
const league = ranks(ids, (id) => all[id] ?? 0);
const build = ranks(ids, (id) => kept[id] ?? 0);

describe('ranks', () => {
  it('ranks best first from 1', () => {
    expect(league.get('star')).toBe(1);
    expect(build.get('star')).toBe(1);
    expect(build.get('big')).toBe(2);
    expect(build.get('scorer')).toBe(6);
  });
});

describe('tradeChips', () => {
  it('lists the manager’s players the league ranks well above the build does, and not a star who stays on top', () => {
    const chips = tradeChips(['star', 'scorer', 'big', 'wing'], league, build, { pool: 6, minGap: 3 });
    expect(chips.map((c) => c.id)).toEqual(['scorer']);
    expect(chips[0]).toEqual({ id: 'scorer', league: 2, build: 6 });
  });
  it('leaves out a player a league this size does not roster', () => {
    expect(tradeChips(['dud', 'glass'], league, build, { pool: 6, minGap: 1 })).toEqual([]);
  });
});

describe('tradeTargets', () => {
  it('lists players the build ranks well above the league does, among those who would start', () => {
    expect(tradeTargets(['rim', 'glass', 'big', 'guard'], league, build, { ceiling: 4, minGap: 2 }).map((t) => t.id)).toEqual(['rim', 'big']);
  });
});

describe('median', () => {
  it('is the middle value', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});
