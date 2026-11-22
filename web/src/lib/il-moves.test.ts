import { describe, expect, it } from 'vitest';

import { ilMoves, ilMovesByListing } from './il-moves';

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

describe('IL moves from the injury report alone (#927)', () => {
  const row = (player_id: string, injury_group: string | null) => ({ player_id, injury_group, injury_status: null, expected_games_missed: 9 });
  it('moves a player listed out, never one only expected to miss games, and brings back one no longer listed', () => {
    const rows = [row('out', 'out'), row('doubtful', 'doubtful'), row('questionable', 'questionable'), row('healthy', null), row('back', null), row('still', 'out')];
    const moves = ilMovesByListing(rows, ['out', 'doubtful', 'questionable', 'healthy', 'back', 'still'], ['back', 'still']);
    expect(moves.toIl).toEqual(['out']);
    expect(moves.back).toEqual(['back']);
  });

  it('offers no more moves than the IL has free slots, and none for a player back within a day (#1022)', () => {
    const out = (player_id: string, expected_return: string | null) => ({ ...row(player_id, 'out'), expected_return });
    const rows = [out('long', '2026-11-30'), out('tomorrow', '2026-11-18'), out('unknown', null), out('week', '2026-11-24'), out('on-il-a', null), out('on-il-b', null)];
    const today = '2026-11-17';
    // both IL slots full, as on the owner's team: no move at all
    const full = ilMovesByListing(rows, ['long', 'tomorrow', 'on-il-a', 'on-il-b'], ['on-il-a', 'on-il-b'], { slots: 2, today });
    expect(full.toIl).toEqual([]);
    // one free slot: the one out longest; the player due back tomorrow is never offered
    const one = ilMovesByListing(rows, ['long', 'tomorrow', 'week', 'on-il-a'], ['on-il-a'], { slots: 2, today });
    expect(one.toIl).toEqual(['long']);
    // an unknown return counts as long; two free slots take two
    const two = ilMovesByListing(rows, ['tomorrow', 'week', 'unknown'], [], { slots: 2, today });
    expect(two.toIl).toEqual(['unknown', 'week']);
    // a return date already passed, the player still listed out, is a return not known
    expect(ilMovesByListing([out('stale', '2026-11-10')], ['stale'], [], { slots: 2, today }).toIl).toEqual(['stale']);
    // a player coming off the IL frees his slot
    const freed = ilMovesByListing([...rows, row('healed', null)], ['long', 'healed', 'on-il-a'], ['healed', 'on-il-a'], { slots: 2, today });
    expect(freed).toEqual({ toIl: ['long'], back: ['healed'] });
  });
});
