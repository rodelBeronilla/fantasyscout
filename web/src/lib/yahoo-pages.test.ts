import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, normalize } from './fantasy-league';
import { fixedPlayoffs, leagueRecords, recordsFromText } from './league-state';
import { weekScore } from './league-sync';
import { applyYahooImport, parseYahooHash } from './yahoo-bookmarklet';
import { soFarValue } from './matchup';
import { weeksLines, yahooAddsUsed, yahooLeagueRules, yahooPlayoffs, yahooRecord, yahooRosterRules, yahooScore, yahooScoring, yahooWeeks } from './yahoo-pages';

// The text of a public Yahoo league's pages on 8 November 2026, as the bookmark reads them
const LABELS = ['Team', 'FGM/A*', 'FG%', 'FTM/A*', 'FT%', '3PTM', 'PTS', 'REB', 'AST', 'ST', 'BLK', 'TO', ''];
const ROW = ["Lenka's Legendary Team", '172/369', '.466', '112/159', '.704', '35', '491', '202', '111', '31', '24', '57', '4'];
const PLAYOFFS = '6 teams - Week 20, 21 and 22 (ends Sunday, Apr 4)';
const NOV_8 = Date.parse('2026-11-08T17:00:00Z');

describe("Yahoo's pages as the bookmark reads them (#874)", () => {
  it("reads a standings row's W-L-T and rank", () => {
    expect(yahooRecord('12-6-0', '1')).toEqual({ wins: 12, losses: 6, ties: 0, seed: 1 });
    expect(yahooRecord('9-8-1', '5')).toEqual({ wins: 9, losses: 8, ties: 1, seed: 5 });
    expect(yahooRecord('45-30', '')).toEqual({ wins: 45, losses: 30, ties: 0, seed: null });
    expect(yahooRecord('-', '1')).toBeNull();
  });

  it("reads the matchup row's counting stats and the made and attempted behind the percentages", () => {
    expect(yahooScore(LABELS, ROW)).toEqual({
      totals: { z_three_pointers_made: 35, z_points: 491, z_rebounds_total: 202, z_assists: 111, z_steals: 31, z_blocks: 24, z_turnovers: 57 },
      shots: { z_field_goal_pct: [172, 369], z_free_throw_pct: [112, 159] },
    });
    // before the week's first game Yahoo shows dashes: nothing is read
    expect(yahooScore(LABELS, ["Lenka's Legendary Team", '-/-', '-', '-/-', '-', '-', '-', '-', '-', '-', '-', '-', '0'])).toEqual({ totals: {}, shots: {} });
  });

  it('reads the playoffs: the teams, the weeks and their dates, in the season the import falls in', () => {
    expect(yahooPlayoffs(PLAYOFFS, NOV_8)).toEqual({ teams: 6, weeks: 3, periods: [20, 22], from: '2027-03-15', to: '2027-04-04' });
    // read during the playoffs, they are this spring's
    expect(yahooPlayoffs(PLAYOFFS, Date.parse('2027-03-30T12:00:00Z'))?.from).toBe('2027-03-15');
    expect(yahooPlayoffs('4 teams - Week 21 and 22 (ends Sunday, Mar 28)', NOV_8)).toMatchObject({ teams: 4, weeks: 2, periods: [21, 22], from: '2027-03-15', to: '2027-03-28' });
    expect(yahooPlayoffs('No playoffs', NOV_8)).toBeNull();
  });

  it('reads the format and how the records count from the scoring type', () => {
    expect(yahooScoring('Head-to-Head - Categories')).toEqual({ format: 'h2h', tally: 'categories' });
    expect(yahooScoring('Head-to-Head - One Win')).toEqual({ format: 'h2h', tally: 'matchups' });
    expect(yahooScoring('Head-to-Head - Points')).toEqual({ format: 'h2h', tally: 'matchups' });
    expect(yahooScoring('Rotisserie')).toEqual({ format: 'roto', tally: 'categories' });
    expect(yahooScoring('Something new')).toBeNull();
  });
});

const hash = (payload: unknown) => `#yahoo=${encodeURIComponent(JSON.stringify(payload))}`;
const players = [
  { player_id: '1', full_name: 'A One' },
  { player_id: '2', full_name: 'B Two' },
  { player_id: '3', full_name: 'C Three' },
  { player_id: '4', full_name: 'D Four' },
];
const v3 = {
  v: 4,
  leagueId: '12345',
  mine: 2,
  teams: [
    { id: 1, name: 'Dunk Dynasty', players: [{ name: 'A One' }] },
    { id: 2, name: 'Rim Reapers', players: [{ name: 'B Two' }] },
    { id: 3, name: 'Triple Doubles', players: [{ name: 'C Three' }] },
    { id: 4, name: 'Fourth Quarter', players: [{ name: 'D Four' }] },
  ],
  records: { '1': ['12-6-0', '1'], '2': ['9-8-1', '2'], '3': ['8-10-0', '3'], '4': ['5-13-0', '4'] },
  matchup: { labels: LABELS, rows: [{ id: 2, cells: ROW }, { id: 3, cells: ['Triple Doubles', '212/468', '.453', '98/120', '.817', '57', '579', '200', '114', '29', '24', '72', '4'] }] },
  settings: { playoffs: PLAYOFFS, scoring: 'Head-to-Head - Categories' },
};

describe('a Yahoo import brings the league state (#874)', () => {
  const payload = parseYahooHash(hash(v3))!;
  const { setup } = applyYahooImport(normalize({ teams: 4 }, DEFAULT_SETTINGS.nba), payload, players, NOV_8);

  it("keeps each page's text that is well formed, and drops the rest", () => {
    expect(payload.records?.['1']).toEqual(['12-6-0', '1']);
    expect(payload.matchup?.rows).toHaveLength(2);
    const bad = parseYahooHash(hash({ ...v3, records: { '1': 'x' }, matchup: { labels: LABELS, rows: [{ id: 2, cells: ROW }] }, settings: 7 }))!;
    expect(bad.records).toBeUndefined();
    expect(bad.matchup).toBeUndefined();
    // a version 2 bookmark is not read at all now: the League page asks for the bookmark again (#1018)
    expect(parseYahooHash(hash({ ...v3, v: 2 }))).toBeNull();
  });

  it("sets the standings, this week's opponent and both sides' score so far", () => {
    expect(setup.mine).toBe(1);
    expect(setup.opponent).toBe(2);
    expect(setup.source?.opponents).toEqual([null, 2, 1, null]);
    expect(setup.source?.records?.[0]).toEqual({ wins: 12, losses: 6, ties: 0, seed: 1 });
    expect(leagueRecords(setup)).toMatchObject({ from: 'yahoo', tally: 'categories' });
    expect(recordsFromText('yahoo')).toBe('from Yahoo at the last import');
    const score = weekScore(setup, '2026-11-08', () => '2026-11-08');
    expect(score).toMatchObject({ mine: { totals: { z_points: 491 } }, theirs: { totals: { z_points: 579 }, shots: { z_free_throw_pct: [98, 120] } } });
    // a score read on another day misses the days since
    expect(weekScore(setup, '2026-11-09', () => '2026-11-08')).toBe('stale');
  });

  it("sets the playoffs from the settings: Yahoo's weeks 20 to 22 from 15 March, and the format", () => {
    expect(setup.format).toBe('h2h');
    // six teams make Yahoo's playoffs; this four-team league can field no more than four
    expect(setup.playoffs).toEqual({ teams: 4, weeks: 3, start: '2027-03-15' });
    expect(fixedPlayoffs(setup)).toEqual({ periods: [20, 22], from: '2027-03-15', to: '2027-04-04' });
    // and the stored copy keeps it all
    const again = normalize(JSON.parse(JSON.stringify(setup)) as typeof setup, DEFAULT_SETTINGS.nba);
    expect(again.source).toMatchObject({ records: setup.source?.records, scores: setup.source?.scores, playoffWeeks: setup.source?.playoffWeeks, tally: 'categories' });
  });

  it('gives no opponent or score when the matchup on the page is not the manager’s', () => {
    const other = applyYahooImport(normalize({ teams: 4 }, DEFAULT_SETTINGS.nba), parseYahooHash(hash({ ...v3, mine: 1 }))!, players, NOV_8).setup;
    expect(other.source?.scores).toBeUndefined();
    expect(weekScore(other, '2026-11-08', () => '2026-11-08')).toBe('no-score');
  });
});

describe('a league built by hand (#874)', () => {
  const base = normalize({ teams: 4, format: 'h2h' }, DEFAULT_SETTINGS.nba);

  it('starts the standings from the records entered, and the import takes over from them', () => {
    expect(leagueRecords(base)).toBeNull();
    const entered = { ...base, standings: { records: [{ wins: 5, losses: 3, ties: 0, seed: null }, null, null, null], tally: 'matchups' as const } };
    expect(leagueRecords(entered)).toMatchObject({ from: 'entered', tally: 'matchups' });
    const imported = applyYahooImport(entered, parseYahooHash(hash(v3))!, players, NOV_8).setup;
    expect(leagueRecords(imported)?.from).toBe('yahoo');
    // the entered records stay, for when an import brings none
    expect(imported.standings.records[0]).toEqual({ wins: 5, losses: 3, ties: 0, seed: null });
  });

  it('takes the playoffs from the first week entered over the weeks they take, else leaves them to the schedule', () => {
    expect(fixedPlayoffs(base)).toBeNull();
    const set = { ...base, playoffs: { teams: 4, weeks: 3, start: '2027-03-08' } };
    expect(fixedPlayoffs(set)).toEqual({ from: '2027-03-08', to: '2027-03-28', periods: null });
  });
});

describe("a league's roster rules from the bookmark (#1022)", () => {
  it('reads the lineup, bench and IL from the roster positions, Util (3) or Util, Util, Util alike', () => {
    const owner = 'PG, SG, G, SF, PF, F, C, Util, Util, Util, BN, BN, BN, IL, IL';
    expect(yahooRosterRules([['Roster Positions', owner]], [])).toEqual({ lineup: { G: 3, F: 3, C: 1, UTIL: 3 }, rosterSpots: 13, ilSlots: 2 });
    expect(yahooRosterRules([['Roster Positions', 'PG, SG, G, SF, PF, F, C, Util (3), BN (3), IL (2)']], [])).toMatchObject({ rosterSpots: 13, ilSlots: 2 });
  });

  it("falls back to the Starting Rosters page's Pos column, the most of each slot any team fills", () => {
    const team = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL', 'UTIL', 'UTIL', 'BN', 'BN', 'BN', 'IL', 'IL'];
    // one team leaves a Util and a bench slot empty, so it has no row for them
    const short = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'UTIL', 'UTIL', 'BN', 'BN', 'IL'];
    expect(yahooRosterRules([], [short, team])).toEqual({ lineup: { G: 3, F: 3, C: 1, UTIL: 3 }, rosterSpots: 13, ilSlots: 2 });
    expect(yahooRosterRules([], [])).toEqual({});
  });

  it('reads the adds a week and the waiver days', () => {
    expect(yahooRosterRules([['Max Acquisitions per Week', '4'], ['Waiver Time', '2 days']], [])).toEqual({ addsPerWeek: 4, waiverDays: 2 });
    expect(yahooRosterRules([['Max Acquisitions per Week', 'No maximum'], ['Waiver Time', 'None']], [])).toEqual({ addsPerWeek: null, waiverDays: 0 });
  });

  it('sets them, and each player’s slot as set, on an import', () => {
    const payload = parseYahooHash(
      hash({
        ...v3,
        teams: v3.teams.map((t, i) => ({ ...t, players: t.players.map((p) => ({ ...p, slot: i === 1 ? 'BN' : 'Util' })) })),
        settings: { ...v3.settings, rows: [['Roster Positions', 'PG, SG, G, SF, PF, F, C, Util, Util, Util, BN, BN, BN, IL, IL'], ['Max Acquisitions per Week', '4'], ['Waiver Time', '2 days']] },
      }),
    )!;
    const { setup } = applyYahooImport(normalize({ teams: 4 }, DEFAULT_SETTINGS.nba), payload, players, NOV_8);
    expect([setup.lineup, setup.rosterSpots, setup.ilSlots, setup.addsPerWeek, setup.waiverDays]).toEqual([{ G: 3, F: 3, C: 1, UTIL: 3 }, 13, 2, 4, 2]);
    expect(setup.source?.slots).toEqual({ '1': 'UTIL', '2': 'BN', '3': 'UTIL', '4': 'UTIL' });
    // the manager's roster at the week's first import, for the adds made since
    expect(setup.source?.week).toEqual({ monday: '2026-11-02', roster: ['2'] });
  });
});


describe("a league's trade and tie rules from the bookmark (#1025)", () => {
  it('reads the trade deadline, the trade review and the tie-breaker, each only when the page has it', () => {
    const rows: [string, string][] = [['Trade End Date', 'Thursday, March 4, 2027'], ['Trade Review', 'League Votes'], ['Playoff Tie-Breaker', 'Higher seed wins']];
    expect(yahooLeagueRules(rows)).toEqual({ tradeDeadline: 'Thursday, March 4, 2027', tradeReview: 'League Votes', tieBreaker: 'Higher seed wins' });
    expect(yahooLeagueRules([['Trade Deadline', 'Mar 4']])).toEqual({ tradeDeadline: 'Mar 4' });
    expect(yahooLeagueRules([])).toEqual({});
  });

  it('keeps them with the league on an import, and only well-formed ones when stored', () => {
    const payload = parseYahooHash(hash({ ...v3, settings: { ...v3.settings, rows: [['Trade Review', 'League Votes'], ['Playoff Tie-Breaker', 'Higher seed wins']] } }))!;
    const { setup } = applyYahooImport(normalize({ teams: 4 }, DEFAULT_SETTINGS.nba), payload, players, NOV_8);
    expect(setup.source?.rules).toEqual({ tradeReview: 'League Votes', tieBreaker: 'Higher seed wins' });
    const stored = normalize({ ...setup, source: { ...setup.source!, rules: { tradeReview: 7, tieBreaker: '' } as never } }, DEFAULT_SETTINGS.nba);
    expect(stored.source?.rules).toBeUndefined();
  });
});

describe("the adds used this week, from the manager's team page (#1028)", () => {
  it("reads Yahoo's line, and nothing from any other wording", () => {
    expect(yahooAddsUsed('You have used 0 of your 4 player adds for this week.')).toEqual({ used: 0, limit: 4 });
    expect(yahooAddsUsed('You have used 1 of your 4 player add for this week.')).toEqual({ used: 1, limit: 4 });
    expect(yahooAddsUsed('Waiver Priority: 8th')).toBeNull();
  });

  it('an import keeps the count with the roster it counted', () => {
    const payload = parseYahooHash(hash({ ...v3, adds: 'You have used 3 of your 4 player adds for this week.' }))!;
    expect(payload.adds).toContain('used 3 of your 4');
    const { setup } = applyYahooImport(normalize({ teams: 4 }, DEFAULT_SETTINGS.nba), payload, players, NOV_8);
    expect(setup.source?.addsUsed).toEqual({ monday: '2026-11-02', used: 3, roster: setup.rosters[setup.mine] });
    // a payload without the line keeps no count
    expect(applyYahooImport(normalize({ teams: 4 }, DEFAULT_SETTINGS.nba), parseYahooHash(hash(v3))!, players, NOV_8).setup.source?.addsUsed).toBeUndefined();
  });
});

describe("every week's matchup totals, from the week pages (#1049)", () => {
  // a finished week's matchup page as Yahoo shows it: the two rows, then a second matchup
  const A = ['Team A', '240/479', '.501', '111/140', '.793', '57', '648', '287', '148', '35', '36', '71', '5'];
  const B = ['Team B', '248/506', '.490', '136/179', '.760', '68', '700', '231', '182', '54', '28', '97', '4'];
  const C = ['Team C', '201/430', '.467', '90/118', '.763', '49', '560', '250', '120', '40', '22', '66', '6'];
  const D = ['Team D', '230/470', '.489', '101/130', '.777', '61', '615', '240', '131', '33', '30', '80', '3'];
  const week = (w: number, final: boolean) => ({
    week: w,
    final,
    pages: [
      { rows: [{ id: 1, cells: A }, { id: 2, cells: B }] },
      { rows: [{ id: 3, cells: C }, { id: 4, cells: D }] },
    ],
  });
  const ids = [1, 2, 3, 4];

  it("reproduces every number in Yahoo's table, the percentages from the made and attempted", () => {
    const [w] = yahooWeeks({ weekLabels: LABELS, weeks: [week(4, true)] }, ids);
    expect(w).toMatchObject({ week: 4, final: true });
    for (const [i, row] of [A, B, C, D].entries()) {
      const s = w!.teams[i]!;
      expect(s.shots).toEqual({ z_field_goal_pct: row[1]!.split('/').map(Number), z_free_throw_pct: row[3]!.split('/').map(Number) });
      // Yahoo's FG% and FT% to three places, e.g. 240/479 = .501
      expect(soFarValue(s, 'z_field_goal_pct')!.toFixed(3)).toBe(`0${row[2]}`);
      expect(soFarValue(s, 'z_free_throw_pct')!.toFixed(3)).toBe(`0${row[4]}`);
      expect(s.totals).toEqual({
        z_three_pointers_made: Number(row[5]),
        z_points: Number(row[6]),
        z_rebounds_total: Number(row[7]),
        z_assists: Number(row[8]),
        z_steals: Number(row[9]),
        z_blocks: Number(row[10]),
        z_turnovers: Number(row[11]),
      });
    }
    // the teams are in the payload's order, whatever order the pages came in
    expect(yahooWeeks({ weekLabels: LABELS, weeks: [week(4, true)] }, [4, 3, 2, 1])[0]!.teams[0]!.totals['z_points']).toBe(615);
    // a page's own labels win over the shared ones; a team no page shows is null
    const own = yahooWeeks({ weekLabels: ['Team'], weeks: [{ week: 1, final: false, pages: [{ labels: LABELS, rows: [{ id: 1, cells: A }, { id: 2, cells: B }] }] }] }, ids)[0]!;
    expect(own.teams.map((t) => t?.totals['z_points'] ?? null)).toEqual([648, 700, null, null]);
  });

  it('keeps well-formed weeks and drops the rest; a week is whole or not at all', () => {
    const good = parseYahooHash(hash({ ...v3, weekLabels: LABELS, weeks: [week(1, true), week(2, false)], weeksStop: { week: 3, page: 'matchup?week=3&mid1=2' } }))!;
    expect(good.weeks?.map((w) => [w.week, w.final, w.pages.length])).toEqual([
      [1, true, 2],
      [2, false, 2],
    ]);
    expect(good.weekLabels).toEqual(LABELS);
    expect(good.weeksStop).toEqual({ week: 3, page: 'matchup?week=3&mid1=2' });
    const one = (x: unknown) => parseYahooHash(hash({ ...v3, weekLabels: LABELS, weeks: [week(1, true), x] }))!.weeks?.map((w) => w.week);
    // a page with one side, a team id that is not a number, a week out of range, no final flag
    expect(one({ ...week(2, true), pages: [{ rows: [{ id: 1, cells: A }] }] })).toEqual([1]);
    expect(one({ ...week(2, true), pages: [{ rows: [{ id: '1', cells: A }, { id: 2, cells: B }] }] })).toEqual([1]);
    expect(one(week(0, true))).toEqual([1]);
    expect(one(week(31, true))).toEqual([1]);
    expect(one({ week: 2, pages: week(2, true).pages })).toEqual([1]);
    // the same week twice is read once
    expect(one(week(1, false))).toEqual([1]);
    // a page with no labels of its own and none shared is not read
    expect(parseYahooHash(hash({ ...v3, weeks: [week(1, true)] }))!.weeks).toBeUndefined();
    // a long cell is cut, not dropped
    const long = { ...week(1, true), pages: [{ rows: [{ id: 1, cells: ['x'.repeat(500), ...A.slice(1)] }, { id: 2, cells: B }] }] };
    expect(parseYahooHash(hash({ ...v3, weekLabels: LABELS, weeks: [long] }))!.weeks?.[0]?.pages[0]?.rows[0]?.cells[0]).toHaveLength(60);
    // a stop names a page in the league, nothing else
    for (const page of ['/nba/12345/matchup?week=3&mid1=2', 'matchup?week=3&mid1=2&x=<b>', 'https://example.com/']) {
      expect(parseYahooHash(hash({ ...v3, weeksStop: { week: 3, page } }))!.weeksStop).toBeUndefined();
    }
    // a bookmark from before the weeks still imports
    expect(parseYahooHash(hash(v3))).toMatchObject({ v: 4, leagueId: '12345' });
    expect(parseYahooHash(hash(v3))!.weeks).toBeUndefined();
  });

  const run = (weeks: unknown[], extra: object = {}, leagueId = '12345') => parseYahooHash(hash({ ...v3, leagueId, weekLabels: LABELS, weeks, ...extra }))!;
  const fresh = normalize({ teams: 4 }, DEFAULT_SETTINGS.nba);

  it('keeps the finished weeks across imports of the same league, and the newest read of each week', () => {
    const first = applyYahooImport(fresh, run([week(1, true), week(2, true), week(3, false)]), players, NOV_8).setup;
    expect(first.source?.weeks?.map((w) => [w.week, w.final])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
    // the second run sends only week 3, now final, and week 4 so far: weeks 1 and 2 are kept
    const changed = { ...week(3, true), pages: [{ rows: [{ id: 1, cells: B }, { id: 2, cells: A }] }, week(3, true).pages[1]!] };
    const second = applyYahooImport(first, run([changed, week(4, false)]), players, NOV_8).setup;
    expect(second.source?.weeks?.map((w) => [w.week, w.final])).toEqual([
      [1, true],
      [2, true],
      [3, true],
      [4, false],
    ]);
    expect(second.source?.weeks?.[2]?.teams[0]?.totals['z_points']).toBe(700);
    // a week under way that the next import does not carry is not kept; nor is any week of another league
    const third = applyYahooImport(second, run([week(5, false)]), players, NOV_8).setup;
    expect(third.source?.weeks?.map((w) => w.week)).toEqual([1, 2, 3, 5]);
    const other = applyYahooImport(second, run([week(1, false)], {}, '67890'), players, NOV_8).setup;
    expect(other.source?.weeks?.map((w) => [w.week, w.final])).toEqual([[1, false]]);
    // an older bookmark brings no weeks and keeps the finished ones
    expect(applyYahooImport(second, parseYahooHash(hash(v3))!, players, NOV_8).setup.source?.weeks?.map((w) => w.week)).toEqual([1, 2, 3]);
  });

  it('keeps the weeks and the page an import stopped at through the stored copy', () => {
    const { setup } = applyYahooImport(fresh, run([week(1, true)], { weeksStop: { week: 2, page: 'matchup?week=2&mid1=1' } }), players, NOV_8);
    expect(setup.source?.weeksStop).toEqual({ week: 2, page: 'matchup?week=2&mid1=1' });
    const again = normalize(JSON.parse(JSON.stringify(setup)) as typeof setup, DEFAULT_SETTINGS.nba);
    expect(again.source?.weeks).toEqual(setup.source?.weeks);
    expect(again.source?.weeksStop).toEqual(setup.source?.weeksStop);
    expect(again.source?.weeks?.[0]?.teams[0]?.shots['z_field_goal_pct']).toEqual([240, 479]);
    // a malformed stored week is dropped, a malformed score is null
    const weeks = [{ week: 'x' }, { week: 2, final: true, teams: [{ totals: { z_points: 'a' } }, null] }];
    const bad = normalize({ ...again, source: { ...again.source!, weeks: weeks as never, weeksStop: { week: 0, page: 'p' } } }, DEFAULT_SETTINGS.nba);
    expect(bad.source?.weeks).toEqual([{ week: 2, final: true, teams: [null, null] }]);
    expect(bad.source?.weeksStop).toBeUndefined();
    // the next import without a stop clears it
    expect(applyYahooImport(setup, run([week(1, true), week(2, false)]), players, NOV_8).setup.source?.weeksStop).toBeUndefined();
  });

  it('says which weeks are final and which so far, and names a page that did not answer', () => {
    const w = (week: number, final: boolean) => ({ week, final, teams: [] });
    expect(weeksLines({ weeks: [w(1, true), w(2, true), w(3, true), w(4, true), w(5, false)] })).toEqual({ read: 'Weeks from Yahoo: 1–4 final, 5 so far.', stop: null });
    expect(weeksLines({ weeks: [w(1, true), w(3, true)] }).read).toBe('Weeks from Yahoo: 1, 3 final.');
    expect(weeksLines({ weeks: [w(1, true)], weeksStop: { week: 2, page: 'matchup?week=2&mid1=1' } })).toEqual({
      read: 'Weeks from Yahoo: 1 final.',
      stop: 'Yahoo did not answer the page for week 2 (matchup?week=2&mid1=1), so that week and the ones after it were not read; run the bookmark again later.',
    });
    expect(weeksLines({})).toEqual({ read: null, stop: null });
  });
});
