import { describe, expect, it, vi } from 'vitest';

import fixture from '../../tests/fixtures/espn/league.json';
import { fromEspnLeague } from './espn-league';
import { DEFAULT_SETTINGS, type LeagueSetup, normalize } from './fantasy-league';
import {
  ago,
  chooseMine,
  espnSetup,
  espnSyncLine,
  fetchEspnLeague,
  hasManualEdits,
  rosterChanges,
  weeksCovered,
  SYNC_EVERY_MS,
  syncDue,
  weekScore,
  YAHOO_STALE_MS,
  yahooSource,
  yahooStale,
} from './league-sync';

const players = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((n, i) => ({ player_id: `p${i}`, full_name: `Player ${n}` }));
const at = { leagueId: '123456', season: '2026-27', now: 1_000_000_000_000 };
const MIN = 60_000;

/** The fixture league as a first import, the manager's team picked as `mine`. */
function imported(mine = 0): LeagueSetup {
  return chooseMine(espnSetup(fromEspnLeague(fixture), players, at, null).setup, mine);
}

describe("this week's opponent from ESPN's schedule (#815)", () => {
  it('pairs each team with the one it faces in the current matchup period, both ways', () => {
    const l = fromEspnLeague(fixture);
    // period 2: team 3 hosts team 1, team 2 hosts team 4
    expect([...l.opponents.entries()].sort()).toEqual([
      [1, 3],
      [2, 4],
      [3, 1],
      [4, 2],
    ]);
  });

  it("finds the period from today's scoring period when ESPN names no current one", () => {
    const l = fromEspnLeague({ ...fixture, status: {}, scoringPeriodId: 16 });
    expect(l.opponents.get(1)).toBe(4);
  });

  it('has no opponent on a bye or without a schedule', () => {
    const bye = { ...fixture, schedule: fixture.schedule.map((m) => (m.matchupPeriodId === 2 && m.home.teamId === 3 ? { ...m, away: undefined } : m)) };
    expect(fromEspnLeague(bye).opponents.has(1)).toBe(false);
    expect(fromEspnLeague({ ...fixture, schedule: undefined }).opponents.size).toBe(0);
  });

  it("sets the manager's opponent on import, and again when they pick their team", () => {
    const first = espnSetup(fromEspnLeague(fixture), players, at, null).setup;
    expect(first.mine).toBe(0);
    expect(first.opponent).toBe(2);
    expect(first.source?.opponents).toEqual([2, 3, 0, 1]);
    expect(chooseMine(first, 1).opponent).toBe(3);
  });
});

describe('a re-import (#815)', () => {
  it('counts the roster adds and drops against the stored copy and keeps the manager’s own choices', () => {
    const stored = imported(1);
    // since then: team 1 dropped Player Six for Player Five; the manager punts points and moved the opponent
    const changed = { ...fixture, teams: fixture.teams.map((t) => (t.id === 1 ? { ...t, roster: { entries: [...t.roster.entries.slice(0, 2), { lineupSlotId: 12, playerPoolEntry: { player: { fullName: 'Player Five' } } }] } } : t)) };
    const result = espnSetup(fromEspnLeague(changed), players, { ...at, now: at.now + 20 * MIN }, { ...stored, punts: ['z_points'] });
    expect(result.changes).toBe(2);
    expect(result.setup.source?.changes).toBe(2);
    expect(result.setup.source?.syncedAt).toBe(at.now + 20 * MIN);
    expect(result.setup.rosters[0]).toEqual(['p0', 'p1', 'p5']);
    expect(result.setup.mine).toBe(1);
    expect(result.setup.opponent).toBe(3);
    expect(result.setup.punts).toEqual(['z_points']);
    expect(hasManualEdits(result.setup)).toBe(false);
  });

  it('follows the manager’s team by its ESPN id when ESPN lists the teams in another order', () => {
    const stored = imported(1);
    const result = espnSetup(fromEspnLeague({ ...fixture, teams: [...fixture.teams].reverse() }), players, at, stored);
    expect(result.setup.names[result.setup.mine]).toBe('Glass Cleaners');
    expect(result.setup.names[result.setup.opponent!]).toBe('Fourth');
    // the same rosters under other places: nothing changed
    expect(result.changes).toBe(0);
  });

  it("puts ESPN's IR slot on the injured list each sync, and takes a player off once ESPN activates him (#878)", () => {
    // Brick City moves Player One to IR (slot 13)
    const slot = (one: number) => ({ ...fixture, teams: fixture.teams.map((t) => (t.id === 1 ? { ...t, roster: { entries: t.roster.entries.map((e, i) => (i === 1 ? { ...e, lineupSlotId: one } : e)) } } : t)) });
    const first = espnSetup(fromEspnLeague(slot(13)), players, at, null).setup;
    expect(first.il).toEqual(['p1']);
    expect(first.source?.ir).toEqual(['p1']);
    // the manager also puts Player Two on the list by hand; the next sync keeps both
    const marked = { ...first, il: [...first.il, 'p2'] };
    const again = espnSetup(fromEspnLeague(slot(13)), players, { ...at, now: at.now + 20 * MIN }, marked).setup;
    expect(again.il.sort()).toEqual(['p1', 'p2']);
    // ESPN activates Player One: he leaves the list, the manager's own entry stays
    const back = espnSetup(fromEspnLeague(slot(0)), players, { ...at, now: at.now + 40 * MIN }, again).setup;
    expect(back.il).toEqual(['p2']);
    expect(back.source?.ir).toEqual([]);
    // a stored copy keeps the IR list through a reload
    expect(normalize(first, DEFAULT_SETTINGS.nba).source?.ir).toEqual(['p1']);
  });

  it('counts a trade on both sides, and a first import as no count', () => {
    expect(rosterChanges([['a', 'b'], ['c']], [['a', 'c'], ['b']])).toBe(4);
    expect(rosterChanges([['a']], [['a']])).toBe(0);
    expect(espnSetup(fromEspnLeague(fixture), players, at, null).changes).toBeNull();
  });
});

describe('when a visit re-imports (#815)', () => {
  it('waits a quarter hour after the last sync', () => {
    const s = imported();
    expect(syncDue(s, at.now)).toBe('fresh');
    expect(syncDue(s, at.now + 14 * MIN)).toBe('fresh');
    expect(syncDue(s, at.now + SYNC_EVERY_MS)).toBe('due');
    expect(SYNC_EVERY_MS).toBe(15 * MIN);
  });

  it('never replaces rosters edited by hand since the import', () => {
    const s = imported();
    const edited = { ...s, rosters: s.rosters.map((r, i) => (i === 0 ? [...r, 'p5'] : r)) };
    expect(hasManualEdits(edited)).toBe(true);
    expect(syncDue(edited, at.now + 60 * MIN)).toBe('edited');
    // the same players in another order are not an edit; picking a team or an opponent is not either
    expect(hasManualEdits({ ...s, rosters: s.rosters.map((r) => [...r].reverse()), mine: 2, opponent: 1 })).toBe(false);
  });

  it('leaves a league entered by hand, or from Yahoo, alone', () => {
    const plain = normalize({ teams: 4 }, DEFAULT_SETTINGS.nba);
    expect(syncDue(plain, at.now)).toBe('none');
    expect(syncDue({ ...plain, source: yahooSource('99', plain.rosters, 0) }, at.now)).toBe('none');
  });

  it('keeps the source through the stored shape', () => {
    const s = imported();
    const again = normalize(JSON.parse(JSON.stringify(s)) as LeagueSetup, DEFAULT_SETTINGS.nba);
    expect(again.source).toEqual(s.source);
  });
});

describe("this week's score so far from ESPN (#817)", () => {
  const day = (ms: number) => (ms < at.now + 12 * 60 * MIN ? '2026-11-05' : '2026-11-06');

  it('reads each side of the current matchup period, stat by stat, into the categories and the shots', () => {
    const l = fromEspnLeague(fixture);
    expect([...l.scores.keys()].sort()).toEqual([1, 2, 3, 4]);
    const brick = l.scores.get(1)!;
    expect(brick.totals).toEqual({
      z_points: 1000,
      z_rebounds_total: 300,
      z_assists: 200,
      z_steals: 40,
      z_blocks: 30,
      z_three_pointers_made: 80,
      z_turnovers: 50,
    });
    expect(brick.shots).toEqual({ z_field_goal_pct: [380, 800], z_free_throw_pct: [160, 200] });
  });

  it('stores the scores by team, in the league order, and keeps them through the stored shape', () => {
    const s = imported();
    expect(s.source?.scores?.map((x) => x?.totals['z_points'])).toEqual([1000, 410, 100, 395]);
    const again = normalize(JSON.parse(JSON.stringify(s)) as LeagueSetup, DEFAULT_SETTINGS.nba);
    expect(again.source?.scores).toEqual(s.source?.scores);
  });

  it("gives the manager's and the opponent's score when the league was read today, and says why not otherwise", () => {
    const s = imported();
    const score = weekScore(s, '2026-11-05', day);
    expect(typeof score === 'object' && [score.mine.totals['z_steals'], score.theirs.totals['z_steals']]).toEqual([40, 5]);
    // synced yesterday: the days since are missing from it
    expect(weekScore(s, '2026-11-06', day)).toBe('stale');
    // a team on a bye, or no opponent picked
    expect(weekScore({ ...s, source: { ...s.source!, scores: [s.source!.scores![0]!, null, null, null] } }, '2026-11-05', day)).toBe('no-score');
    expect(weekScore({ ...s, opponent: null }, '2026-11-05', day)).toBe('no-score');
    // a league entered by hand or from Yahoo
    expect(weekScore(normalize({ teams: 4 }, DEFAULT_SETTINGS.nba), '2026-11-05', day)).toBe('not-espn');
  });

  it("reads a points league's fantasy points so far, the live total when ESPN gives one (#877), and no score without a schedule", () => {
    // a points league's sides carry their fantasy points in totalPoints, and no score by stat
    const sides = (m: (typeof fixture.schedule)[number], home: number, away: number, live?: number) => ({
      ...m,
      home: { teamId: m.home.teamId, totalPoints: home },
      away: { teamId: m.away.teamId, totalPoints: away, ...(live === undefined ? {} : { totalPointsLive: live }) },
    });
    const points = {
      ...fixture,
      settings: { ...fixture.settings, scoringSettings: { ...fixture.settings.scoringSettings, scoringType: 'H2H_POINTS' } },
      schedule: fixture.schedule.map((m) => (m.matchupPeriodId !== 2 ? m : m.home.teamId === 3 ? sides(m, 388.5, 412, 430.5) : sides(m, 301, 0))),
    };
    const l = fromEspnLeague(points);
    expect(Object.fromEntries([...l.scores].map(([id, s]) => [id, s.totals]))).toEqual({ 1: { fpts: 430.5 }, 2: { fpts: 301 }, 3: { fpts: 388.5 }, 4: { fpts: 0 } });
    expect(l.scores.get(1)?.shots).toEqual({});
    const s = espnSetup(l, players, at, null).setup;
    expect(s.source?.scores?.map((x) => x?.totals['fpts'])).toEqual([430.5, 301, 388.5, 0]);
    // it keeps through the stored shape
    expect(normalize(JSON.parse(JSON.stringify(s)) as LeagueSetup, DEFAULT_SETTINGS.nba).source?.scores).toEqual(s.source?.scores);
    expect(fromEspnLeague({ ...fixture, schedule: undefined }).scores.size).toBe(0);
    expect(fromEspnLeague({ ...points, schedule: undefined }).scores.size).toBe(0);
  });
});

describe('fetchEspnLeague (#815)', () => {
  it('reads the league, schedule included, and says what to do about a private one', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const l = await fetchEspnLeague('123456', '2026-27', ok as unknown as typeof fetch);
    expect(String((ok.mock.calls[0] as unknown[])[0])).toContain('view=mMatchupScore');
    expect(l.opponents.get(1)).toBe(3);
    const denied = vi.fn(async () => new Response('{}', { status: 401 }));
    await expect(fetchEspnLeague('1', '2026-27', denied as unknown as typeof fetch)).rejects.toThrow(/Make League Viewable to Public/);
  });
});

describe('the synced line (#815)', () => {
  it('says how long ago and how many roster changes', () => {
    const s = imported().source!;
    expect(espnSyncLine(s, at.now + 4 * MIN)).toBe('Synced 4 min ago');
    expect(espnSyncLine({ ...s, changes: 2 }, at.now + 4 * MIN)).toBe('Synced 4 min ago · 2 roster changes since your last visit');
    expect(espnSyncLine({ ...s, changes: 1 }, at.now)).toBe('Synced just now · 1 roster change since your last visit');
    expect(espnSyncLine({ ...s, changes: 0 }, at.now)).toBe('Synced just now · no roster changes since your last visit');
  });

  it('words an age in minutes, hours or days', () => {
    expect(ago(0, 30_000)).toBe('just now');
    expect(ago(0, 59 * MIN)).toBe('59 min ago');
    expect(ago(0, 60 * MIN)).toBe('1 hour ago');
    expect(ago(0, 5 * 60 * MIN)).toBe('5 hours ago');
    expect(ago(0, 3 * 24 * 60 * MIN)).toBe('3 days ago');
  });

  it('offers a Yahoo re-sync once the copy is a day old', () => {
    const y = yahooSource('99', [], at.now);
    expect(yahooStale(y, at.now + YAHOO_STALE_MS - 1)).toBe(false);
    expect(yahooStale(y, at.now + YAHOO_STALE_MS)).toBe(true);
  });
});

describe("the playoffs from ESPN's settings and schedule (#821)", () => {
  it('reads the playoff field, its periods and days, the matchups left and how the records count them', () => {
    const l = fromEspnLeague(fixture);
    // two teams make it: one round of one period, after the regular season's three
    expect(l.playoffs).toEqual({ teams: 2, periods: [4, 4], days: [22, 28] });
    expect(l.today).toBe(9);
    // from the current period (2) to the regular season's last (3)
    expect(l.fixtures).toEqual([
      { period: 2, home: 3, away: 1 },
      { period: 2, home: 2, away: 4 },
      { period: 3, home: 1, away: 4 },
      { period: 3, home: 2, away: 3 },
    ]);
    expect(l.tally).toBe('matchups');
    const each = { ...fixture, settings: { ...fixture.settings, scoringSettings: { ...fixture.settings.scoringSettings, scoringType: 'H2H_CATEGORY' } } };
    expect(fromEspnLeague(each).tally).toBe('categories');
  });

  it('has no playoffs without the regular season or the field', () => {
    const settings = { ...fixture.settings, scheduleSettings: { matchupPeriods: fixture.settings.scheduleSettings.matchupPeriods } };
    expect(fromEspnLeague({ ...fixture, settings }).playoffs).toBeNull();
    expect(fromEspnLeague({ ...fixture, settings }).fixtures).toEqual([]);
  });

  it('runs six teams over three rounds, the top two on a bye', () => {
    const scheduleSettings = { matchupPeriodCount: 19, playoffTeamCount: 6, playoffMatchupPeriodLength: 1 };
    const l = fromEspnLeague({ ...fixture, settings: { ...fixture.settings, size: 12, scheduleSettings } });
    expect(l.playoffs).toEqual({ teams: 6, periods: [20, 22], days: null });
  });

  it("stores the playoff weeks as dates, the matchups as team indexes, and sets the league's playoffs", () => {
    const s = espnSetup(fromEspnLeague(fixture), players, at, null).setup;
    // at.now is the evening of 2001-09-08 in the East, scoring period 9: periods 22 to 28 are 13 to 19 days on
    expect(s.source?.playoffWeeks).toEqual({ periods: [4, 4], from: '2001-09-21', to: '2001-09-27' });
    expect(s.source?.fixtures).toEqual([
      [
        [2, 0],
        [1, 3],
      ],
      [
        [0, 3],
        [1, 2],
      ],
    ]);
    expect(s.source?.tally).toBe('matchups');
    // a Friday to a Thursday spans two Monday-to-Sunday weeks
    expect(s.playoffs).toEqual({ teams: 2, weeks: 2, start: '2001-09-17' });
    const again = normalize(JSON.parse(JSON.stringify(s)) as LeagueSetup, DEFAULT_SETTINGS.nba);
    expect(again.source?.playoffWeeks).toEqual(s.source?.playoffWeeks);
    expect(again.source?.fixtures).toEqual(s.source?.fixtures);
  });

  it('counts the Monday-to-Sunday weeks two dates span', () => {
    expect(weeksCovered('2027-03-22', '2027-04-11')).toBe(3);
    expect(weeksCovered('2027-03-28', '2027-03-29')).toBe(2);
    expect(weeksCovered('2027-03-23', '2027-03-23')).toBe(1);
  });

  it("keeps the manager's playoffs when ESPN gives none", () => {
    const plain = { ...fixture, settings: { ...fixture.settings, scheduleSettings: {} } };
    const previous = { ...imported(), playoffs: { teams: 3, weeks: 2, start: '2027-03-15' } };
    expect(espnSetup(fromEspnLeague(plain), players, at, previous).setup.playoffs).toEqual({ teams: 3, weeks: 2, start: '2027-03-15' });
  });
});
