import { describe, expect, it } from 'vitest';

import { movesRotation } from './rotation-moves';

const minutes = (id: string) => ({ starter: 31, deep: 6 })[id] ?? null;
const move = (move_type: string, description: string, player_id: string | null = null) => ({ move_type, description, player_id });

describe('movesRotation (#722)', () => {
  it('keeps trades and standard signings', () => {
    expect(movesRotation(move('trade', 'Traded to the Hawks'), minutes)).toBe(true);
    expect(movesRotation(move('signing', 'Signed a two-year contract'), minutes)).toBe(true);
  });
  it('drops two-way and ten-day deals, extensions and G League shuffles', () => {
    expect(movesRotation(move('signing', 'Signed to a two-way contract'), minutes)).toBe(false);
    expect(movesRotation(move('signing', 'Signed a 10-Day Contract'), minutes)).toBe(false);
    expect(movesRotation(move('g_league', 'Assigned to the G League'), minutes)).toBe(false);
    expect(movesRotation(move('signing', 'Charlotte Hornets re-signed forward Brandon Miller to a Rookie Scale Extension.'), minutes)).toBe(false);
  });
  it('keeps a waiver or suspension only for a player with real minutes', () => {
    expect(movesRotation(move('waive', 'Waived', 'starter'), minutes)).toBe(true);
    expect(movesRotation(move('waive', 'Waived', 'deep'), minutes)).toBe(false);
    expect(movesRotation(move('suspension', 'Suspended one game', null), minutes)).toBe(false);
  });
});
