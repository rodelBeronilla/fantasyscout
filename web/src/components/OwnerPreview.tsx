/**
 * The owner preview's frame (#1056): a call a switch hides (visibility.ts), shown to the signed-in
 * owner alone under "Preview: not validated", exactly as it would render with its switch on. Log
 * first, then show: the frame shows its calls only once the log has acknowledged holding them, so
 * "each one shown is logged" holds whenever the page is left. Until then it says they are being
 * logged, and its content is laid out but invisible and inert (#1137): it keeps its place, so the
 * tiles below do not jump when it shows and a second tap lands where the first did. If the log
 * refuses the calls, or does not answer in time, the frame says so and does not show them.
 */
import { type ReactNode, useEffect, useState } from 'react';

import type { LeagueSetup } from '../lib/fantasy-league';
import { type addsThisWeek, addsWeekLine } from '../lib/league-sync';
import { LOG_TIMEOUT_MS } from '../lib/owner-log';
import { limitsKnown, logBeforeShowing, type PreviewCall } from '../lib/owner-preview';
import { href, REPO_URL } from '../lib/site';

export function OwnerPreview({
  id,
  what,
  issue,
  league,
  call,
  children,
}: {
  /** Unique on the page: the frame's heading id is built from it. */
  id: string;
  /** What the call is, for the frame's accessible name: "the week's lineup plan". */
  what: string;
  /** The issue the switch's comment names, where the call's check is written. */
  issue: number;
  /** The league's import the calls are made for (importOf), part of each call's key in the log. */
  league: string;
  /**
   * What is logged: one entry per call shown (one per trade, add or player in a list). Null while
   * the call is not ready: nothing is shown. An empty list when the frame holds no call yet (a
   * search not yet run): its contents, a button, show.
   */
  call: PreviewCall | PreviewCall[] | null;
  children: ReactNode;
}) {
  const ready = call !== null;
  const calls = call === null ? [] : Array.isArray(call) ? call : [call];
  const key = JSON.stringify([league, calls]);
  // what the log said of these calls: not yet, all held, or how many it did not take, and whether it did not answer in time
  const [state, setState] = useState<{ key: string; missing: number; late: boolean } | null>(null);
  useEffect(() => {
    if (calls.length === 0) return;
    let live = true;
    const asked = logBeforeShowing(calls, league);
    void asked.done.then(
      (said) => live && setState({ key, missing: said.filter((r) => r !== 'held').length, late: said.includes('timeout') }),
    );
    return () => {
      live = false;
      asked.cancel();
    };
    // the calls are logged by what they say, not on every render
  }, [key]);
  const answer = !ready ? null : calls.length === 0 ? { missing: 0, late: false } : state?.key === key ? state : null;
  const one = calls.length === 1;
  const shown = answer?.missing === 0;
  const seconds = Math.round(LOG_TIMEOUT_MS / 1000);
  const logging = !ready || one ? 'Logging this call before it is shown.' : `Logging these ${calls.length} calls before they are shown.`;
  const logged = 'each one shown is logged.';
  return (
    <section
      className="min-w-0 rounded-lg border border-dashed border-line p-3"
      aria-labelledby={`${id}-preview-h`}
      data-testid="owner-preview"
      data-call={calls[0]?.call ?? id}
    >
      <h2 id={`${id}-preview-h`} className="label-caps">
        Preview: not validated<span className="sr-only">: {what}</span>
      </h2>
      <p className="mt-1 text-xs text-muted">
        Shown to you alone. This call has not passed its check (see{' '}
        <a href={href('/methodology/')} className="underline underline-offset-4">
          Methodology
        </a>
        );{' '}
        <span className="inline-grid">
          {/* the other wording's room, from a pseudo-element out of the page's text: the line keeps its height when the frame shows (#1137) */}
          {(answer === null || shown) && (
            <span aria-hidden className="invisible [grid-area:1/1] before:content-[attr(data-room)]" data-room={answer === null ? logged : logging} />
          )}
          <span aria-live="polite" className="[grid-area:1/1]">
          {answer === null ? (
            <span data-testid="preview-logging">{logging}</span>
          ) : answer.missing === 0 ? (
            logged
          ) : (
            <strong data-testid="preview-not-logged">
              {answer.late
                ? `The log did not answer within ${seconds} seconds, so ${one ? 'this call is' : 'these calls are'} not shown: ${one ? 'it is' : 'they are'} tried again the next time this page opens.`
                : one
                  ? 'This call could not be logged, so it is not shown: it is tried again the next time this page opens.'
                  : `${answer.missing} of these ${calls.length} calls could not be logged, so none is shown: they are tried again the next time this page opens.`}
            </strong>
          )}
          </span>
        </span>{' '}
        <a href={`${REPO_URL}/issues/${issue}`} target="_blank" rel="noopener" className="underline underline-offset-4">
          Issue #{issue}
        </a>
      </p>
      {/* laid out while it is logged, so it keeps its place; shown only once the log holds it; gone if it cannot be logged */}
      {(answer === null || shown) && (
        <div
          className={`mt-2 grid grid-cols-[minmax(0,1fr)] gap-3 ${shown ? '' : 'invisible'}`}
          inert={!shown}
          aria-hidden={shown ? undefined : true}
          data-testid="preview-content"
          data-shown={shown ? 'yes' : 'no'}
        >
          {children}
        </div>
      )}
    </section>
  );
}

/**
 * The limits a preview of pickups works within (#1056): the adds left this week, said in the Today
 * card's own words (addsWeekLine) so the two cannot disagree, and the league's waiver wait. The
 * site does not know who was dropped lately, so the wait is said, not applied.
 */
export function AddsLimit({
  setup,
  adds,
  kind = 'offer',
}: {
  setup: Pick<LeagueSetup, 'addsPerWeek' | 'waiverDays' | 'source'>;
  /** This week's adds (addsThisWeek); null when the league sets no limit. */
  adds: ReturnType<typeof addsThisWeek>;
  /** What the frame's moves are: adds it offers, add-and-drop lines (Build your team), or open slots to stream into (the lineup plan). */
  kind?: 'offer' | 'lines' | 'slots';
}) {
  const known = limitsKnown(setup);
  const waiverDays = setup.waiverDays;
  const host = setup.source?.host;
  const app = host === 'yahoo' ? 'Yahoo' : host === 'espn' ? 'ESPN' : "your league's app";
  const left = adds?.left ?? 0;
  return (
    <p className="text-sm" data-testid="preview-adds-limit">
      {!known.adds ? (
        <>
          <strong>This league&apos;s adds a week is not known here</strong>
          <span className="text-muted">
            {' '}
            (this copy was imported before the bookmark read Yahoo&apos;s settings page): set it on the League page or import the league again from Yahoo. Until
            then, check the adds you have left on {app} before a move below.
          </span>
        </>
      ) : adds === null ? (
        'Your league sets no weekly limit on adds.'
      ) : (
        <>
          <strong data-testid="preview-adds-line">{addsWeekLine(adds)}</strong>.{' '}
          {left > 0
            ? kind === 'lines'
              ? `Each add-and-drop line below uses one, so make no more than ${left} of them.`
              : kind === 'slots'
                ? `Each stream into an open slot uses one, so no more than ${left} ${left === 1 ? 'slot' : 'slots'} can be filled this way.`
                : `No more than ${left} ${left === 1 ? 'is' : 'are'} offered.`
            : kind === 'lines'
              ? 'The add-and-drop lines below wait until Monday.'
              : kind === 'slots'
                ? 'The open slots below stay open until Monday.'
                : 'The next one comes on Monday.'}
          {/* a count that is not the host's own can only overcount what is left */}
          {left > 0 && adds.from !== 'yahoo' && <> Check the adds you have left on {app} before a move below.</>}
        </>
      )}
      {waiverDays ? (
        <span className="text-muted">
          {' '}
          A player dropped in the last {waiverDays} {waiverDays === 1 ? 'day' : 'days'} is on waivers and cannot be added yet. This list does not know who was
          dropped, so check each player is a free agent on {app} first.
        </span>
      ) : !known.waiver ? (
        <span className="text-muted">
          {' '}
          The waiver wait is not known here{known.adds ? '' : ' either'}: check each player is a free agent on {app} first.
        </span>
      ) : null}
    </p>
  );
}
