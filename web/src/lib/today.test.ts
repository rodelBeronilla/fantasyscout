import { describe, expect, it } from 'vitest';

import { easternDate, sitsOut, todayGroups, todayVerdict } from './today';

const games = [
  { game_date: '2026-11-02', game_datetime_utc: '2026-11-03T00:30:00Z', home_team_id: 'BOS', away_team_id: 'NYK', home_team_tricode: 'BOS', away_team_tricode: 'NYK' },
  { game_date: '2026-11-02', game_datetime_utc: '2026-11-02T23:00:00Z', home_team_id: 'ORL', away_team_id: 'MIA', home_team_tricode: 'ORL', away_team_tricode: 'MIA' },
  { game_date: '2026-11-03', game_datetime_utc: '2026-11-04T00:00:00Z', home_team_id: 'LAL', away_team_id: 'DEN', home_team_tricode: 'LAL', away_team_tricode: 'DEN' },
];

describe('the game day', () => {
  it('splits the active players into plays, listed and no game, earliest tip-off first', () => {
    const players = [
      { player_id: 'a', team_id: 'BOS', injury_group: null },
      { player_id: 'b', team_id: 'MIA', injury_group: 'probable' },
      { player_id: 'c', team_id: 'NYK', injury_group: 'questionable' },
      { player_id: 'd', team_id: 'LAL', injury_group: null }, // plays tomorrow
      { player_id: 'e', team_id: null, injury_group: null }, // a free agent
      { player_id: 'f', team_id: 'ORL', injury_group: 'out' },
    ];
    const out = todayGroups(players, games, '2026-11-02');
    expect(out.leagueGames).toBe(2);
    expect(out.plays.map((s) => [s.player.player_id, s.opponent, s.home])).toEqual([
      ['b', 'ORL', false], // 23:00 UTC
      ['a', 'NYK', true], // 00:30 UTC the next day
    ]);
    expect(out.listed.map((s) => s.player.player_id)).toEqual(['f', 'c']);
    expect(out.idle.map((s) => s.player.player_id)).toEqual(['d', 'e']);
  });

  it('reads today in Eastern time, whatever the viewer\'s clock', () => {
    // 03:30 UTC on Nov 3 is still the evening of Nov 2 in New York
    expect(easternDate(new Date('2026-11-03T03:30:00Z'))).toBe('2026-11-02');
    expect(easternDate(new Date('2026-11-03T06:00:00Z'))).toBe('2026-11-03');
  });

  it('starts the best lineup the slots hold, never an out or doubtful player, and says when to check a listed starter', () => {
    const players = [
      { player_id: 'a', team_id: 'BOS', injury_group: null }, // G, best
      { player_id: 'b', team_id: 'MIA', injury_group: null }, // G, second
      { player_id: 'c', team_id: 'NYK', injury_group: 'questionable' }, // C, starts with a check
      { player_id: 'g', team_id: 'ORL', injury_group: null }, // G, third: no guard slot left
      { player_id: 'h', team_id: 'MIA', injury_group: 'doubtful' },
      { player_id: 'f', team_id: 'ORL', injury_group: 'out' },
    ];
    const pos: Record<string, string> = { a: 'G', b: 'G', c: 'C', g: 'G', h: 'F', f: 'F' };
    const value: Record<string, number> = { a: 5, b: 4, c: 3, g: 1, h: 6, f: 9 };
    const v = todayVerdict(todayGroups(players, games, '2026-11-02'), ['G', 'G', 'C'], (id) => value[id] ?? 0, (id) => pos[id]);
    expect(v.start.map((r) => [r.id, r.slot]).sort()).toEqual([['a', 'G'], ['b', 'G'], ['c', 'C']]);
    // the questionable center: check half an hour before his 00:30 UTC tip-off
    expect(v.start.find((r) => r.id === 'c')?.checkBy).toBe('2026-11-03T00:00:00.000Z');
    expect(v.start.find((r) => r.id === 'a')?.checkBy).toBeNull();
    expect(v.bench.map((r) => r.id)).toEqual(['g']);
    expect(v.check.map((r) => r.id)).toEqual(['h']);
    expect(v.out.map((r) => r.id)).toEqual(['f']);
    expect(v.open).toEqual([]);
  });

  it("sends a player his team lists inactive today to Out, though the report misses him, and fills his slot (#878)", () => {
    const players = [
      { player_id: 'a', team_id: 'BOS', injury_group: null, lineup_role: 'inactive', lineup_date: '2026-11-02' }, // G, best: G League stint
      { player_id: 'b', team_id: 'MIA', injury_group: null, lineup_role: 'starter', lineup_date: '2026-11-02' }, // G
      { player_id: 'g', team_id: 'ORL', injury_group: null }, // G, third: takes the slot
      { player_id: 'c', team_id: 'NYK', injury_group: 'questionable', lineup_role: 'inactive', lineup_date: '2026-11-02' }, // C: scratched
      { player_id: 'x', team_id: 'NYK', injury_group: null, lineup_role: 'inactive', lineup_date: '2026-11-01' }, // C: yesterday's lineup
      { player_id: 'f', team_id: 'ORL', injury_group: 'out', lineup_role: 'inactive', lineup_date: '2026-11-02' }, // F: out on both
    ];
    const pos: Record<string, string> = { a: 'G', b: 'G', g: 'G', c: 'C', x: 'C', f: 'F' };
    const value: Record<string, number> = { a: 9, b: 4, g: 1, c: 8, x: 2, f: 9 };
    const groups = todayGroups(players, games, '2026-11-02');
    expect(groups.plays.map((s) => s.player.player_id).sort()).toEqual(['b', 'g', 'x']);
    expect(groups.listed.map((s) => s.player.player_id).sort()).toEqual(['a', 'c', 'f']);
    const v = todayVerdict(groups, ['G', 'G', 'C'], (id) => value[id] ?? 0, (id) => pos[id]);
    expect(v.start.map((r) => [r.id, r.slot]).sort()).toEqual([['b', 'G'], ['g', 'G'], ['x', 'C']]);
    expect(v.out.map((r) => [r.id, r.inactive]).sort()).toEqual([['a', true], ['c', true], ['f', false]]);
    expect(v.out.every((r) => r.checkBy === null)).toBe(true);
    expect(v.check).toEqual([]);
    expect(v.bench).toEqual([]);
  });

  it('keeps an inactive player out of the day in the week plan too', () => {
    const p = { player_id: 'a', team_id: 'BOS', injury_group: null, lineup_role: 'inactive', lineup_date: '2026-11-02' };
    expect(sitsOut(p, '2026-11-02')).toBe(true);
    expect(sitsOut(p, '2026-11-03')).toBe(false);
    expect(sitsOut({ ...p, lineup_role: 'bench' }, '2026-11-02')).toBe(false);
    expect(sitsOut({ ...p, lineup_role: null, injury_group: 'doubtful' }, '2026-11-03')).toBe(true);
  });
});
