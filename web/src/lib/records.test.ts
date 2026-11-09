import { describe, expect, it } from 'vitest';

import fixture from '../../tests/fixtures/espn/league.json';
import { espnLeagueUrl, fromEspnLeague } from './espn-league';
import { DEFAULT_SETTINGS, type LeagueSetup, normalize } from './fantasy-league';
import { espnSetup } from './league-sync';
import { espnRecord, gamesBack, gamesText, recordText, standingLine, standingsOf, type TeamRecord } from './records';

const rec = (wins: number, losses: number, ties = 0, seed: number | null = null): TeamRecord => ({ wins, losses, ties, seed });
const players = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((n, i) => ({ player_id: `p${i}`, full_name: `Player ${n}` }));
const at = { leagueId: '123456', season: '2026-27', now: 1_000_000_000_000 };

describe("an ESPN team's record (#822)", () => {
  it('reads the overall wins, losses and ties and the playoff seed', () => {
    expect(espnRecord({ record: { overall: { wins: 12, losses: 6, ties: 1, percentage: 0.66 } }, playoffSeed: 2 })).toEqual(rec(12, 6, 1, 2));
    // no seed yet, ties missing
    expect(espnRecord({ record: { overall: { wins: 3, losses: 1 } }, playoffSeed: 0 })).toEqual(rec(3, 1, 0, null));
  });

  it('has none without ESPN’s record, and reads a bad number as nothing', () => {
    expect(espnRecord({ name: 'x' })).toBeNull();
    expect(espnRecord(null)).toBeNull();
    expect(espnRecord({ record: { overall: { wins: -2, losses: 'a', ties: 1 } } })).toEqual(rec(0, 0, 1, null));
  });

  it('asks ESPN for the standings with the teams', () => {
    expect(espnLeagueUrl('1', '2026-27')).toContain('view=mStandings');
  });

  it('comes in with every import and survives the stored copy', () => {
    const l = fromEspnLeague(fixture);
    expect(l.teams.map((t) => t.record && recordText(t.record))).toEqual(['10-8-1', '12-6-1', '14-4-1', '4-14-1']);
    const setup = espnSetup(l, players, at, null).setup;
    expect(setup.source?.records?.map((r) => r?.seed)).toEqual([3, 2, 1, 4]);
    const again = normalize(JSON.parse(JSON.stringify(setup)) as LeagueSetup, DEFAULT_SETTINGS.nba);
    expect(again.source?.records).toEqual(setup.source?.records);
    // a stored record that is not one is dropped, not trusted
    const bad = normalize({ ...setup, source: { ...setup.source!, records: [{ wins: 'x' }, null] as unknown as TeamRecord[] } }, DEFAULT_SETTINGS.nba);
    expect(bad.source?.records).toEqual([null, null]);
    // a league without records stores none
    const bare = { ...fixture, teams: fixture.teams.map((t) => ({ ...t, record: undefined, playoffSeed: undefined })) };
    expect(espnSetup(fromEspnLeague(bare), players, at, null).setup.source?.records).toBeUndefined();
  });
});

describe('games back', () => {
  it('is half the gap in wins plus half the gap in losses, a tie counting half', () => {
    expect(gamesBack(rec(10, 8), rec(12, 6))).toBe(2);
    expect(gamesBack(rec(10, 8), rec(11, 8))).toBe(0.5);
    expect(gamesBack(rec(10, 8, 1), rec(10, 9))).toBe(-0.5);
    expect(gamesBack(rec(12, 6), rec(12, 6))).toBe(0);
  });

  it('words a number of games', () => {
    expect(gamesText(2)).toBe('2 games');
    expect(gamesText(1)).toBe('1 game');
    expect(gamesText(0.5)).toBe('half a game');
    expect(gamesText(1.5)).toBe('1.5 games');
  });
});

describe('the standings and the line that leads My Team', () => {
  it("orders by ESPN's seeds, and words the manager's place against the team above and first", () => {
    const table = standingsOf([rec(10, 8, 1, 3), rec(12, 6, 1, 2), rec(14, 4, 1, 1), rec(4, 14, 1, 4)])!;
    expect(table.map((s) => [s.team, s.place, s.back])).toEqual([
      [2, 1, 0],
      [1, 2, 2],
      [0, 3, 4],
      [3, 4, 10],
    ]);
    expect(standingLine(table, 0)).toBe('3rd, 2 games back of 2nd and 4 games back of 1st');
    expect(standingLine(table, 1)).toBe('2nd, 2 games back of 1st');
    expect(standingLine(table, 2)).toBe('1st, 2 games ahead of 2nd');
    expect(standingLine(table, 9)).toBeNull();
  });

  it('orders by winning share without seeds, and says level for a tie in the records', () => {
    const table = standingsOf([rec(5, 5), rec(7, 3), rec(7, 3), rec(2, 8)])!;
    expect(table.map((s) => s.team)).toEqual([1, 2, 0, 3]);
    expect(standingLine(table, 1)).toBe('1st, level with 2nd');
    expect(standingLine(table, 2)).toBe('2nd, level with 1st');
    expect(standingLine(table, 0)).toBe('3rd, 2 games back of 2nd and 2 games back of 1st');
    // two teams sharing a seed: the records decide
    expect(standingsOf([rec(1, 3, 0, 1), rec(3, 1, 0, 1)])!.map((s) => s.team)).toEqual([1, 0]);
  });

  it('measures games back from the best record: the leader 0, every other team at or above it (#943)', () => {
    // a seeded Yahoo league whose 4th and 5th seeds disagree with their records
    const wl: [number, number, number][] = [
      [12, 5, 1],
      [11, 7, 0],
      [10, 7, 1],
      [10, 8, 0],
      [10, 7, 1],
      [9, 8, 1],
      [9, 9, 0],
      [8, 9, 1],
      [8, 10, 0],
      [7, 10, 1],
      [6, 12, 0],
      [5, 12, 1],
    ];
    const table = standingsOf(wl.map(([w, l, t], i) => rec(w, l, t, i + 1)))!;
    expect(table[0]).toMatchObject({ team: 0, place: 1, back: 0 });
    expect(table.map((s) => s.back)).toEqual([0, 1.5, 2, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6.5, 7]);
    // the records put 10-7-1 above 10-8; the seed breaks the tie between the two 10-7-1 teams
    expect(table.map((s) => s.team)).toEqual([0, 1, 2, 4, 3, 5, 6, 7, 8, 9, 10, 11]);
    for (const [i, s] of table.entries()) if (i > 0) expect(s.back).toBeGreaterThanOrEqual(table[i - 1]!.back);
    expect(standingLine(table, 4)).toBe('4th, level with 3rd and 2 games back of 1st');
    expect(standingLine(table, 3)).toBe('5th, half a game back of 4th and 2.5 games back of 1st');
  });

  it('never gives a team a gap below the leader, whatever the seeds say', () => {
    // the league seeds the worse record first (a division winner, say): the better record leads
    const table = standingsOf([rec(8, 10, 0, 1), rec(12, 6, 0, 2), rec(10, 8, 0, 3)])!;
    expect(table.map((s) => [s.team, s.place, s.back])).toEqual([
      [1, 1, 0],
      [2, 2, 2],
      [0, 3, 4],
    ]);
    expect(table.every((s) => s.back >= 0)).toBe(true);
    expect(standingLine(table, 1)).toBe('1st, 2 games ahead of 2nd');
  });

  it('counts a tie as half a game', () => {
    const table = standingsOf([rec(9, 8, 1), rec(10, 8, 0), rec(10, 7, 1), rec(11, 7, 0)])!;
    expect(table.map((s) => [s.team, s.back])).toEqual([
      [3, 0],
      [2, 0.5],
      [1, 1],
      [0, 1.5],
    ]);
    expect(standingLine(table, 2)).toBe('2nd, half a game back of 1st');
    // two teams level at the top both read 0, and the line says level
    const level = standingsOf([rec(10, 7, 1), rec(10, 7, 1), rec(9, 9)])!;
    expect(level.map((s) => s.back)).toEqual([0, 0, 1.5]);
    expect(standingLine(level, 1)).toBe('2nd, level with 1st');
  });

  it('has no standings before a game, or with one team', () => {
    expect(standingsOf([rec(0, 0), rec(0, 0)])).toBeNull();
    expect(standingsOf([rec(3, 1)])).toBeNull();
    expect(standingsOf(undefined)).toBeNull();
    expect(standingsOf([rec(3, 1), null, rec(1, 3)])!.map((s) => s.team)).toEqual([0, 2]);
  });
});
