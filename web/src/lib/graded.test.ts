import { describe, expect, it } from 'vitest';

import type { LeagueSource } from './fantasy-league';
import {
  addDays,
  firstRecords,
  gradeWeek,
  gradingStarts,
  lastWeekGraded,
  type LoggedCall,
  parseLog,
  readWeekChances,
  running,
  soFarTally,
  type WeekChances,
  weekChancesCall,
  yahooWeekOf,
} from './graded';
import type { LeagueWeek } from './league-weeks';
import type { ScoreSoFar } from './matchup';

// Last week, graded (#1058). Every team, player and number below is made up.

const score = (totals: Record<string, number>, fg: [number, number], ft: [number, number]): ScoreSoFar => ({
  totals,
  shots: { z_field_goal_pct: fg, z_free_throw_pct: ft },
});

// the manager (team 0) against team 2: won points, rebounds, FG%; lost assists, turnovers (more); tied steals
const MINE = score({ z_points: 520, z_rebounds_total: 210, z_assists: 100, z_steals: 30, z_blocks: 25, z_three_pointers_made: 60, z_turnovers: 70 }, [200, 400], [80, 100]);
const THEIRS = score({ z_points: 500, z_rebounds_total: 190, z_assists: 120, z_steals: 30, z_blocks: 20, z_three_pointers_made: 70, z_turnovers: 60 }, [180, 400], [90, 100]);
const WEEK_9: LeagueWeek = { week: 9, final: true, teams: [MINE, null, THEIRS] };

const CHANCES: Record<string, number> = {
  z_points: 0.7, // won, favoured: right
  z_rebounds_total: 0.4, // won, not favoured: wrong
  z_assists: 0.3, // lost, not favoured: right
  z_steals: 0.6, // tied: no call
  z_blocks: 0.5, // a coin: no call
  z_three_pointers_made: 0.45, // lost: right
  z_field_goal_pct: 0.55, // 50% to 45%: won, right
  z_free_throw_pct: 0.8, // 80% to 90%: lost, wrong
  z_turnovers: 0.2, // 70 to 60, the lower wins: lost, right
};

const record = (over: Partial<WeekChances> = {}): WeekChances => ({
  league: 'nba',
  monday: '2026-11-23',
  opponent: 2,
  week: 9,
  chances: CHANCES,
  soFar: null,
  date: '2026-11-23',
  at: '2026-11-23T15:00:00.000Z',
  ...over,
});

/** A record as the log keeps it, one JSON line. */
const line = (r: WeekChances, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ at: r.at, kind: 'call', date: r.date, ...weekChancesCall(r), build: 'b1', ...extra });

const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe('when grading starts', () => {
  it('starts with the first full week after the log shipped, and grades it the Monday after', () => {
    // the log shipped on Tuesday 2026-11-17: the first full week is Monday 2026-11-23's
    expect(gradingStarts()).toEqual({ week: '2026-11-23', firstGrade: '2026-11-30' });
    expect(gradingStarts('2026-11-22')).toEqual({ week: '2026-11-23', firstGrade: '2026-11-30' });
    // shipped on a Monday, that week is full
    expect(gradingStarts('2026-11-23')).toEqual({ week: '2026-11-23', firstGrade: '2026-11-30' });
    expect(addDays('2026-11-30', -7)).toBe('2026-11-23');
  });

  it('says so until the first grade, whatever the log holds', () => {
    const calls = parseLog(line(record()));
    for (const today of ['2026-11-21', '2026-11-29']) {
      expect(lastWeekGraded(calls, 'nba', undefined, 0, today, dateOf).last).toEqual({ state: 'before', week: '2026-11-23', firstGrade: '2026-11-30' });
    }
    expect(lastWeekGraded(calls, 'nba', undefined, 0, '2026-11-30', dateOf).last.state).not.toBe('before');
  });
});

describe('the logged record', () => {
  it('is compact, under the log’s 200 characters, and reads back as it was', () => {
    const r = record({ soFar: [3, 4, 2], date: '2026-11-25' });
    const call = weekChancesCall(r);
    expect(call).toMatchObject({ call: 'week-chances', subject: 'nba:2026-11-23:2', naive: 0.5 });
    expect(call.value.length).toBeLessThanOrEqual(200);
    expect(JSON.parse(call.value)).toEqual({
      w: 9,
      c: { PTS: 0.7, REB: 0.4, AST: 0.3, STL: 0.6, BLK: 0.5, '3PM': 0.45, 'FG%': 0.55, 'FT%': 0.8, TO: 0.2 },
      s: [3, 4, 2],
    });
    const [back] = parseLog(line(r));
    expect(readWeekChances(back!)).toEqual(r);
  });

  it('keeps a chance to a thousandth', () => {
    const call = weekChancesCall(record({ chances: { z_points: 0.123456 } }));
    expect(JSON.parse(call.value).c).toEqual({ PTS: 0.123 });
  });

  it('skips lines that are not a week’s chances, and a line cut short', () => {
    const text = [
      JSON.stringify({ at: 'x', kind: 'page', path: '/team/' }),
      JSON.stringify({ at: 'x', kind: 'call', date: '2026-11-23', call: 'lineup', subject: 'none', value: '40 starts', naive: null, build: 'b' }),
      line(record({ monday: '2026-11-24' })), // not a Monday
      line(record()).slice(0, 40),
      line(record()),
      '',
    ].join('\n');
    const calls = parseLog(text);
    expect(calls.map((c) => c.call)).toEqual(['lineup', 'week-chances', 'week-chances']);
    expect(calls.map(readWeekChances).filter(Boolean)).toHaveLength(1);
  });

  it('takes each week’s first record, of the league asked', () => {
    const calls = parseLog(
      [
        line(record({ date: '2026-11-25', at: '2026-11-25T15:00:00Z', chances: { z_points: 0.9 } })),
        line(record()),
        line(record({ league: 'wnba', chances: { z_points: 0.1 } })),
      ].join('\n'),
    );
    const first = firstRecords(calls, 'nba');
    expect([...first.keys()]).toEqual(['2026-11-23']);
    expect(first.get('2026-11-23')!.chances).toEqual(CHANCES);
  });
});

describe('a week graded', () => {
  it('compares each category’s chance with the final totals, turnovers lower winning and percentages from makes and attempts', () => {
    const g = gradeWeek(record(), WEEK_9, 0);
    const by = Object.fromEntries(g.cats.map((c) => [c.cat, [c.result, c.favoured, c.right]]));
    expect(by).toEqual({
      z_points: ['win', 'mine', true],
      z_rebounds_total: ['win', 'theirs', false],
      z_assists: ['loss', 'theirs', true],
      z_steals: ['tie', 'mine', null],
      z_blocks: ['win', null, null],
      z_three_pointers_made: ['loss', 'theirs', true],
      z_field_goal_pct: ['win', 'mine', true],
      z_free_throw_pct: ['loss', 'mine', false],
      z_turnovers: ['loss', 'theirs', true],
    });
    expect(g.cats.find((c) => c.cat === 'z_field_goal_pct')).toMatchObject({ mine: 0.5, theirs: 0.45 });
  });

  it('counts a 50% chance and a tie as no call, and scores Brier over the categories won or lost', () => {
    const r = running([gradeWeek(record(), WEEK_9, 0)]);
    // seven calls (steals tied, blocks a coin): five right
    expect(r).toMatchObject({ weeks: 1, right: 5, made: 7, scored: 8 });
    const brier = [0.3 ** 2, 0.6 ** 2, 0.3 ** 2, 0.5 ** 2, 0.45 ** 2, 0.45 ** 2, 0.8 ** 2, 0.2 ** 2].reduce((s, x) => s + x, 0) / 8;
    expect(r.brier).toBeCloseTo(brier, 10);
    expect(running([])).toEqual({ weeks: 0, right: 0, made: 0, brier: null, scored: 0 });
  });

  it('grades a category Yahoo gave no total for as nothing', () => {
    const g = gradeWeek(record(), { ...WEEK_9, teams: [MINE, null, null] }, 0);
    expect(g.cats.every((c) => c.result === null && c.right === null)).toBe(true);
    expect(running([g])).toMatchObject({ made: 0, brier: null });
  });

  it('tallies the score so far in categories won, lost and tied', () => {
    expect(soFarTally(Object.keys(CHANCES), MINE, THEIRS)).toEqual([4, 4, 1]);
    expect(soFarTally(Object.keys(CHANCES), MINE, null)).toBeNull();
  });
});

describe('the Yahoo week of a Monday', () => {
  const at = Date.parse('2026-11-25T18:00:00Z'); // a Wednesday
  const source = { host: 'yahoo', syncedAt: at, weeks: [{ week: 8, final: true, teams: [] }, { week: 9, final: false, teams: [] }] } as unknown as LeagueSource;
  it('counts from the week the latest import was still playing', () => {
    expect(yahooWeekOf(source, '2026-11-23', dateOf)).toBe(9);
    expect(yahooWeekOf(source, '2026-11-16', dateOf)).toBe(8);
    expect(yahooWeekOf(source, '2026-11-30', dateOf)).toBe(10);
  });
  it('is unknown without a Yahoo import holding an unfinished week', () => {
    expect(yahooWeekOf(undefined, '2026-11-23', dateOf)).toBeNull();
    expect(yahooWeekOf({ ...source, host: 'espn' }, '2026-11-23', dateOf)).toBeNull();
    expect(yahooWeekOf({ ...source, weeks: [{ week: 8, final: true, teams: [] }] }, '2026-11-23', dateOf)).toBeNull();
  });
});

describe('last week on the card', () => {
  const src = (weeks: LeagueWeek[], syncedAt = Date.parse('2026-11-30T14:00:00Z')) => ({ host: 'yahoo', syncedAt, weeks }) as unknown as LeagueSource;
  const log = (...rs: WeekChances[]): LoggedCall[] => parseLog(rs.map((r) => line(r)).join('\n'));

  it('grades last week once its final totals are imported, and keeps the running record', () => {
    const source = src([{ week: 8, final: true, teams: [THEIRS, null, MINE] }, WEEK_9, { week: 10, final: false, teams: [] }]);
    const out = lastWeekGraded(log(record({ monday: '2026-11-16', week: 8, date: '2026-11-16' }), record()), 'nba', source, 0, '2026-12-01', dateOf);
    expect(out.last.state).toBe('graded');
    if (out.last.state === 'graded') expect(out.last.grade.record.monday).toBe('2026-11-23');
    // the week before the first graded one is not counted
    expect(out.running).toMatchObject({ weeks: 1, right: 5, made: 7 });
  });

  it('asks for an import when the week’s totals are not in yet, or not final', () => {
    for (const weeks of [[], [{ ...WEEK_9, final: false }]]) {
      const out = lastWeekGraded(log(record()), 'nba', src(weeks), 0, '2026-11-30', dateOf);
      expect(out.last).toMatchObject({ state: 'not-imported', monday: '2026-11-23' });
      expect(out.running.weeks).toBe(0);
    }
  });

  it('finds the week by the latest import when the record holds no Yahoo week', () => {
    const out = lastWeekGraded(log(record({ week: null })), 'nba', src([WEEK_9, { week: 10, final: false, teams: [] }]), 0, '2026-11-30', dateOf);
    expect(out.last.state).toBe('graded');
  });

  it('grades a mid-week record, and says it was one', () => {
    const out = lastWeekGraded(log(record({ date: '2026-11-25', soFar: [2, 1, 0] })), 'nba', src([WEEK_9, { week: 10, final: false, teams: [] }]), 0, '2026-11-30', dateOf);
    expect(out.last.state).toBe('graded');
    if (out.last.state === 'graded') expect(out.last.grade.record).toMatchObject({ date: '2026-11-25', soFar: [2, 1, 0] });
  });

  it('says when no chance was recorded last week', () => {
    expect(lastWeekGraded(log(record()), 'nba', src([WEEK_9]), 0, '2026-12-08', dateOf).last).toEqual({ state: 'none', monday: '2026-11-30' });
  });

  it('does not grade this week, still being played', () => {
    const out = lastWeekGraded(log(record({ monday: '2026-11-30', date: '2026-11-30', week: 10 })), 'nba', src([{ ...WEEK_9, week: 10 }]), 0, '2026-12-02', dateOf);
    expect(out.last.state).toBe('none');
    expect(out.running.weeks).toBe(0);
  });
});
