import { describe, expect, it } from 'vitest';

import { bestLineup, startsByPlayer, daysLeftInWeek, normalizeSlots, slotList, weekPlan } from './lineup';

const slots = { G: 1, F: 1, C: 1, UTIL: 1 };

describe('bestLineup (#735)', () => {
  it('starts the most valuable players the slots can hold', () => {
    const day = bestLineup(
      [
        { id: 'g1', position: 'G', value: 5 },
        { id: 'g2', position: 'G', value: 4 },
        { id: 'g3', position: 'G', value: 3 },
        { id: 'c1', position: 'C', value: 1 },
      ],
      slotList(slots),
    );
    // G and UTIL take the two best guards, C the center; the third guard has nowhere to go
    expect([...day.started.keys()].sort()).toEqual(['c1', 'g1', 'g2']);
    expect(day.benched).toEqual(['g3']);
    expect(day.open).toEqual(['F']);
  });

  it('moves a flexible player to make room rather than bench a better one', () => {
    // greedy by value would put the G-F in G and leave the pure guard out; a matching moves the G-F to F
    const day = bestLineup(
      [
        { id: 'gf', position: 'G-F', value: 9 },
        { id: 'g', position: 'G', value: 8 },
        { id: 'f', position: 'F', value: 1 },
      ],
      slotList({ G: 1, F: 1, C: 0, UTIL: 0 }),
    );
    expect(day.started.get('g')).toBe('G');
    expect(day.started.get('gf')).toBe('F');
    expect(day.benched).toEqual(['f']);
  });

  it('puts a player without a listed position only in Utility', () => {
    const day = bestLineup([{ id: 'x', position: null, value: 2 }], slotList(slots));
    expect(day.started.get('x')).toBe('UTIL');
  });
});

describe('weekPlan (#735)', () => {
  const players = [
    { id: 'a', position: 'G', value: 3 },
    { id: 'b', position: 'G', value: 2 },
    { id: 'c', position: 'C', value: 1 },
  ];
  const games: Record<string, string[]> = {
    '2026-11-09': ['a', 'b', 'c'],
    '2026-11-10': ['a'],
  };
  it('counts the games started, the games lost to a full lineup, and the open slots', () => {
    const plan = weekPlan(players, Object.keys(games), (id, d) => games[d]!.includes(id), slotList({ G: 1, F: 0, C: 1, UTIL: 0 }));
    expect(plan.started).toBe(3); // a, c on Monday; a on Tuesday
    expect(plan.lost).toBe(1); // b on Monday
    expect(plan.days[0]!.benched).toEqual(['b']);
    expect(plan.days[1]!.open).toEqual(['C']);
    expect(plan.openSlots).toBe(1);
    expect(plan.games).toBe(4);
  });

  it("counts each player's started games: what the week's matchup counts (#817)", () => {
    const plan = weekPlan(players, Object.keys(games), (id, d) => games[d]!.includes(id), slotList({ G: 1, F: 0, C: 1, UTIL: 0 }));
    expect(Object.fromEntries(startsByPlayer(plan))).toEqual({ a: 2, c: 1 }); // b sat for want of a guard slot
  });
});

describe('normalizeSlots (#735)', () => {
  it('keeps whole counts from 0 to 6 and falls back for anything else', () => {
    expect(normalizeSlots({ G: 2.4, F: -1, C: 9, UTIL: 'x' as unknown as number }, { G: 3, F: 3, C: 2, UTIL: 2 })).toEqual({ G: 2, F: 0, C: 6, UTIL: 2 });
    expect(normalizeSlots(undefined, { G: 3, F: 3, C: 2, UTIL: 2 })).toEqual({ G: 3, F: 3, C: 2, UTIL: 2 });
  });
});

describe('daysLeftInWeek (#735)', () => {
  it('runs from today to Sunday', () => {
    expect(daysLeftInWeek('2026-11-06')).toEqual(['2026-11-06', '2026-11-07', '2026-11-08']); // a Friday
    expect(daysLeftInWeek('2026-11-08')).toEqual(['2026-11-08']); // the Sunday itself
    expect(daysLeftInWeek('2026-11-09')).toHaveLength(7); // a Monday
  });
});
