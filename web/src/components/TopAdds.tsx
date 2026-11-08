/**
 * Pickups leads with the answer (#819): the top three adds for the manager's league in the window,
 * each with why in one line and who to drop from the roster review, the full table one click down.
 */
import { useState } from 'react';

import type { League } from '../lib/data';
import { CATEGORY_LABELS, fmt } from '../lib/format';
import type { TopAdd } from '../lib/pickups-top';
import { href } from '../lib/site';
import type { PlayerNotes } from '../lib/player-notes';
import type { Candidate } from './PickupsTable';
import { PlayerNoteLine } from './PlayerNoteLine';
import { Unvalidated } from './ui';

/** Where the roster review stands: no league rosters, still loading, ready, no team of the manager's own, or failed. */
export type ReviewState = 'no-rosters' | 'loading' | 'ready' | 'no-team' | 'failed';

const label = (c: string) => CATEGORY_LABELS[c] ?? c;
const link = 'font-medium underline-offset-4 hover:underline';
const button = 'rounded border border-line px-2 py-0.5 text-xs hover:bg-bg';

/** The reasons in one line: games in the window and on the open days, minutes, a teammate out, categories. */
function whyLine(a: TopAdd<Candidate>, windowText: string): string {
  const games = `${a.games} ${a.games === 1 ? 'game' : 'games'} ${windowText}${a.openGames === null ? '' : `, ${a.openGames} on your open days`}`;
  const trend = a.minutesTrend;
  const minutes = trend === null ? null : `minutes ${trend > 0 ? 'up' : 'down'} ${fmt(Math.abs(trend), 1)} a game over the last five`;
  const out = a.teammateOut ? `${a.teammateOut} out next game` : null;
  const helps = a.helps.length ? `helps ${a.helps.map(label).join(', ')}` : null;
  return [games, minutes, out, helps].filter(Boolean).join(' · ');
}

export function TopAdds({
  adds,
  league,
  windowText,
  context,
  review,
  dropsLeft,
  nameOf,
  detailOf,
  onApply,
  onExplore,
  openDays,
  notes,
}: {
  adds: TopAdd<Candidate>[];
  league: League;
  /** "in the next 7 days", "left this week", "from Mon, Nov 9 to Fri, Nov 13". */
  windowText: string;
  /** How they were ranked and who counts as available, in a line. */
  context: string;
  review: ReviewState;
  /** Whether the drop rule lets any of the manager's players go. */
  dropsLeft: boolean;
  nameOf: (id: string) => string;
  detailOf: (id: string) => string;
  onApply: (add: string, drop: string) => void;
  onExplore: () => void;
  /** Open days are picked: the adds must play on one. */
  openDays: boolean;
  /** The day's one-line notes on flagged players (#823). */
  notes?: PlayerNotes | null;
}) {
  const [applied, setApplied] = useState<{ add: string; drop: string } | null>(null);
  const player = (id: string, name: string) => (
    <a href={href(`/p/${league}/${id}/`)} className={link}>
      {name}
    </a>
  );
  const dropLine = (a: TopAdd<Candidate>) => {
    if (review === 'no-rosters') return null;
    if (review === 'loading') return <span className="text-muted">Working out who to drop…</span>;
    if (review === 'failed') return <span className="text-muted">Who to drop could not be worked out: the board did not load.</span>;
    if (review === 'no-team') return <span className="text-muted">Add your own roster on the League page to see who to drop.</span>;
    if (!a.drop) {
      return (
        <span className="text-muted">
          {dropsLeft
            ? 'No drop keeps every position on your roster covered for this add.'
            : 'No drop: the drop rule keeps everyone on your roster (a starter is a trade, not a drop).'}
        </span>
      );
    }
    const drop = a.drop;
    const add = a.row.player_id;
    return (
      <>
        <span>
          <span className="text-muted">Drop </span>
          {player(drop, nameOf(drop))}
          {detailOf(drop) ? <span className="text-muted"> ({detailOf(drop)})</span> : null}
        </span>
        <button
          type="button"
          className={button}
          onClick={() => {
            onApply(add, drop);
            setApplied({ add, drop });
          }}
          data-testid="top-add-apply"
        >
          Apply
        </button>
      </>
    );
  };
  return (
    <section id="top-adds" className="min-w-0 rounded-lg border border-line bg-card p-4" aria-labelledby="top-adds-h" data-testid="top-adds">
      <h2 id="top-adds-h" className="text-sm font-medium tracking-wide text-muted uppercase">
        Top 3 adds for your league {windowText}
        <Unvalidated issue={762} what="The window value" />
      </h2>
      <p className="mt-1 text-xs text-muted" data-testid="top-adds-context">
        {context}{' '}
        <button type="button" className="text-accent underline-offset-4 hover:underline" onClick={onExplore} data-testid="top-adds-change">
          Change the window, open days or needs
        </button>
      </p>
      {adds.length === 0 ? (
        <p className="mt-2 text-sm" data-testid="top-adds-none">
          No available player has a game {windowText}
          {openDays ? ' on your open days' : ''}. Try a longer window below.
        </p>
      ) : (
        <ol className="mt-2 grid gap-3">
          {adds.map((a, i) => (
            <li key={a.row.player_id} className="min-w-0" data-testid="top-add" data-player={a.row.player_id}>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-muted tabular-nums">{i + 1}.</span>
                {player(a.row.player_id, a.row.full_name ?? a.row.player_id)}
                <span className="text-xs text-muted">{[a.row.position, a.row.team_abbreviation].filter(Boolean).join(' · ')}</span>
                <span className="text-xs text-muted" title="The window value: last-ten production per game times games in the window, plus each game's matchup">
                  window value {fmt(a.row.window_value, 1)}
                </span>
              </div>
              <p className="mt-0.5 text-sm" data-testid="top-add-why">
                {whyLine(a, windowText)}
              </p>
              <PlayerNoteLine notes={notes} row={a.row} />
              {review !== 'no-rosters' && (
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-testid="top-add-drop">
                  {dropLine(a)}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      {review === 'no-rosters' ? (
        <p className="mt-3 text-xs text-muted" data-testid="top-adds-rosters">
          Enter your league on the{' '}
          <a href={href(`/league/?league=${league}`)} className="underline underline-offset-4">
            League page
          </a>{' '}
          to see who to drop for each, and to leave out exactly the players already on a team.
        </p>
      ) : (
        <p className="mt-3 text-xs text-muted">
          The drop is the player{' '}
          <a href={href(`/team/?league=${league}#upgrades`)} className="underline underline-offset-4" data-testid="top-adds-moves">
            My Team&apos;s moves
          </a>{' '}
          would let go first, never a starter the drop rule keeps. Apply records the swap in the league kept here; make it in your league&apos;s app too.
        </p>
      )}
      {applied && (
        <p className="mt-2 text-sm" role="status" data-testid="top-add-applied">
          Recorded: {nameOf(applied.add)} in, {nameOf(applied.drop)} out.{' '}
          <a href={href(`/team/?league=${league}`)} className="font-medium text-accent underline underline-offset-4">
            See My Team →
          </a>
        </p>
      )}
    </section>
  );
}
