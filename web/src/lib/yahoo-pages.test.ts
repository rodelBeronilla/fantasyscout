import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, normalize } from './fantasy-league';
import { fixedPlayoffs, leagueRecords, recordsFromText } from './league-state';
import { weekScore } from './league-sync';
import { applyYahooImport, parseYahooHash } from './yahoo-bookmarklet';
import { yahooAddsUsed, yahooLeagueRules, yahooPlayoffs, yahooRecord, yahooRosterRules, yahooScore, yahooScoring } from './yahoo-pages';

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
