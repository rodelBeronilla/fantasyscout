import { describe, expect, it } from 'vitest';

import { ilMoves } from './il-moves';

const rows = [
  { player_id: 'star', injury_group: null, injury_status: null, expected_games_missed: 0 },
  { player_id: 'hurt', injury_group: 'out', injury_status: 'Out', expected_games_missed: 9.4 },
  { player_id: 'dtd', injury_group: 'day_to_day', injury_status: 'Day-To-Day', expected_games_missed: 1.4 },
  { player_id: 'healed', injury_group: null, injury_status: null, expected_games_missed: 0 },
  { player_id: 'still', injury_group: 'out', injury_status: 'Out', expected_games_missed: 13.9 },
];

describe('IL moves', () => {
  it('sends the players expected to miss several games to the IL, worst first', () => {
    const moves = ilMoves(rows, ['star', 'hurt', 'dtd', 'still'], ['still']);
    expect(moves.toIl).toEqual(['hurt']);
    expect(moves.back).toEqual([]);
  });

  it('brings back an IL player who is no longer listed, and keeps one who still is', () => {
    const moves = ilMoves(rows, ['healed', 'still', 'star'], ['healed', 'still']);
    expect(moves.back).toEqual(['healed']);
    expect(moves.toIl).toEqual([]);
  });

  it('respects the threshold and ignores players the board does not know', () => {
    expect(ilMoves(rows, ['hurt', 'ghost'], [], 10).toIl).toEqual([]);
    expect(ilMoves(rows, ['ghost'], ['ghost']).back).toEqual([]);
  });
});
