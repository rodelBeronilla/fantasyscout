import { describe, expect, it } from 'vitest';

import league from '../../tests/fixtures/espn/league.json';
import scoreboard from '../../tests/fixtures/espn/scoreboard.json';
import schedule from '../../tests/fixtures/data/builds/fixture/schedule/nba.json';
import { DEFAULT_SETTINGS, normalize } from './fantasy-league';
import { espnAbbrev, fetchGamesRead, parseScoreboard, readLine, shareLeft, tonight } from './game-state';
import { readEspn, weekScore } from './league-sync';
import { applyYahooImport, parseYahooHash } from './yahoo-bookmarklet';
import { daysLeftInWeek, startsByPlayer, weekPlan } from './lineup';
import { liveWeek, weekTotals } from './matchup';
import { easternDate, type TodayGame } from './today';

const games = schedule as TodayGame[];
// 8:15 pm ET on Sunday 8 November is 01:15 UTC on the 9th
const READ = Date.parse('2026-11-09T01:15:00Z');
const SUNDAY = '2026-11-08';
const teamId = (tricode: string) => {
  const g = games.find((x) => x.game_date === SUNDAY && (x.home_team_tricode === tricode || x.away_team_tricode === tricode))!;
  return g.home_team_tricode === tricode ? g.home_team_id : g.away_team_id;
};

describe('the share of a game still to play (#875)', () => {
  it('runs from all of it at tip-off to none at the end of regulation', () => {
    expect(shareLeft(1, 720)).toBe(1);
    expect(shareLeft(1, 540)).toBeCloseTo(1 - 180 / 2880);
    expect(shareLeft(2, 0)).toBe(0.5);
    expect(shareLeft(3, 312)).toBeCloseTo(1 - (1440 + 408) / 2880);
    expect(shareLeft(4, 0)).toBe(0);
    // overtime is past regulation: nothing of it is projected
    expect(shareLeft(5, 200)).toBe(0);
  });
});

describe("ESPN's scoreboard at the read (#875)", () => {
  it('has two games final, three under way and two not started at 8:15 pm ET', () => {
    const read = parseScoreboard(scoreboard, SUNDAY, READ);
    expect(read.games).toBe(7);
    expect(read.started).toBe(5);
    expect(read.left['CHI']).toBe(0);
    expect(read.left['PHI']).toBe(0);
    // a final in overtime is in the score whole
    expect(read.left['DET']).toBe(0);
    expect(read.left['UTAH']).toBeCloseTo(1 - (1440 + 408) / 2880);
    expect(read.left['DAL']).toBe(0.5);
    expect(read.left['MIL']).toBeCloseTo(1 - 180 / 2880);
    expect(read.left['LAC']).toBeUndefined();
    expect(read.left['SAC']).toBeUndefined();
  });

  it('leaves out a game set to tip after the score was produced, whatever the scoreboard says now', () => {
    // a cached score from 7:45 pm ET, before Boston at Milwaukee's 8 pm tip-off
    const read = parseScoreboard(scoreboard, SUNDAY, Date.parse('2026-11-09T00:45:00Z'));
    expect(read.started).toBe(4);
    expect(read.left['MIL']).toBeUndefined();
  });

  it('counts nothing of a postponed game to come, and does not call it started', () => {
    const off = { events: [{ date: '2026-11-08T20:30Z', status: { type: { name: 'STATUS_POSTPONED', state: 'post', completed: false } }, competitions: [{ competitors: [{ team: { abbreviation: 'CHI' } }, { team: { abbreviation: 'PHI' } }] }] }] };
    const read = parseScoreboard(off, SUNDAY, READ);
    expect(read).toMatchObject({ games: 1, started: 0, off: ['CHI', 'PHI'] });
    const t = tonight(games, SUNDAY, read, READ);
    expect(t.left.get(teamId('CHI'))).toBe(0);
    expect(t.started).toBe(0);
  });

  it('reads nothing from a scoreboard that does not answer', async () => {
    const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    await expect(fetchGamesRead(SUNDAY, READ, down)).resolves.toBeNull();
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(fetchGamesRead(SUNDAY, READ, offline)).resolves.toBeNull();
  });
});

describe("today's games as the rest of the week counts them (#875)", () => {
  const read = parseScoreboard(scoreboard, SUNDAY, READ);

  it("matches ESPN's abbreviations to the schedule's tricodes", () => {
    expect(['GSW', 'NOP', 'SAS', 'UTA', 'NYK', 'WAS', 'BOS'].map(espnAbbrev)).toEqual(['GS', 'NO', 'SA', 'UTAH', 'NY', 'WSH', 'BOS']);
    const t = tonight(games, SUNDAY, read, READ);
    expect(t).toMatchObject({ games: 7, started: 5, byClock: false, at: READ });
    // Utah (UTA, ESPN's UTAH) is in the third quarter; New Orleans (NOP, ESPN's NO) has not tipped
    expect(t.left.get(teamId('UTA'))).toBeCloseTo(1 - (1440 + 408) / 2880);
    expect(t.left.get(teamId('NOP'))).toBe(1);
    expect(t.left.get(teamId('PHI'))).toBe(0);
  });

  it("takes the Eastern date, not UTC's, across midnight UTC", () => {
    // 01:15 UTC on the 9th is still the 8th in the East, where the schedule and ESPN date the games
    expect(easternDate(new Date(READ))).toBe(SUNDAY);
    expect(new Date(READ).toISOString().slice(0, 10)).toBe('2026-11-09');
    expect(tonight(games, easternDate(new Date(READ)), read, READ).games).toBe(7);
  });

  it("goes by the tip-off times when the scoreboard was not read, or was read for another day", () => {
    const byClock = tonight(games, SUNDAY, undefined, READ);
    expect(byClock).toMatchObject({ games: 7, started: 5, byClock: true, at: READ });
    expect(byClock.left.get(teamId('UTA'))).toBe(0);
    expect(byClock.left.get(teamId('NOP'))).toBe(1);
    // a read from Sunday night says nothing of Monday's games: by Monday's clock none had tipped at it
    const monday = tonight(games, '2026-11-09', read, READ);
    expect(monday).toMatchObject({ games: 8, started: 0, byClock: true });
  });

  it('says when the score was read and how many of the games it held', () => {
    const t = tonight(games, SUNDAY, read, READ);
    expect(readLine(t)).toBe(
      "Score so far from ESPN at 20:15 ET, with 5 of today's 7 games started: the score holds what they have played, so the games left count only the rest.",
    );
    expect(readLine({ ...t, started: 0 })).toBe("Score so far from ESPN at 20:15 ET, before today's 7 games: the games left count all of today.");
    expect(readLine({ ...t, started: 7 })).toContain("with all 7 of today's games started");
    expect(readLine({ ...t, byClock: true })).toContain("(by the tip-off times: ESPN's scoreboard did not answer)");
    expect(readLine({ ...t, games: 0, started: 0 })).toBe('Score so far from ESPN at 20:15 ET; no games today.');
  });
});

describe('a sync after tip-off counts no started game twice (#875)', () => {
  // Wednesday 4 November: Atlanta's 7 pm ET game is final at a 9:30 pm read, Chicago's 10 pm one is to come
  const wed = '2026-11-04';
  const day: TodayGame[] = [
    { game_date: wed, game_datetime_utc: '2026-11-05T00:00:00Z', home_team_id: 'B', away_team_id: 'A', home_team_tricode: 'BBB', away_team_tricode: 'ATL' },
    { game_date: wed, game_datetime_utc: '2026-11-05T03:00:00Z', home_team_id: 'D', away_team_id: 'C', home_team_tricode: 'DDD', away_team_tricode: 'CHI' },
    { game_date: '2026-11-06', game_datetime_utc: '2026-11-07T00:00:00Z', home_team_id: 'A', away_team_id: 'E', home_team_tricode: 'ATL', away_team_tricode: 'EEE' },
  ];
  const read = Date.parse('2026-11-05T02:30:00Z');
  const board = { events: [
    { date: '2026-11-05T00:00Z', status: { period: 4, clock: 0, type: { state: 'post', completed: true } }, competitions: [{ competitors: [{ team: { abbreviation: 'BBB' } }, { team: { abbreviation: 'ATL' } }] }] },
    { date: '2026-11-05T03:00Z', status: { period: 0, clock: 0, type: { state: 'pre', completed: false } }, competitions: [{ competitors: [{ team: { abbreviation: 'DDD' } }, { team: { abbreviation: 'CHI' } }] }] },
  ] };
  const rows = [
    { player_id: 'a1', team_id: 'A', position: 'G', proj_points_pg: 20 },
    { player_id: 'c1', team_id: 'C', position: 'F', proj_points_pg: 10 },
  ];
  const team = new Map(rows.map((r) => [r.player_id, r.team_id]));

  const projectedFinal = (games: ReturnType<typeof tonight>) => {
    const dates = daysLeftInWeek(wed);
    const plays = (id: string, date: string) => day.some((g) => g.game_date === date && [g.home_team_id, g.away_team_id].includes(team.get(id)!));
    const plan = weekPlan(rows.map((r) => ({ id: r.player_id, position: r.position, value: r.proj_points_pg })), dates, plays, ['G', 'F', 'UTIL']);
    const starts = startsByPlayer(plan, (id, date) => (date === wed ? (games.left.get(team.get(id)!) ?? 1) : 1));
    const rest = weekTotals(rows, ['z_points'], undefined, (r) => starts.get(String(r['player_id'])) ?? 0);
    // the score so far already has a1's 30 points from tonight's final
    const soFar = { totals: { z_points: 30 }, shots: {} };
    return { starts, final: liveWeek(['z_points'], { mine: soFar, theirs: soFar }, { mine: rest, theirs: rest }).mine };
  };

  it("drops tonight's final from the games left and keeps the game still to tip", () => {
    const { starts, final } = projectedFinal(tonight(day, wed, parseScoreboard(board, wed, read), read));
    expect(starts.get('a1')).toBe(1); // Friday only
    expect(starts.get('c1')).toBe(1); // tonight's 10 pm game
    expect(final.cats['z_points']).toBe(30 + 20 + 10);
    expect(final.games).toBe(2);
  });

  it('counted the final twice before (the score plus all of today)', () => {
    const none = { left: new Map<string, number>(), games: 0, started: 0, byClock: true, at: read };
    expect(projectedFinal(none).final.cats['z_points']).toBe(30 + 20 * 2 + 10);
  });

  it('holds across midnight UTC: an 11:30 pm ET read on the 4th is the 5th in UTC', () => {
    const late = Date.parse('2026-11-05T04:30:00Z');
    expect(easternDate(new Date(late))).toBe(wed);
    const lateBoard = { events: board.events.map((e, i) => (i === 1 ? { ...e, status: { period: 2, clock: 0, type: { state: 'in', completed: false } } } : e)) };
    const { starts, final } = projectedFinal(tonight(day, easternDate(new Date(late)), parseScoreboard(lateBoard, wed, late), late));
    expect(starts.get('c1')).toBe(0.5); // at halftime: half of it is in the score
    expect(final.cats['z_points']).toBe(30 + 20 + 5);
  });
});

describe('the scoreboard is read with the league, for the Eastern day (#875)', () => {
  it('asks for the Eastern date at 01:15 UTC, and keeps the time ESPN produced the score', async () => {
    const asked: string[] = [];
    const served = 'Mon, 09 Nov 2026 01:13:00 GMT';
    const get = (async (url: string) => {
      asked.push(url);
      return url.includes('scoreboard') ? Response.json(scoreboard) : Response.json(league, { headers: { 'x-fantasy-server-time': served } });
    }) as unknown as typeof fetch;
    const { games } = await readEspn('123456', '2026-27', READ, get);
    expect(asked[1]).toBe('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261108');
    expect(games).toMatchObject({ date: SUNDAY, scoreAt: Date.parse(served), games: 7, started: 5 });
  });

  it('reads no scoreboard for a WNBA season', async () => {
    const asked: string[] = [];
    const get = (async (url: string) => {
      asked.push(url);
      return Response.json(league);
    }) as unknown as typeof fetch;
    expect((await readEspn('123456', '2026', READ, get)).games).toBeNull();
    expect(asked).toHaveLength(1);
  });

  it('keeps a stored read, and drops a malformed one', () => {
    const games = parseScoreboard(scoreboard, SUNDAY, READ);
    const source = { host: 'espn' as const, leagueId: '1', syncedAt: READ, rosters: [], changes: null };
    expect(normalize({ source: { ...source, games } }, DEFAULT_SETTINGS.nba).source?.games).toEqual(games);
    const bad = { ...games, left: { CHI: 2 } };
    expect(normalize({ source: { ...source, games: bad } } as never, DEFAULT_SETTINGS.nba).source?.games).toBeUndefined();
  });
});

describe('a Yahoo score read on an evening with games under way goes by the tip-off times (#874, #875)', () => {
  // the Yahoo bookmark ran at 8:15 pm ET on Sunday 8 November: five of the seven games had tipped
  const labels = ['Team', 'FGM/A*', 'FG%', 'FTM/A*', 'FT%', '3PTM', 'PTS', 'REB', 'AST', 'ST', 'BLK', 'TO', ''];
  const row = (name: string, pts: string) => [name, '172/369', '.466', '112/159', '.704', '35', pts, '202', '111', '31', '24', '57', '4'];
  const payload = {
    v: 3,
    leagueId: '12345',
    mine: 1,
    teams: [1, 2, 3, 4].map((id) => ({ id, name: `Team ${id}`, players: [] })),
    matchup: { labels, rows: [{ id: 1, cells: row('Team 1', '491') }, { id: 2, cells: row('Team 2', '579') }] },
  };
  const parsed = parseYahooHash(`#yahoo=${encodeURIComponent(JSON.stringify(payload))}`)!;
  const setup = applyYahooImport(normalize({ teams: 4, format: 'h2h' }, DEFAULT_SETTINGS.nba), parsed, [], READ).setup;

  it('starts from the score with no scoreboard read, so the games tipped by the read count as in it', () => {
    expect(setup.source?.host).toBe('yahoo');
    expect(setup.source?.games).toBeUndefined();
    expect(weekScore(setup, SUNDAY, (ms) => easternDate(new Date(ms)))).toMatchObject({ mine: { totals: { z_points: 491 } } });
    const t = tonight(games, SUNDAY, setup.source?.games, setup.source!.syncedAt);
    expect(t).toMatchObject({ games: 7, started: 5, byClock: true, at: READ });
    // Utah tipped at 7 pm ET: none of its game is left to count; New Orleans tips at 9 pm: all of it is
    expect(t.left.get(teamId('UTA'))).toBe(0);
    expect(t.left.get(teamId('NOP'))).toBe(1);
  });

  it('names Yahoo and the read time on the score line', () => {
    const t = tonight(games, SUNDAY, setup.source?.games, setup.source!.syncedAt);
    expect(readLine(t, setup.source?.host)).toBe(
      "Score so far from Yahoo at 20:15 ET, with 5 of today's 7 games started (by the tip-off times: Yahoo sends no game states): the score holds what they have played, so the games left count only the rest.",
    );
    expect(readLine(t)).toContain('Score so far from ESPN at 20:15 ET');
  });
});
