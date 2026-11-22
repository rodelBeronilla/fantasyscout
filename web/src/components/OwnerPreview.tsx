/**
 * The owner preview's frame (#1056): a call a switch hides (visibility.ts), shown to the signed-in
 * owner alone under "Preview: not validated", exactly as it would render with its switch on. The
 * frame logs each call it shows to his private log once a page view, once it has stayed on screen
 * unchanged for SETTLE_MS, and says so plainly when the log refused one.
 */
import { type ReactNode, useEffect, useState } from 'react';

import type { LeagueSetup } from '../lib/fantasy-league';
import { type addsThisWeek, addsWeekLine } from '../lib/league-sync';
import { limitsKnown, logPreviewCall, type PreviewCall, callKey } from '../lib/owner-preview';
import { href, REPO_URL } from '../lib/site';

// def: how long a frame shows the same calls before they are logged: a call drawn while its data is still arriving is replaced before he can read it
const SETTLE_MS = 2000;

export function OwnerPreview({
  id,
  what,
  issue,
  call,
  children,
}: {
  /** Unique on the page: the frame's heading id is built from it. */
  id: string;
  /** What the call is, for the frame's accessible name: "the week's lineup plan". */
  what: string;
  /** The issue the switch's comment names, where the call's check is written. */
  issue: number;
  /** What is logged: one entry per call shown (one per trade, add or player in a list); null while it has nothing to show (a search not yet run). */
  call: PreviewCall | PreviewCall[] | null;
  children: ReactNode;
}) {
  const calls = call === null ? [] : Array.isArray(call) ? call : [call];
  const key = JSON.stringify(calls.map(callKey));
  // how many of the calls shown the log refused or could not take
  const [refused, setRefused] = useState(0);
  useEffect(() => {
    setRefused(0);
    if (calls.length === 0) return;
    let live = true;
    const timer = setTimeout(() => {
      void Promise.all(calls.map((c) => logPreviewCall(c))).then((ok) => live && setRefused(ok.filter((x) => !x).length));
    }, SETTLE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // the calls are logged by what they say, not on every render
  }, [key]);
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
        {refused === 0 ? (
          'each one shown is logged.'
        ) : (
          <strong data-testid="preview-not-logged">
            {calls.length === 1 ? 'This call was not logged: it is' : `${refused} of these ${calls.length} calls were not logged: they are`} tried again the next time
            this page opens.
          </strong>
        )}{' '}
        <a href={`${REPO_URL}/issues/${issue}`} target="_blank" rel="noopener" className="underline underline-offset-4">
          Issue #{issue}
        </a>
      </p>
      <div className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-3">{children}</div>
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
