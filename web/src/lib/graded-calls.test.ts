import { describe, expect, it } from 'vitest';

import { callKey } from '../../../worker/src/owner-log-event';
import { type LoggedCall } from './graded';
import { gradeCalls, type LoggedImport, parseImports, type PlayerWeek, weekCalls } from './graded-calls';
import type { LeagueWeek } from './league-weeks';

// The preview's calls of last week, graded (#1058). Every player, team and number is made up.

const MONDAY = '2026-11-23';
const IMPORT = 'yahoo:99:1795000000000';

/** A log entry in its present form, with its key, as parseLog reads it. */
const call = (o: Partial<LoggedCall> & Pick<LoggedCall, 'call' | 'subject' | 'value'>): LoggedCall => {
  const e = { at: `${o.date ?? MONDAY}T15:00:00.000Z`, date: MONDAY, naive: null, build: 'b1', league: IMPORT, ...o };
  return { ...e, key: callKey(e) };
};

const week = (id: string, played: number, points: number): PlayerWeek => ({
  league: 'nba',
  player_id: id,
  week_start: MONDAY,
  games_scheduled: 4,
  games_played: played,
  points,
  rebounds_total: 20,
  assists: 10,
  steals: 4,
  blocks: 2,
  three_pointers_made: 6,
  turnovers: 5,
  field_goals_made: 30,
  field_goals_attempted: 60,
  free_throws_made: 10,
  free_throws_attempted: 12,
});
// 1000001 played four games; 1000002 none of his four; 1000009 is on no team that week
const WEEKS = [week('1000001', 4, 90), week('1000002', 0, 0), week('1000003', 3, 50), week('1000004', 2, 30), { ...week('1000001', 1, 9), week_start: '2026-11-16' }];

const TOTALS = (pts: number) => ({ totals: { z_points: pts, z_steals: 5, z_blocks: 3 }, shots: {} });
const WEEK_9: LeagueWeek = { week: 9, final: true, teams: [TOTALS(500), TOTALS(480), null] };

const IMPORTS: LoggedImport[] = [{ at: `${MONDAY}T12:00:00.000Z`, mine: 0, rosters: [['1000001', '1000002', '1000003'], []], slots: { '1000003': 'IL' } }];

describe("last week's preview calls", () => {
  it('grades every entry of the week, each tied to its entry by its key, and drops none', () => {
    const entries = [
      call({ call: 'top-adds', subject: '1000001 for 1000002', value: 'window value 41.0' }),
      call({ call: 'top-adds', subject: 'held back', value: 'all 3 held back: no adds left this week' }),
      call({ call: 'build', subject: 'category z_points', value: 'Points · 3rd of 8 · 62%' }),
      call({ call: 'trade-finder', subject: '3: 1000003 > 1000004', value: '+0.40 categories', date: '2026-11-29' }),
      // the week's chances are graded by category, and another week's calls are not this week's
      call({ call: 'week-chance', subject: `nba ${MONDAY} vs 1 z_points`, value: 0.7 }),
      call({ call: 'stream', subject: '1000001 for 1000002', value: 'x', date: '2026-11-30' }),
    ];
    const grades = gradeCalls(entries, MONDAY, WEEKS, WEEK_9, [], 0);
    expect(grades.map((g) => g.entry.key)).toEqual(entries.slice(0, 4).map((e) => e.key));
    expect(grades.map((g) => g.kind)).toEqual(['players', 'not-graded', 'not-graded', 'players']);
    expect(weekCalls(entries, MONDAY)).toHaveLength(4);
  });

  it('shows what each named player did that week, the naive manager keeping the drop, and says who did not play', () => {
    const [swap, add, trade] = gradeCalls(
      [
        call({ call: 'swaps', subject: '1000001 for 1000002', value: '+1.2 this week' }),
        call({ call: 'top-adds', subject: '1000009', value: 'window value 12.0' }),
        call({ call: 'trade-suggestions', subject: '1000003 > 1000004', value: '+0.15 categories' }),
      ],
      MONDAY,
      WEEKS,
      WEEK_9,
      [],
      0,
    );
    expect(swap).toMatchObject({ kind: 'players', keeps: ['1000002'], players: [{ id: '1000001', role: 'add', line: { games_played: 4, points: 90 } }, { id: '1000002', role: 'drop', line: { games_played: 0 } }] });
    // a player on no team's box score that week: no line, shown as did not play
    expect(add).toMatchObject({ kind: 'players', keeps: [], players: [{ id: '1000009', role: 'add', line: null }] });
    expect(trade).toMatchObject({ kind: 'players', keeps: ['1000003'], players: [{ role: 'give' }, { role: 'get' }] });
  });

  it("grades a build row by the move shown beside him, and says what an entry cut to fit left out", () => {
    const [row, cut, plain] = gradeCalls(
      [
        call({ call: 'build', subject: 'let go 1000002', value: 'add 1000001 drop 1000002 (+0.15 cats) score +0.10' }),
        call({ call: 'trade-verdict', subject: '1000003 1000004 (+2 more) > 1000001', value: 'fair' }),
        call({ call: 'build', subject: 'lowest 1000004', value: 'score -1.20' }),
      ],
      MONDAY,
      WEEKS,
      WEEK_9,
      [],
      0,
    );
    expect(row).toMatchObject({ kind: 'players', players: [{ id: '1000001', role: 'add' }, { id: '1000002', role: 'drop' }] });
    expect(cut).toMatchObject({ kind: 'players', leftOut: 2, players: [{ id: '1000003' }, { id: '1000004' }, { id: '1000001', role: 'get' }] });
    expect(plain).toMatchObject({ kind: 'players', players: [{ id: '1000004', role: 'named' }] });
  });

  it("says the week's data is not in yet, rather than grading a player call without it", () => {
    const [g] = gradeCalls([call({ call: 'swaps', subject: '1000001 for 1000002', value: '+1.2 this week' })], MONDAY, null, WEEK_9, [], 0);
    expect(g).toMatchObject({ kind: 'not-graded', why: "the week's player data is not in yet" });
    const [other] = gradeCalls([call({ call: 'swaps', subject: '1000001 for 1000002', value: '+1.2' })], MONDAY, WEEKS.slice(4), WEEK_9, [], 0);
    expect(other).toMatchObject({ kind: 'not-graded', why: "the week's player data is not in yet" });
  });

  it('grades the too-close band by how each category it called too close ended, naming one with no total', () => {
    const entry = call({ call: 'too-close', subject: 'vs 1 z_points z_steals z_assists', value: 'against Summit: Winning 1, losing 0, 3 too close', naive: 'Winning 2, losing 1' });
    const [g] = gradeCalls([entry], MONDAY, WEEKS, WEEK_9, [], 0);
    expect(g).toMatchObject({ kind: 'categories', opponent: 1, cats: [{ cat: 'z_points', result: 'win' }, { cat: 'z_steals', result: 'tie' }, { cat: 'z_assists', result: null }] });
    expect(gradeCalls([entry], MONDAY, WEEKS, null, [], 0)[0]).toMatchObject({ kind: 'not-graded', why: "the week's final totals are not imported yet" });
  });

  it('grades the lineup plan of the Monday by the games its roster played, and says why a later plan or a day is not', () => {
    const value = '9 starts, against Summit\'s 8, 1 lost to a full lineup, 2 open slots';
    const [mon] = gradeCalls([call({ call: 'lineup', subject: 'week', value })], MONDAY, WEEKS, WEEK_9, IMPORTS, 0);
    // 1000003 is on the injured list: the plan does not count him
    expect(mon).toMatchObject({ kind: 'lineup', counted: 9, played: 4, roster: 2 });
    const [later, day, none] = gradeCalls(
      [
        call({ call: 'lineup', subject: 'week', value, date: '2026-11-25' }),
        call({ call: 'lineup', subject: 'day 2026-11-24', value: '3 start; open G; sits 1000002' }),
        call({ call: 'lineup', subject: 'week', value: '9 starts', at: '2026-11-23T20:00:00.000Z' }),
      ],
      MONDAY,
      WEEKS,
      WEEK_9,
      [],
      0,
    );
    expect(later).toMatchObject({ kind: 'not-graded', why: 'a plan made after the Monday counted the days left alone' });
    expect(day).toMatchObject({ kind: 'not-graded', why: "a day's plan: the week's player data is by week, not by day" });
    expect(none).toMatchObject({ kind: 'not-graded', why: 'no import logged that day names the roster it counted' });
  });

  it('says why an entry that names no player is not graded', () => {
    const why = (subject: string, c = 'swaps') => gradeCalls([call({ call: c, subject, value: 'v' })], MONDAY, WEEKS, WEEK_9, [], 0)[0];
    expect(why('held back')).toMatchObject({ why: 'held back by the adds limit: no move was shown' });
    expect(why('none')).toMatchObject({ why: 'no move was shown' });
    expect(why('replace')).toMatchObject({ why: 'a summary of the swaps; each swap is graded on its own line' });
    expect(why('category z_points', 'build')).toMatchObject({ why: "a category's standing, not a call on the week" });
    expect(why('something new')).toMatchObject({ why: 'the entry does not hold enough to grade' });
  });

  it('reads the imports logged, skipping other lines', () => {
    const text = [JSON.stringify({ kind: 'import', at: 'x', mine: 0, rosters: [['1000001'], 'bad'], slots: { '1000001': 'PG' } }), '{"kind":"page","path":"/"}', 'cut'].join('\n');
    expect(parseImports(text)).toEqual([{ at: 'x', mine: 0, rosters: [['1000001'], []], slots: { '1000001': 'PG' } }]);
  });
});
