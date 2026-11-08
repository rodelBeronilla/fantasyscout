import { describe, expect, it } from 'vitest';

import { espnLeagueId, espnLeagueUrl, fromEspnLeague } from './espn-league';

// The shape of ESPN's fantasy basketball league API (views mTeam, mRoster, mSettings), trimmed.
const entry = (fullName: string, slot = 0) => ({ lineupSlotId: slot, playerPoolEntry: { player: { fullName } } });
const categories = {
  settings: {
    name: 'Hoops Club',
    size: 2,
    rosterSettings: { lineupSlotCounts: { '0': 1, '1': 1, '2': 1, '3': 1, '4': 1, '5': 1, '6': 1, '8': 1, '11': 2, '12': 3, '13': 1, '14': 0 } },
    scoringSettings: {
      scoringType: 'H2H_MOST_CATEGORIES',
      scoringItems: [0, 6, 3, 2, 1, 17, 19, 20, 11].map((statId) => ({ statId, points: 0 })),
    },
  },
  teams: [
    { id: 1, name: 'Brick City', roster: { entries: [entry('Nikola Jokić', 4), entry('Luka Dončić', 0)] } },
    { id: 2, location: 'Glass', nickname: 'Cleaners', roster: { entries: [entry('Victor Wembanyama', 12)] } },
  ],
};

describe('fromEspnLeague (#745)', () => {
  it('reads the settings: teams, spots without IR, the lineup folded into G, F, C and Util, and 9-cat head-to-head', () => {
    const l = fromEspnLeague(categories);
    expect(l.name).toBe('Hoops Club');
    expect(l.settings.teams).toBe(2);
    // 13 slots with players: 1+1+1+1+1+1+1+1+2 starters + 3 bench; IR does not take a spot
    expect(l.settings.rosterSpots).toBe(13);
    // PG, SG, G -> 3 G; SF, PF, F -> 3 F; C -> 1; G/F and two Util -> 3 Util
    expect(l.settings.lineup).toEqual({ G: 3, F: 3, C: 1, UTIL: 3 });
    expect(l.settings.format).toBe('h2h');
    expect(l.settings.scoring).toBe('cats9');
  });

  it('reads every team and roster, naming a team by its location and nickname when it has no name', () => {
    const l = fromEspnLeague(categories);
    expect(l.teams.map((t) => t.name)).toEqual(['Brick City', 'Glass Cleaners']);
    expect(l.teams[0]!.players).toEqual(['Nikola Jokić', 'Luka Dončić']);
  });

  it('knows an 8-category league (no turnovers) and a rotisserie one', () => {
    const roto = {
      ...categories,
      settings: {
        ...categories.settings,
        scoringSettings: { scoringType: 'ROTO', scoringItems: [0, 6, 3, 2, 1, 17, 19, 20].map((statId) => ({ statId, points: 0 })) },
      },
    };
    const l = fromEspnLeague(roto);
    expect(l.settings.format).toBe('roto');
    expect(l.settings.scoring).toBe('cats8');
  });

  it("reads a points league's weights", () => {
    const pts = {
      ...categories,
      settings: {
        ...categories.settings,
        scoringSettings: {
          scoringType: 'H2H_POINTS',
          scoringItems: [
            { statId: 0, points: 1 },
            { statId: 6, points: 1.2 },
            { statId: 3, points: 1.5 },
            { statId: 2, points: 3 },
            { statId: 1, points: 3 },
            { statId: 11, points: -1 },
            { statId: 13, points: 2 },
            { statId: 14, points: -1 },
          ],
        },
      },
    };
    const l = fromEspnLeague(pts);
    expect(l.settings.scoring).toBe('points');
    expect(l.settings.weights).toMatchObject({ points: 1, rebounds: 1.2, assists: 1.5, steals: 3, blocks: 3, turnovers: -1, fgm: 2, fga: -1 });
  });

  it('refuses what is not a league', () => {
    expect(() => fromEspnLeague({ messages: ['Not Found'] })).toThrow(/not an ESPN league/);
  });
});

describe("this week's score by stat (#817)", () => {
  // one matchup in the current period, each side's cumulativeScore.scoreByStat as ESPN sends it
  const scored = (home: Record<string, number>, away: Record<string, number>) => {
    const byStat = (s: Record<string, number>) => Object.fromEntries(Object.entries(s).map(([id, score]) => [id, { score, result: null, rank: 0, ineligible: false }]));
    return fromEspnLeague({
      ...categories,
      status: { currentMatchupPeriod: 1 },
      schedule: [
        { matchupPeriodId: 1, home: { teamId: 1, cumulativeScore: { wins: 0, losses: 0, ties: 0, scoreByStat: byStat(home) } }, away: { teamId: 2, cumulativeScore: { scoreByStat: byStat(away) } } },
      ],
    }).scores;
  };

  it('weighs a percentage by the attempts, or the makes, when ESPN gives only one of them', () => {
    const s = scored({ '19': 0.5, '14': 40, '20': 0.8, '15': 16 }, { '13': 10, '14': 25 });
    expect(s.get(1)!.shots).toEqual({ z_field_goal_pct: [20, 40], z_free_throw_pct: [16, 20] });
    expect(s.get(2)!.shots).toEqual({ z_field_goal_pct: [10, 25] });
  });

  it('leaves out a percentage that comes without its shots, and stats outside the categories', () => {
    const s = scored({ '0': 120, '19': 0.5, '20': 0.75, '4': 9 }, {});
    expect(s.get(1)).toEqual({ totals: { z_points: 120 }, shots: {} });
    expect(s.get(2)).toEqual({ totals: {}, shots: {} });
  });
});

describe('espnLeagueUrl (#745)', () => {
  it('asks for the teams, rosters and settings of the season the year it ends', () => {
    const url = espnLeagueUrl('123456', '2026-27');
    expect(url).toContain('/games/fba/seasons/2027/segments/0/leagues/123456');
    expect(url).toContain('view=mTeam');
    expect(url).toContain('view=mRoster');
    expect(url).toContain('view=mSettings');
    // and the schedule, for this week's opponent (#815)
    expect(url).toContain('view=mMatchupScore');
  });
});

describe('espnLeagueId (#745)', () => {
  it('takes a bare ID or the leagueId in a pasted address, and nothing else', () => {
    expect(espnLeagueId(' 123456 ')).toBe('123456');
    expect(espnLeagueId('https://fantasy.espn.com/basketball/league?leagueId=987654&seasonId=2027')).toBe('987654');
    expect(espnLeagueId('https://fantasy.espn.com/basketball/team?seasonId=2027&leagueId=42424242')).toBe('42424242');
    expect(espnLeagueId('my league')).toBeNull();
    expect(espnLeagueId('12')).toBeNull();
  });
});
