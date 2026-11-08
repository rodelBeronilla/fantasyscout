import { describe, expect, it } from 'vitest';

import { dropFor, helpedCategories, rankValue, topAdds, type AddRow } from './pickups-top';

const row = (id: string, over: Partial<AddRow> = {}): AddRow => ({
  player_id: id,
  position: 'G',
  injury_group: null,
  games_window: 3,
  games_picked: 0,
  window_value: 1,
  fit: null,
  minutes_trend: null,
  ...over,
});

const positions: Record<string, string> = { g1: 'G', f1: 'F', c1: 'C', g2: 'G' };
const position = (id: string) => positions[id] ?? 'G';
const base = {
  available: () => true,
  needs: [] as string[],
  kept: ['z_steals', 'z_blocks', 'z_points'],
  openDays: 0,
  drops: [] as string[],
  roster: [] as string[],
  position,
};

describe('Pickups top adds (#819)', () => {
  it('ranks by window value and keeps the best three', () => {
    const rows = [row('a', { window_value: 2 }), row('b', { window_value: 5 }), row('c', { window_value: 3 }), row('d', { window_value: 4 })];
    expect(topAdds({ ...base, rows }).map((t) => t.row.player_id)).toEqual(['b', 'd', 'c']);
  });

  it('ranks by the fit in the needs once any are picked, as the table does', () => {
    const rows = [row('a', { window_value: 9, fit: 0.1 }), row('b', { window_value: 1, fit: 2 })];
    expect(topAdds({ ...base, needs: ['z_steals'], rows }).map((t) => t.row.player_id)).toEqual(['b', 'a']);
    expect(rankValue(rows[0]!, [])).toBe(9);
    expect(rankValue(rows[0]!, ['z_steals'])).toBe(0.1);
  });

  it('leaves out players on a roster, ruled out or doubtful, with no game in the window, or none on the open days', () => {
    const rows = [
      row('owned', { window_value: 9 }),
      row('out', { window_value: 8, injury_group: 'out' }),
      row('doubtful', { window_value: 7, injury_group: 'doubtful' }),
      row('idle', { window_value: 6, games_window: 0 }),
      row('no-open', { window_value: 5, games_picked: 0 }),
      row('fits', { window_value: 1, games_picked: 2, injury_group: 'questionable' }),
    ];
    const out = topAdds({ ...base, rows, openDays: 2, available: (r) => r.player_id !== 'owned' });
    expect(out.map((t) => t.row.player_id)).toEqual(['fits']);
    expect(out[0]).toMatchObject({ games: 3, openGames: 2 });
  });

  it('ranks by window value when no row has a fit (a build without the last-ten category columns)', () => {
    const rows = [row('a', { window_value: 1 }), row('b', { window_value: 3 })];
    expect(topAdds({ ...base, needs: ['z_steals'], rows }).map((t) => t.row.player_id)).toEqual(['b', 'a']);
  });

  it('a player without the ranking value is left out, and open games are null with no day picked', () => {
    const out = topAdds({ ...base, rows: [row('a', { window_value: null }), row('b')] });
    expect(out.map((t) => t.row.player_id)).toEqual(['b']);
    expect(out[0]?.openGames).toBeNull();
  });

  it('gives the reasons: games, the minutes trend, the top teammate out and the categories helped', () => {
    const r = row('a', { minutes_trend: 4.2, top_teammate_out: 'Star Player', last_10_z_steals: 0.4, last_10_z_points: 1.1, last_10_z_blocks: -0.3 });
    const [t] = topAdds({ ...base, rows: [r] });
    expect(t).toMatchObject({ games: 3, minutesTrend: 4.2, teammateOut: 'Star Player', helps: ['z_points', 'z_steals'] });
    // a swing under a minute is noise, not a reason
    const [small] = topAdds({ ...base, rows: [row('b', { minutes_trend: -0.4 })] });
    expect(small?.minutesTrend).toBeNull();
  });

  it('names the needs first among the categories helped, and never a punt or a minus', () => {
    const r = row('a', { last_10_z_steals: 0.2, last_10_z_points: 1.5, last_10_z_blocks: 0.9, last_10_z_assists: 3 });
    expect(helpedCategories(r, ['z_steals', 'z_points', 'z_blocks'], ['z_steals'])).toEqual(['z_steals', 'z_points']);
    expect(helpedCategories(row('b', { last_10_z_points: -1 }), ['z_points'], [])).toEqual([]);
  });

  it('drops the review’s first player unless that leaves a position uncovered', () => {
    const roster = ['c1', 'g1', 'f1'];
    // dropping the only center for a guard uncovers C: the next droppable player goes instead
    expect(dropFor('g2', ['c1', 'g1'], roster, position)).toBe('g1');
    expect(dropFor('g2', ['g1', 'c1'], roster, position)).toBe('g1');
    expect(dropFor('g2', ['c1'], roster, position)).toBeNull();
    const [t] = topAdds({ ...base, rows: [row('g2')], drops: ['c1', 'g1'], roster });
    expect(t?.drop).toBe('g1');
  });

  it('names no drop without the league’s rosters', () => {
    const [t] = topAdds({ ...base, rows: [row('a')] });
    expect(t?.drop).toBeNull();
  });
});
