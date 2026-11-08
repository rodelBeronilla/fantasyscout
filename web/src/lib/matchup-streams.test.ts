import { describe, expect, it } from 'vitest';

import { matchup, weekTotals } from './matchup';
import { flippedBy, streamMove, streamTargets, type StreamRow } from './matchup-streams';

const cats = ['z_points', 'z_steals', 'z_blocks', 'z_field_goal_pct'];
const line = (pts: number, stl: number, blk: number, fgm: number, fga: number) => ({
  proj_points_pg: pts,
  proj_steals_pg: stl,
  proj_blocks_pg: blk,
  proj_fgm_pg: fgm,
  proj_fga_pg: fga,
});
// the manager wins points by a lot, trails steals by one, is level on blocks, loses FG% a little
const mine = weekTotals([{ ...line(100, 9, 5, 40, 90), games_this_week: 1 }], cats);
const theirs = weekTotals([{ ...line(60, 10, 5, 45, 90), games_this_week: 1 }], cats);
const week = matchup(cats, mine, theirs);

const row = (id: string, over: Partial<StreamRow> = {}): StreamRow => ({ player_id: id, position: 'G', injury_group: null, ...line(10, 0.5, 0.2, 4, 9), ...over });

describe('from the matchup to the stream that flips a category (#818)', () => {
  it('targets the categories close or being lost, the closest first', () => {
    expect(week.cats.map((r) => [r.cat, r.result])).toEqual([
      ['z_points', 'win'],
      ['z_steals', 'loss'],
      ['z_blocks', 'close'],
      ['z_field_goal_pct', 'loss'],
    ]);
    expect(streamTargets(week)).toEqual(['z_blocks', 'z_steals', 'z_field_goal_pct']);
  });

  it('a swap flips a category when the add’s open-day games outweigh the drop’s started games', () => {
    // two steals a game over two open days: 9 + 4 = 13 steals against 10
    const add = { row: line(5, 2, 1, 2, 4), games: 2 };
    expect(flippedBy(week, streamTargets(week), add, null)).toEqual(['z_steals', 'z_blocks']);
    // dropping a starter who takes the same steals back out flips nothing in steals
    const drop = { row: line(5, 2, 0, 2, 4), games: 2 };
    expect(flippedBy(week, streamTargets(week), add, drop)).toEqual(['z_blocks']);
  });

  it('a percentage flips on the shots: made and attempted added to the week’s', () => {
    // 40/90 against 45/90: twenty makes on twenty attempts lift the manager to 60/110, clear of 0.5
    const add = { row: line(0, 0, 0, 20, 20), games: 1 };
    expect(flippedBy(week, ['z_field_goal_pct'], add, null)).toEqual(['z_field_goal_pct']);
  });

  it('picks the top add for the targets on the open days, with the drop and what it flips', () => {
    const rows = [
      row('mine-low', { recent_z_steals: -1, position: 'G' }),
      row('mine-c', { position: 'C' }),
      row('owned', { recent_z_steals: 9, recent_z_blocks: 9 }),
      row('thief', { recent_z_steals: 2, recent_z_blocks: 0.5, ...line(8, 2, 0.5, 3, 7) }),
      row('idle', { recent_z_steals: 5 }),
      row('hurt', { recent_z_steals: 4, injury_group: 'out' }),
    ];
    const move = streamMove({
      match: week,
      rows,
      available: (id) => !['owned', 'mine-low', 'mine-c'].includes(id),
      games: (r) => (r.player_id === 'idle' ? { window: 2, open: 0 } : { window: 3, open: 2 }),
      openDays: 2,
      kept: cats,
      drops: ['mine-low'],
      roster: ['mine-low', 'mine-c'],
      position: (id) => rows.find((r) => r.player_id === id)?.position,
      starts: () => 0,
    });
    expect(move).toMatchObject({ add: 'thief', drop: 'mine-low', games: 2, targets: ['z_blocks', 'z_steals', 'z_field_goal_pct'] });
    expect(move?.flips).toEqual(['z_steals', 'z_blocks']);
    expect(move?.helps[0]).toBe('z_steals');
  });

  it('has no move with no open day, no category to chase, or no candidate', () => {
    const base = {
      rows: [row('a', { recent_z_steals: 1 })],
      available: () => true,
      games: () => ({ window: 2, open: 1 }),
      kept: cats,
      drops: [],
      roster: [],
      position: () => 'G',
      starts: () => 0,
    };
    expect(streamMove({ ...base, match: week, openDays: 0 })).toBeNull();
    const sweep = matchup(cats, mine, weekTotals([{ ...line(1, 1, 1, 1, 10), games_this_week: 1 }], cats));
    expect(streamTargets(sweep)).toEqual([]);
    expect(streamMove({ ...base, match: sweep, openDays: 1 })).toBeNull();
    expect(streamMove({ ...base, match: week, openDays: 1, available: () => false })).toBeNull();
  });
});
