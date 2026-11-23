/**
 * Last week, graded (#1058), on My Team for the signed-in owner with his preview on: each
 * category's chance at the week's start against what happened, the running record over the
 * graded weeks, and every preview call the log holds for the week, graded or saying why not, each
 * tied to its log entry by the entry's key. Until the first week is graded it says when the first
 * grade comes and shows no grade.
 */
import { useEffect, useState } from 'react';

import { fetchCurrentJson, type League } from '../lib/data';
import type { LeagueSetup } from '../lib/fantasy-league';
import { CATEGORY_LABELS, fmt } from '../lib/format';
import { COIN_BRIER, gradingStarts, lastWeekGraded, parseLog, type CategoryGrade, type Running, weekFor } from '../lib/graded';
import { type CallGrade, gradeCalls, parseImports, type PlayerWeek } from '../lib/graded-calls';
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
  'trade-nearest': 'The players worth about the same',
  'trade-finder': 'The trade finder',
  'sell-high': 'Sell high',
  'trade-chips': 'Trade chips',
};
const callName = (call: string) => CALL_NAMES[call] ?? call;
const ROLE: Record<string, string> = { add: 'add', drop: 'drop', give: 'give', get: 'get', keep: 'keep', named: '' };

function RunningLine({ r }: { r: Running }) {
  return (
    <div className="mt-3 border-t border-line pt-2 text-sm" data-testid="graded-running">
      {r.weeks === 0 ? (
        <p>Running record: no week graded yet.</p>
      ) : (
        <p>
          Running record over {r.weeks} {r.weeks === 1 ? 'week' : 'weeks'}:{' '}
          <strong>
            {r.right} of {r.made} category calls right
          </strong>
          {r.brier !== null && (
            <>
              {' · '}Brier score <strong>{fmt(r.brier, 3)}</strong> over {r.scored} {r.scored === 1 ? 'category' : 'categories'} won or lost, against a
              coin&apos;s {fmt(COIN_BRIER, 2)} (lower is better)
            </>
          )}
          .
        </p>
      )}
      <p className="mt-1 text-xs text-muted">
        A call is the side a chance favours. A 50% chance, a category tied, or one with no total is no call. The Brier score is the mean of (chance −
        result)² over the categories won or lost, a win counting 1 and a loss 0; a coin&apos;s 50% scores 0.25 on every one.
      </p>
    </div>
  );
}

/** Both sides' final totals, "520–500", a percentage's to a tenth with one sign: "50.0–45.0%"; "no total" for a missing side. */
function finals(c: CategoryGrade): string {
  const one = (v: number | null) => (v === null ? 'no total' : isRatio(c.cat) ? (v * 100).toFixed(1) : showTotal(c.cat, v));
  return `${one(c.mine)}–${one(c.theirs)}${isRatio(c.cat) && c.mine !== null && c.theirs !== null ? '%' : ''}`;
}

function Categories({ cats, them }: { cats: CategoryGrade[]; them: string }) {
  const missing = cats.filter((c) => c.missing);
  const who = (m: CategoryGrade['missing']) => (m === 'mine' ? 'you' : m === 'theirs' ? them : `you and ${them}`);
  return (
    <>
      <div className="table-scroll mt-2 overflow-auto" tabIndex={0} role="region" aria-label="Last week, category by category">
        <table className="w-full text-sm" data-testid="graded-table">
          <thead>
            <tr>
              <Th>Category</Th>
              <Th right>Chance at the start</Th>
              <Th right>
                Final<span className="sr-only">: you, then {them}</span>
              </Th>
              <Th>Result</Th>
            </tr>
          </thead>
          <tbody>
            {cats.map((c) => (
              <tr key={c.cat} className="border-t border-line" data-testid="graded-row" data-cat={c.cat} data-key={c.key}>
                <Td>{label(c.cat)}</Td>
                <Td right>{pct(c.chance)}</Td>
                <Td right>
                  <span data-testid="graded-final">{finals(c)}</span>
                </Td>
                <Td>
                  <span className={`text-xs font-semibold uppercase ${tone(c.result)}`} data-testid="graded-result">
                    {c.result ? RESULT[c.result] : 'not graded'}
                  </span>
                  <span className={`block text-xs ${c.right === null ? 'text-muted' : ''}`} data-testid="graded-call">
                    {c.missing ? `no total for ${who(c.missing)}` : c.right === null ? 'no call' : c.right ? 'call right' : 'call wrong'}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {missing.length > 0 && (
        <p className="mt-1 text-xs text-warn" data-testid="graded-missing">
          Yahoo&apos;s week holds no total for {missing.map((c) => `${label(c.cat)} (${who(c.missing)})`).join(', ')}: {missing.length === 1 ? 'it is' : 'they are'}{' '}
          left ungraded, not counted as a loss.
        </p>
      )}
    </>
  );
}

/** A player's week in a line: "3 games of 4 · 54 PTS · 21 REB … · FG 20/41 · FT 7/9", or that he did not play. */
function weekLine(w: PlayerWeek | null): string {
  if (!w || w.games_played === 0) return w ? `did not play (${w.games_scheduled} ${w.games_scheduled === 1 ? 'game' : 'games'} scheduled)` : 'did not play that week';
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

function CallLine({ g, nameOf, them }: { g: CallGrade; nameOf: (id: string) => string; them: (t: number) => string }) {
  const e = g.entry;
  const said = `${e.subject}: ${e.value}`;
  return (
    <li className="min-w-0 border-t border-line py-1.5 first:border-t-0" data-testid="graded-call-line" data-call={e.call} data-key={e.key} data-kind={g.kind}>
      <p className="break-words">
        <span className="text-muted">{weekday(e.date)} said</span> <span data-testid="graded-said">{said}</span>
      </p>
      {g.kind === 'players' && (
        <>
          <ul className="ml-4 list-disc">
            {g.players.map((p) => (
              <li key={`${p.role}:${p.id}`} className="break-words">
                {nameOf(p.id)}
                {ROLE[p.role] ? ` (${ROLE[p.role]})` : ''}: {weekLine(p.line)}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted" data-testid="graded-naive">
            The naive manager: {g.keeps.length ? `no move, keeping ${g.keeps.map(nameOf).join(' and ')}` : 'no move'}.
            {g.leftOut > 0 && ` ${g.leftOut} more ${g.leftOut === 1 ? 'player' : 'players'} the entry left out to fit the log: not graded.`}
          </p>
        </>
      )}
      {g.kind === 'categories' && (
        <p data-testid="graded-happened">
          Against {them(g.opponent)}:{' '}
          {g.cats.length === 0
            ? 'no category was called too close.'
            : g.cats.map((c) => `${label(c.cat)} ${c.result ? RESULT[c.result] : 'not graded (no total)'}`).join(', ')}
          {g.leftOut > 0 && `; ${g.leftOut} more left out of the entry, not graded`}.{' '}
          <span className="text-muted">The naive manager&apos;s call: {e.naive ?? 'none'}.</span>
        </p>
      )}
      {g.kind === 'lineup' && (
        <p data-testid="graded-happened">
          Counted <strong>{g.counted} starts</strong>; the {g.roster} players on the roster played <strong>{g.played} games</strong> that week, before
          any lineup limit.{e.naive !== null && <span className="text-muted"> The naive manager&apos;s lineup as set: {e.naive}.</span>}
        </p>
      )}
      {g.kind === 'not-graded' && (
        <p className="text-muted" data-testid="graded-why">
          Not graded: {g.why}.
        </p>
      )}
    </li>
  );
}

function PreviewCalls({ grades, nameOf, them }: { grades: CallGrade[]; nameOf: (id: string) => string; them: (t: number) => string }) {
  const kinds = [...new Set(grades.map((g) => g.entry.call))];
  const graded = grades.filter((g) => g.kind !== 'not-graded').length;
  return (
    <div className="mt-3 border-t border-line pt-2" data-testid="graded-calls">
      <h3 className="text-sm font-semibold">The preview&apos;s calls last week</h3>
      <p className="text-sm" data-testid="graded-calls-count">
        {grades.length} {grades.length === 1 ? 'call' : 'calls'} logged that week: {graded} graded, {grades.length - graded} not graded, each saying why.
      </p>
      {kinds.map((call) => {
        const of = grades.filter((g) => g.entry.call === call);
        return (
          <details key={call} className="mt-1 text-sm" data-testid="graded-kind" data-call={call}>
            <summary className="cursor-pointer">
              {callName(call)}: {of.length} {of.length === 1 ? 'call' : 'calls'}
            </summary>
            <ul className="mt-1">
              {of.map((g) => (
                <CallLine key={g.entry.key} g={g} nameOf={nameOf} them={them} />
              ))}
            </ul>
          </details>
        );
      })}
      <p className="mt-1 text-xs text-muted">A player&apos;s week runs Monday to Sunday, the days before the call was shown included.</p>
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
    // an older build without the file grades no player call yet
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
    if (log === 'loading' || weeks === 'loading') return <p className="mt-1 text-sm text-muted">Reading your log…</p>;
    if (log === null) return <p className="mt-1 text-sm text-muted">Your log could not be read just now; the grade shows on the next visit.</p>;
    const calls = parseLog(log);
    const { last, running } = lastWeekGraded(calls, league, setup.source, setup.mine, today, dateOf);
    if (last.state === 'before') return null;
    const them = (t: number) => setup.names[t] ?? `Team ${t + 1}`;
    const record = last.state === 'graded' ? last.grade.record : last.state === 'not-imported' ? last.record : null;
    const week = last.state === 'graded' ? last.grade.week : record ? weekFor(record, setup.source, dateOf) : null;
    const grades = gradeCalls(calls, last.monday, weeks, week, parseImports(log), setup.mine);
    return (
      <>
        {last.state === 'none' && (
          <p className="mt-1 text-sm" data-testid="graded-none">
            No chances were logged for the week of Monday, {day(last.monday)}: My Team did not show you that week&apos;s matchup with your preview on.
          </p>
        )}
        {last.state === 'not-imported' && (
          <p className="mt-1 text-sm" data-testid="graded-import">
            The week of Monday, {day(last.monday)}
            {last.yahooWeek !== null ? ` (Yahoo's week ${last.yahooWeek})` : ''} is not in your import with its final totals, so its chances against{' '}
            {them(last.record.opponent)} are not graded yet.{' '}
            <a href={href('/league/#yahoo')} className="font-medium text-accent underline-offset-4 hover:underline" data-testid="graded-import-link">
              Import from Yahoo
            </a>{' '}
            after the week ends to grade it.
          </p>
        )}
        {last.state === 'graded' && (
          <>
            <p className="mt-1 text-sm" data-testid="graded-summary">
              The week of Monday, {day(last.monday)} against {them(last.grade.record.opponent)}:{' '}
              <strong>
                {last.grade.cats.filter((c) => c.right).length} of {last.grade.cats.filter((c) => c.right !== null).length} category calls right
              </strong>
              .{' '}
              {last.grade.record.date === last.monday ? (
                <span className="text-muted">Each chance is the first My Team showed you on the Monday, against the week&apos;s final totals.</span>
              ) : (
                <span className="text-muted" data-testid="graded-midweek">
                  The chances were first logged mid-week, on {weekday(last.grade.record.date)}
                  {last.grade.record.soFar ? `, with the score so far ${last.grade.record.soFar.join('–')} in categories won, lost and tied` : ''}.
                </span>
              )}
            </p>
            <Categories cats={last.grade.cats} them={them(last.grade.record.opponent)} />
          </>
        )}
        <RunningLine r={running} />
        {grades.length > 0 && <PreviewCalls grades={grades} nameOf={nameOf} them={them} />}
      </>
    );
  };

  return (
    <section className="min-w-0 rounded-lg border border-line bg-card p-3" aria-labelledby="graded-h" data-testid="graded">
      <h2 id="graded-h" className="label-caps">
        Last week, graded
      </h2>
      <p className="mt-1 text-xs text-muted">
        Shown to you alone, with your preview on, from your private log: the chances My Team gave each category against what happened.
      </p>
      {body()}
    </section>
  );
}
