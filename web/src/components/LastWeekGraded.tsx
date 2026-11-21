/**
 * Last week, graded (#1058), on My Team for the signed-in owner alone: each category's chance at
 * the week's start against what happened, the running record over the graded weeks, and the owner
 * preview's calls of the week, graded where the grade is plain. The chances passed their check
 * (ADR 0026), so the card is not behind the preview's switch; it reads the owner's private log.
 */
import { useEffect, useState } from 'react';

import { fetchCurrentJson, type League } from '../lib/data';
import type { LeagueSetup } from '../lib/fantasy-league';
import { CATEGORY_LABELS, fmt } from '../lib/format';
import { COIN_BRIER, gradingStarts, lastWeekGraded, parseLog, type CategoryGrade, type LoggedCall, type Running } from '../lib/graded';
import { type CallGrade, gradeCalls, hasWeek, parseImports, type PlayerWeek, weekCalls } from '../lib/graded-calls';
import { readOwnerLog } from '../lib/graded-log';
import { showTotal } from '../lib/league-weeks';
import { isRatio } from '../lib/matchup';
import { href } from '../lib/site';
import { Td, Th } from './ui';

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
/** "Nov 23". */
const day = (iso: string) => DAY.format(new Date(`${iso}T12:00:00Z`));
/** "Wed, Nov 25". */
const weekday = (iso: string) => WEEKDAY.format(new Date(`${iso}T12:00:00Z`));
const pct = (p: number) => `${Math.round(p * 100)}%`;
const label = (cat: string) => CATEGORY_LABELS[cat] ?? cat;

const RESULT = { win: 'won', loss: 'lost', tie: 'tied' } as const;
const tone = (r: CategoryGrade['result']) => (r === 'win' ? 'text-good' : r === 'loss' ? 'text-bad' : 'text-muted');

/** The owner preview's calls, by the name the log keeps them under. */
const CALL_NAMES: Record<string, string> = {
  'top-adds': 'Top adds',
  stream: 'The stream',
  lineup: 'The lineup plan',
  swaps: 'The paired swaps',
  'too-close': 'The too-close band',
  build: 'Building your team',
  'trade-verdict': "A trade's verdict",
  'trade-suggestions': 'Trade suggestions',
  'trade-nearest': 'The nearest trades',
  'trade-finder': 'The trade finder',
  'sell-high': 'Sell high',
  'trade-chips': 'Trade chips',
};
const callName = (call: string) => CALL_NAMES[call] ?? call;
/** The calls with a plain grade. */
const PLAIN = new Set(['top-adds', 'stream', 'lineup']);

function RunningLine({ r }: { r: Running }) {
  return (
    <div className="mt-3 border-t border-line pt-2 text-sm" data-testid="graded-running">
      {r.weeks === 0 ? (
        <p>Running record: no week graded yet.</p>
      ) : (
        <p>
          Running record over {r.weeks} {r.weeks === 1 ? 'week' : 'weeks'}:{' '}
          <strong>
            {r.right} of {r.made} calls right
          </strong>
          {r.brier !== null && (
            <>
              {' · '}Brier score <strong>{fmt(r.brier, 3)}</strong> against a coin&apos;s {fmt(COIN_BRIER, 2)} (lower is better)
            </>
          )}
          .
        </p>
      )}
      <p className="mt-1 text-xs text-muted">
        A call is the side a chance favours. A 50% chance, or a category tied, is no call. The Brier score is the mean of (chance − result)² over
        the categories won or lost, a win counting 1 and a loss 0; a coin&apos;s 50% scores 0.25 on every one.
      </p>
    </div>
  );
}

/** Both sides' final totals, "520–500", a percentage's to a tenth with one sign: "50.0–45.0%". */
function finals(c: CategoryGrade): string {
  if (c.mine === null || c.theirs === null || !isRatio(c.cat)) return `${showTotal(c.cat, c.mine)}–${showTotal(c.cat, c.theirs)}`;
  return `${(c.mine * 100).toFixed(1)}–${(c.theirs * 100).toFixed(1)}%`;
}

function Categories({ cats, them }: { cats: CategoryGrade[]; them: string }) {
  return (
    <div className="table-scroll mt-2 overflow-auto" tabIndex={0} role="region" aria-label="Last week, category by category">
      <table className="w-full text-sm" data-testid="graded-table">
        <thead>
          <tr>
            <Th>Category</Th>
            <Th right>Chance</Th>
            <Th right>
              Final<span className="sr-only">: you, then {them}</span>
            </Th>
            <Th>Result</Th>
          </tr>
        </thead>
        <tbody>
          {cats.map((c) => (
            <tr key={c.cat} className="border-t border-line" data-testid="graded-row" data-cat={c.cat}>
              <Td>{label(c.cat)}</Td>
              <Td right>{pct(c.chance)}</Td>
              <Td right>
                <span data-testid="graded-final">{finals(c)}</span>
              </Td>
              <Td>
                <span className={`text-xs font-semibold uppercase ${tone(c.result)}`} data-testid="graded-result">
                  {c.result ? RESULT[c.result] : '–'}
                </span>
                <span className={`block text-xs ${c.right === null ? 'text-muted' : ''}`} data-testid="graded-call">
                  {c.right === null ? 'no call' : c.right ? 'call right' : 'call wrong'}
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A player's week in a line: "3 games · 54 PTS · 21 REB … · FG 20/41 · FT 7/9". */
function weekLine(w: PlayerWeek | null): string {
  if (!w) return 'no game that week';
  const n = (v: number) => fmt(v, 0);
  return [
    `${w.games_played} ${w.games_played === 1 ? 'game' : 'games'} of ${w.games_scheduled}`,
    `${n(w.points)} PTS`,
    `${n(w.rebounds_total)} REB`,
    `${n(w.assists)} AST`,
    `${n(w.steals)} STL`,
    `${n(w.blocks)} BLK`,
    `${n(w.three_pointers_made)} 3PM`,
    `${n(w.turnovers)} TO`,
    `FG ${n(w.field_goals_made)}/${n(w.field_goals_attempted)}`,
    `FT ${n(w.free_throws_made)}/${n(w.free_throws_attempted)}`,
  ].join(' · ');
}

function PreviewCalls({ grades, waiting, nameOf }: { grades: CallGrade[] | null; waiting: LoggedCall[]; nameOf: (id: string) => string }) {
  const kinds = [...new Set(waiting.map((c) => c.call))];
  return (
    <div className="mt-3 border-t border-line pt-2" data-testid="graded-calls">
      <h3 className="text-sm font-semibold">The preview&apos;s calls last week</h3>
      <ul className="mt-1 grid gap-1 text-sm">
        {grades === null
          ? kinds.map((call) => (
              <li key={call} data-testid="graded-call-line" data-call={call}>
                {callName(call)}: {PLAIN.has(call) ? "graded once the week's player data is published." : 'not graded: no plain measure yet.'}
              </li>
            ))
          : grades.map((g) =>
              g.kind === 'players' ? (
                <li key={g.call} data-testid="graded-call-line" data-call={g.call}>
                  {callName(g.call)}, from {weekday(g.date)}:
                  <ul className="ml-4 list-disc">
                    {g.players.map((p) => (
                      <li key={`${p.role}:${p.id}`}>
                        {nameOf(p.id)}
                        {g.call === 'stream' ? ` (${p.role})` : ''}: {weekLine(p.line)}
                      </li>
                    ))}
                  </ul>
                </li>
              ) : g.kind === 'lineup' ? (
                <li key="lineup" data-testid="graded-call-line" data-call="lineup">
                  {callName('lineup')}, Monday: counted <strong>{g.counted} starts</strong>; the {g.roster} players on the roster played{' '}
                  <strong>{g.played} games</strong> that week, before any lineup limit.
                </li>
              ) : (
                <li key={g.call} data-testid="graded-call-line" data-call={g.call}>
                  {callName(g.call)}: not graded: {g.why}.
                </li>
              ),
            )}
      </ul>
      {grades !== null && grades.some((g) => g.kind === 'players') && (
        <p className="mt-1 text-xs text-muted">A player&apos;s week runs Monday to Sunday, the days before the call was shown included.</p>
      )}
    </div>
  );
}

export function LastWeekGraded({
  league,
  setup,
  today,
  dateOf,
  nameOf,
}: {
  league: League;
  setup: LeagueSetup;
  /** Today's Eastern date. */
  today: string;
  dateOf: (ms: number) => string;
  nameOf: (id: string) => string;
}) {
  const { week: first, firstGrade } = gradingStarts();
  const before = today < firstGrade;
  const [log, setLog] = useState<string | null | 'loading'>('loading');
  const [weeks, setWeeks] = useState<PlayerWeek[] | null | 'loading'>('loading');
  useEffect(() => {
    if (before) return;
    let live = true;
    void readOwnerLog().then((text) => live && setLog(text));
    // an older build without the file grades no preview call yet
    fetchCurrentJson<PlayerWeek[]>(`player_week/${league}.json`)
      .then((w) => live && setWeeks(Array.isArray(w) ? w : null))
      .catch(() => live && setWeeks(null));
    return () => {
      live = false;
    };
  }, [before, league]);

  const body = () => {
    if (before) {
      return (
        <p className="mt-1 text-sm" data-testid="graded-start">
          Grading starts with the week of Monday, {day(first)}; the first grade shows on Monday, {day(firstGrade)}.
        </p>
      );
    }
    if (log === 'loading') return <p className="mt-1 text-sm text-muted">Reading your log…</p>;
    if (log === null) return <p className="mt-1 text-sm text-muted">Your log could not be read just now; the grade shows on the next visit.</p>;
    const calls = parseLog(log);
    const { last, running } = lastWeekGraded(calls, league, setup.source, setup.mine, today, dateOf);
    if (last.state === 'before') return null;
    const theirName = (t: number) => setup.names[t] ?? `Team ${t + 1}`;
    const previewCalls = weekCalls(calls, last.monday);
    const published = weeks !== 'loading' && weeks !== null && hasWeek(weeks, last.monday);
    const grades = published ? gradeCalls(calls, last.monday, weeks, parseImports(log)) : null;
    return (
      <>
        {last.state === 'none' && (
          <p className="mt-1 text-sm" data-testid="graded-none">
            No chances were recorded for the week of Monday, {day(last.monday)}: My Team did not show you that week&apos;s matchup.
          </p>
        )}
        {last.state === 'not-imported' && (
          <p className="mt-1 text-sm" data-testid="graded-import">
            The chances for the week of Monday, {day(last.monday)} against {theirName(last.record.opponent)} are recorded.{' '}
            <a href={href('/league/#yahoo')} className="font-medium text-accent underline-offset-4 hover:underline" data-testid="graded-import-link">
              Import from Yahoo
            </a>{' '}
            after the week ends to grade it.
          </p>
        )}
        {last.state === 'graded' && (
          <>
            <p className="mt-1 text-sm" data-testid="graded-summary">
              The week of Monday, {day(last.monday)} against {theirName(last.grade.record.opponent)}:{' '}
              <strong>
                {last.grade.cats.filter((c) => c.right).length} of {last.grade.cats.filter((c) => c.right !== null).length} calls right
              </strong>
              .{' '}
              {last.grade.record.date === last.monday ? (
                <span className="text-muted">Each chance is the one My Team showed you on the Monday, against the week&apos;s final totals.</span>
              ) : (
                <span className="text-muted" data-testid="graded-midweek">
                  The chances were recorded mid-week, on {weekday(last.grade.record.date)}
                  {last.grade.record.soFar ? `, with the score so far ${last.grade.record.soFar.join('–')} in categories won, lost and tied` : ''}: the
                  first time My Team showed you the matchup that week.
                </span>
              )}
            </p>
            <Categories cats={last.grade.cats} them={theirName(last.grade.record.opponent)} />
          </>
        )}
        <RunningLine r={running} />
        {previewCalls.length > 0 && <PreviewCalls grades={weeks === 'loading' ? [] : grades} waiting={previewCalls} nameOf={nameOf} />}
      </>
    );
  };

  return (
    <section className="rounded-lg border border-line bg-card p-3" aria-labelledby="graded-h" data-testid="graded">
      <h2 id="graded-h" className="label-caps">
        Last week, graded
      </h2>
      <p className="mt-1 text-xs text-muted">Shown to you alone, from your private log: the chances My Team gave each category against what happened.</p>
      {body()}
    </section>
  );
}
