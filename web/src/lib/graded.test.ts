import { describe, expect, it } from 'vitest';

import { validCall } from '../../../worker/src/owner-log-event';
import type { LeagueSource } from './fantasy-league';
import { addDays, gradeWeek, gradingStarts, lastWeekGraded, parseLog, running, soFarTally, weekChanceCalls, weekRecords, yahooWeekOf } from './graded';
import type { LeagueWeek } from './league-weeks';
import type { ScoreSoFar } from './matchup';
import type { PreviewCall } from './owner-preview';

// Last week, graded (#1058). Every team, player and number below is made up.

const score = (totals: Record<string, number>, fg: [number, number], ft: [number, number]): ScoreSoFar => ({
  totals,
  shots: { z_field_goal_pct: fg, z_free_throw_pct: ft },
});

// the manager (team 0) against team 2: won points, rebounds, FG%; lost assists, threes, FT%, turnovers (more); tied steals
const MINE = score({ z_points: 520, z_rebounds_total: 210, z_assists: 100, z_steals: 30, z_blocks: 25, z_three_pointers_made: 60, z_turnovers: 70 }, [200, 400], [80, 100]);
const THEIRS = score({ z_points: 500, z_rebounds_total: 190, z_assists: 120, z_steals: 30, z_blocks: 20, z_three_pointers_made: 70, z_turnovers: 60 }, [180, 400], [90, 100]);
const WEEK_9: LeagueWeek = { week: 9, final: true, teams: [MINE, null, THEIRS, null, null, null, null, null] };

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

const IMPORT = 'yahoo:99:1795000000000';

/** The log lines a page's batch would store for these calls, on `date`, as the Worker writes them. */
const lines = (calls: PreviewCall[], date: string, at = `${date}T15:00:00.000Z`, league = IMPORT) =>
  calls.map((c) => JSON.stringify({ at, kind: 'call', date, ...c, build: 'b1', league })).join('\n');

const WEEK = { league: 'nba' as const, monday: '2026-11-23', opponent: 2, week: 9, chances: CHANCES, soFar: null };
const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe('when grading starts', () => {
  it("starts with the first full week after the log's present form shipped, and grades it the Monday after", () => {
    // #1057 merged on Sunday 2026-11-22: the first full week is Monday 2026-11-23's
    expect(gradingStarts()).toEqual({ week: '2026-11-23', firstGrade: '2026-11-30' });
    // shipped on a Monday, that week is full
    expect(gradingStarts('2026-11-23')).toEqual({ week: '2026-11-23', firstGrade: '2026-11-30' });
    expect(addDays('2026-11-30', -7)).toBe('2026-11-23');
  });

  it('says when the first grade comes, and no number, until then, whatever the log holds', () => {
    const calls = parseLog(lines(weekChanceCalls(WEEK), '2026-11-23'));
    for (const today of ['2026-11-21', '2026-11-23', '2026-11-29']) {
      const { last, running: r } = lastWeekGraded(calls, 'nba', { host: 'yahoo', weeks: [WEEK_9] } as LeagueSource, 0, today, dateOf);
      expect(last).toEqual({ state: 'before', week: '2026-11-23', firstGrade: '2026-11-30' });
      expect(r.weeks).toBe(0);
    }
    expect(lastWeekGraded(calls, 'nba', undefined, 0, '2026-11-30', dateOf).last.state).not.toBe('before');
  });
});

describe("the week's chances in the log", () => {
  it('are one entry a category, each within the log’s rule, for nine categories and for more', () => {
    const calls = weekChanceCalls({ ...WEEK, soFar: [2, 1, 0] });
    expect(calls).toHaveLength(11); // nine categories, the Yahoo week, the score so far
    const many = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`z_category_with_a_long_name_${i}`, i / 16]));
    for (const c of [...calls, ...weekChanceCalls({ ...WEEK, league: 'wnba', opponent: 11, chances: many })])
      expect(validCall({ ...c, date: '2026-11-23', build: 'b1', league: IMPORT }), c.subject).not.toBeNull();
  });

  it('read back as each category’s earliest entry, with its key; another opponent or league, and an older line without an import, are not', () => {
    const monday = lines(weekChanceCalls(WEEK), '2026-11-23');
    const tuesday = lines(weekChanceCalls({ ...WEEK, chances: { ...CHANCES, z_points: 0.9 } }), '2026-11-24');
    // an old single call, before the log's present form: no import named
    const old = JSON.stringify({ at: '2026-11-23T10:00:00.000Z', kind: 'call', date: '2026-11-23', call: 'week-chance', subject: 'nba 2026-11-23 vs 2 z_points', value: 0.1, naive: 0.5, build: 'b0' });
    const calls = parseLog([tuesday, old, monday, '{cut short', '{"kind":"page","path":"/"}'].join('\n'));
    expect(calls.every((c) => c.league === IMPORT)).toBe(true);
    const r = weekRecords(calls, 'nba').get('2026-11-23')!;
    expect(r.chances).toEqual(CHANCES);
    expect(r).toMatchObject({ opponent: 2, week: 9, date: '2026-11-23', soFar: null });
    expect(Object.keys(r.keys).sort()).toEqual(Object.keys(CHANCES).sort());
    expect(new Set(Object.values(r.keys)).size).toBe(9);
    expect(weekRecords(calls, 'wnba').size).toBe(0);
  });

  it('first logged mid-week, keeps that date and the score so far', () => {
    const calls = parseLog(lines(weekChanceCalls({ ...WEEK, soFar: [3, 2, 1] }), '2026-11-25'));
    expect(weekRecords(calls, 'nba').get('2026-11-23')).toMatchObject({ date: '2026-11-25', soFar: [3, 2, 1] });
  });
});

describe('a week graded', () => {
  const record = weekRecords(parseLog(lines(weekChanceCalls(WEEK), '2026-11-23')), 'nba').get('2026-11-23')!;

  it('grades each category against the final totals: right, wrong, a tie and a coin no call', () => {
    const g = gradeWeek(record, WEEK_9, 0);
    const by = Object.fromEntries(g.cats.map((c) => [c.cat, [c.result, c.right]]));
    expect(by).toEqual({
      z_points: ['win', true],
      z_rebounds_total: ['win', false],
      z_assists: ['loss', true],
      z_steals: ['tie', null],
      z_blocks: ['win', null],
      z_three_pointers_made: ['loss', true],
      z_field_goal_pct: ['win', true],
      z_free_throw_pct: ['loss', false],
      z_turnovers: ['loss', true],
    });
    expect(g.cats.every((c) => c.key === record.keys[c.cat])).toBe(true);
    const r = running([g]);
    expect(r).toMatchObject({ weeks: 1, right: 5, made: 7, scored: 8 });
    expect(r.brier).toBeCloseTo([0.3, 0.6, 0.3, 0.5, 0.45, 0.45, 0.8, 0.2].reduce((s, d) => s + d * d, 0) / 8, 10);
  });

  it('names a category with no total, and a team with none, and grades neither as a loss', () => {
    const noBlocks = score({ ...MINE.totals, z_blocks: undefined as unknown as number }, [200, 400], [80, 100]);
    delete (noBlocks.totals as Record<string, number | undefined>)['z_blocks'];
    const g = gradeWeek(record, { ...WEEK_9, teams: [noBlocks, null, THEIRS] }, 0);
    expect(g.cats.find((c) => c.cat === 'z_blocks')).toMatchObject({ missing: 'mine', result: null, right: null });
    const none = gradeWeek(record, { ...WEEK_9, teams: [MINE, null, null] }, 0);
    expect(none.cats.every((c) => c.missing === 'theirs' && c.result === null && c.right === null)).toBe(true);
    expect(running([none])).toMatchObject({ made: 0, scored: 0, brier: null });
  });

  it('on the card: last week graded, not imported (with its Yahoo week), or with no chances logged', () => {
    const calls = parseLog(lines(weekChanceCalls(WEEK), '2026-11-23'));
    const source = { host: 'yahoo', syncedAt: Date.parse('2026-11-30T15:00:00Z'), weeks: [WEEK_9, { week: 10, final: false, teams: [] }] } as unknown as LeagueSource;
    expect(lastWeekGraded(calls, 'nba', source, 0, '2026-11-30', dateOf).last.state).toBe('graded');
    const notYet = { ...source, weeks: [{ week: 9, final: false, teams: [] }] } as unknown as LeagueSource;
    expect(lastWeekGraded(calls, 'nba', notYet, 0, '2026-11-30', dateOf).last).toMatchObject({ state: 'not-imported', yahooWeek: 9 });
    expect(lastWeekGraded([], 'nba', source, 0, '2026-11-30', dateOf).last).toEqual({ state: 'none', monday: '2026-11-23' });
    // a week before the first graded one is never graded, even with entries
    const early = parseLog(lines(weekChanceCalls({ ...WEEK, monday: '2026-11-16', week: 8 }), '2026-11-16'));
    expect(lastWeekGraded(early, 'nba', { ...source, weeks: [{ ...WEEK_9, week: 8 }] } as LeagueSource, 0, '2026-11-30', dateOf).running.weeks).toBe(0);
  });

  it('keeps a running record over every graded week', () => {
    const w2 = { ...WEEK, monday: '2026-11-30', week: 10 };
    const calls = parseLog([lines(weekChanceCalls(WEEK), '2026-11-23'), lines(weekChanceCalls(w2), '2026-11-30')].join('\n'));
    const source = { host: 'yahoo', syncedAt: 0, weeks: [WEEK_9, { ...WEEK_9, week: 10 }] } as unknown as LeagueSource;
    expect(lastWeekGraded(calls, 'nba', source, 0, '2026-12-07', dateOf).running).toMatchObject({ weeks: 2, right: 10, made: 14 });
  });
});

describe('the Yahoo week and the score so far', () => {
  it('counts the week from the import’s unfinished one', () => {
    const source = { host: 'yahoo', syncedAt: Date.parse('2026-11-25T15:00:00Z'), weeks: [{ week: 9, final: false, teams: [] }] } as unknown as LeagueSource;
    expect(yahooWeekOf(source, '2026-11-23', dateOf)).toBe(9);
    expect(yahooWeekOf(source, '2026-11-30', dateOf)).toBe(10);
    expect(yahooWeekOf(undefined, '2026-11-23', dateOf)).toBeNull();
  });

  it('tallies categories won, lost and tied', () => {
    expect(soFarTally(['z_points', 'z_steals', 'z_turnovers'], MINE, THEIRS)).toEqual([1, 1, 1]);
    expect(soFarTally(['z_points'], MINE, null)).toBeNull();
  });
});
