import { describe, expect, it } from 'vitest';

import { gamesPlace, oddsText, playoffLead, playoffTargets, playoffWindow, rosterGames, type TeamWeek, weeksToPlay, windowGames, windowText } from './playoff-weeks';

const week = (team_id: string, week_start: string, week_end: string, dates: string[]): TeamWeek => ({
  team_id,
  week_start,
  week_end,
  games: dates.length,
  game_dates: dates.join(','),
});

// three weeks of a schedule: A plays 2, 3, 4 games; B plays 3, 2, 3
const rows = [
  week('A', '2027-03-22', '2027-03-28', ['2027-03-23', '2027-03-26']),
  week('B', '2027-03-22', '2027-03-28', ['2027-03-22', '2027-03-24', '2027-03-27']),
  week('A', '2027-03-29', '2027-04-04', ['2027-03-29', '2027-03-31', '2027-04-02']),
  week('B', '2027-03-29', '2027-04-04', ['2027-03-30', '2027-04-01']),
  week('A', '2027-04-05', '2027-04-11', ['2027-04-05', '2027-04-07', '2027-04-09', '2027-04-11']),
  week('B', '2027-04-05', '2027-04-11', ['2027-04-06', '2027-04-08', '2027-04-10']),
];

describe('playoffWindow (#821)', () => {
  it("takes the schedule's last weeks for a league entered by hand", () => {
    expect(playoffWindow(rows, 2)).toEqual({ from: '2027-03-29', to: '2027-04-11', periods: null });
    expect(playoffWindow(rows, 9)).toEqual({ from: '2027-03-22', to: '2027-04-11', periods: null });
    expect(playoffWindow([], 2)).toBeNull();
  });

  it("takes ESPN's playoff periods and days when the import read them", () => {
    const espn = { periods: [20, 22] as [number, number], from: '2027-03-23', to: '2027-04-11' };
    expect(playoffWindow(rows, 2, espn)).toEqual({ from: '2027-03-23', to: '2027-04-11', periods: [20, 22] });
  });
});

describe('windowGames', () => {
  const window = { from: '2027-03-29', to: '2027-04-11', periods: null };
  it("counts each team's games in the window from today", () => {
    expect(windowGames(rows, window, '2027-03-01')).toEqual(new Map([['A', 7], ['B', 5]]));
    // the playoffs under way: the games left
    expect(windowGames(rows, window, '2027-04-06')).toEqual(new Map([['A', 3], ['B', 3]]));
  });
});

describe('weeksToPlay', () => {
  it('plays a round robin over the weeks with games before the playoffs, this one included', () => {
    const window = { from: '2027-04-05', to: '2027-04-11', periods: null };
    expect(weeksToPlay(rows, window, '2027-03-24', 4)).toEqual([
      [
        [0, 3],
        [1, 2],
      ],
      [
        [1, 3],
        [2, 0],
      ],
    ]);
    expect(weeksToPlay(rows, window, '2027-04-06', 4)).toEqual([]);
  });
});

describe("the roster's games and its place", () => {
  it("sums the active players' team games and ranks the manager among the teams with a roster", () => {
    const team: Record<string, string> = { p1: 'A', p2: 'B', p3: 'A', p4: 'B', p5: 'B' };
    const games = new Map([['A', 7], ['B', 5]]);
    const rosters = [['p1', 'p2'], ['p3', 'p4', 'p5'], []];
    const per = rosterGames(rosters, ['p5'], (id) => games.get(team[id]!) ?? 0);
    expect(per).toEqual([12, 12, 0]);
    expect(gamesPlace(per, rosters, 0)).toEqual({ place: 1, of: 2 });
    expect(gamesPlace([10, 12, 14, 0], [['x'], ['y'], ['z'], ['w']], 0)).toEqual({ place: 3, of: 4 });
  });
});

describe('playoffTargets', () => {
  const board = [
    { player_id: 'star', team_id: 'B', position: 'G', injury_group: null, rank_total: 5 },
    { player_id: 'many', team_id: 'A', position: 'F', injury_group: null, rank_total: 200 },
    { player_id: 'few', team_id: 'B', position: 'F', injury_group: null, rank_total: 210 },
    { player_id: 'hurt', team_id: 'A', position: 'C', injury_group: 'out', rank_total: 220 },
    { player_id: 'mine', team_id: 'A', position: 'G', injury_group: null, rank_total: 300 },
  ];
  const games = new Map([['A', 11], ['B', 8]]);
  const perGame = (id: string) => ({ star: 3, many: 1, few: 1.2, hurt: 2, mine: 0.5 })[id] ?? 0;
  const base = { rows: board, games, perGame, owned: (id: string) => id === 'mine', pool: 156, drops: ['mine'], roster: ['mine'], position: (id: string) => board.find((r) => r.player_id === id)?.position, kept: [] };

  it("ranks free agents by value per game times the playoff weeks' games, as Pickups does", () => {
    const [top, next] = playoffTargets({ ...base, allRosters: false });
    // the star is inside the pool, so rostered somewhere; the injured player is out
    expect(top?.row.player_id).toBe('many');
    expect(top?.games).toBe(11);
    expect(top?.row.window_value).toBe(11);
    expect(next?.row.player_id).toBe('few');
    expect(top?.drop).toBeNull(); // dropping the only guard would leave G empty
  });

  it('takes every unowned player once all the rosters are in', () => {
    expect(playoffTargets({ ...base, allRosters: true })[0]?.row.player_id).toBe('star');
  });
});

describe('the lead line', () => {
  it('reads like the issue: odds, games, weeks, place', () => {
    const espn = { from: '2027-03-23', to: '2027-04-11', periods: [22, 24] as [number, number] };
    expect(playoffLead(0.62, 37, { place: 4, of: 12 }, espn)).toBe('62% to make it; 37 games in weeks 22 to 24, 4th of 12');
    expect(playoffLead(null, 1, { place: 1, of: 2 }, { ...espn, periods: [24, 24] })).toBe('1 game in week 24, 1st of 2');
    expect(windowText({ from: '2027-03-22', to: '2027-04-11', periods: null })).toBe('the playoff weeks (Mar 22 to Apr 11)');
  });

  it('keeps near-certain odds from reading as certain', () => {
    expect(oddsText(0.001)).toBe('under 1%');
    expect(oddsText(0.999)).toBe('over 99%');
    expect(oddsText(0)).toBe('0%');
    expect(oddsText(1)).toBe('100%');
  });
});
