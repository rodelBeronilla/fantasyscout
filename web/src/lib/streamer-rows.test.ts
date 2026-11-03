import { describe, expect, it } from 'vitest';
import { withRankTotal } from './streamer-rows';

describe('streamer rows', () => {
  it('reads an older build’s board_rank as rank_total', () => {
    const old = [{ player_id: 'a', board_rank: 12 }, { player_id: 'b', board_rank: null }] as unknown as { player_id: string; rank_total: number | null }[];
    expect(withRankTotal(old).map((r) => r.rank_total)).toEqual([12, null]);
  });

  it('leaves a current row as it is', () => {
    const rows = [{ player_id: 'a', rank_total: 3 }];
    expect(withRankTotal(rows)[0]).toBe(rows[0]);
  });
});
