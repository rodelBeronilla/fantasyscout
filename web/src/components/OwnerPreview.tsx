/**
 * The owner preview's frame (#1056): a call a switch hides (visibility.ts), shown to the signed-in
 * owner alone under "Preview: not validated", exactly as it would render with its switch on. The
 * frame logs the call to his private log once a page view, when it is shown.
 */
import { type ReactNode, useEffect } from 'react';

import { logPreviewCall, type PreviewCall, callKey } from '../lib/owner-preview';
import { href, REPO_URL } from '../lib/site';

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
  /** What is logged; null while the call has nothing to show (a search not yet run). */
  call: PreviewCall | null;
  children: ReactNode;
}) {
  const key = call ? callKey(call) : null;
  useEffect(() => {
    if (call) void logPreviewCall(call);
    // the call is logged by what it says, not on every render
  }, [key]);
  return (
    <section
      className="min-w-0 rounded-lg border border-dashed border-line p-3"
      aria-labelledby={`${id}-preview-h`}
      data-testid="owner-preview"
      data-call={call?.call ?? id}
    >
      <h2 id={`${id}-preview-h`} className="label-caps">
        Preview: not validated<span className="sr-only">: {what}</span>
      </h2>
      <p className="mt-1 text-xs text-muted">
        Shown to you alone. This call has not passed its check (see{' '}
        <a href={href('/methodology/')} className="underline underline-offset-4">
          Methodology
        </a>
        ); each one shown is logged.{' '}
        <a href={`${REPO_URL}/issues/${issue}`} target="_blank" rel="noopener" className="underline underline-offset-4">
          Issue #{issue}
        </a>
      </p>
      <div className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-3">{children}</div>
    </section>
  );
}

/**
 * The limits a preview of pickups works within (#1056): the adds left this week, and the league's
 * waiver wait. The site does not know who was dropped lately, so the wait is said, not applied.
 */
export function AddsLimit({
  adds,
  waiverDays,
  known = { adds: true, waiver: true },
  kind = 'offer',
}: {
  adds: { limit: number; left: number } | null;
  waiverDays: number | null;
  /** Whether the adds a week and the waiver wait are known (limitsKnown): an old Yahoo copy may hold neither. */
  known?: { adds: boolean; waiver: boolean };
  /** What the frame's moves are: adds it offers, add-and-drop lines (Build your team), or open slots to stream into (the lineup plan). */
  kind?: 'offer' | 'lines' | 'slots';
}) {
  const left = adds?.left ?? 0;
  const of = adds ? `${adds.left} of ${adds.limit} adds left this week` : '';
  return (
    <p className="text-sm" data-testid="preview-adds-limit">
      {!known.adds ? (
        <>
          <strong>This league&apos;s adds a week is not known here</strong>
          <span className="text-muted">
            {' '}
            (this copy was imported before the bookmark read Yahoo&apos;s settings page): set it on the League page or import the league again from Yahoo. Until
            then, check the adds you have left on your league&apos;s app before a move below.
          </span>
        </>
      ) : adds === null ? (
        'Your league sets no weekly limit on adds.'
      ) : left > 0 ? (
        <>
          <strong>{of}</strong>
          {kind === 'lines'
            ? `: each add-and-drop line below uses one, so make no more than ${left} of them.`
            : kind === 'slots'
              ? `: each stream into an open slot uses one, so no more than ${left} ${left === 1 ? 'slot' : 'slots'} can be filled this way.`
              : `, so no more than ${left} ${left === 1 ? 'is' : 'are'} offered.`}
        </>
      ) : (
        <strong>
          {kind === 'lines'
            ? 'No adds left this week: the add-and-drop lines below wait until Monday.'
            : kind === 'slots'
              ? 'No adds left this week: the open slots below stay open until Monday.'
              : 'No adds left this week: the next one comes on Monday.'}
        </strong>
      )}
      {waiverDays ? (
        <span className="text-muted">
          {' '}
          A player dropped in the last {waiverDays} {waiverDays === 1 ? 'day' : 'days'} is on waivers and cannot be added yet. This list does not know who was
          dropped, so check each player is a free agent on your league&apos;s app first.
        </span>
      ) : !known.waiver ? (
        <span className="text-muted"> The waiver wait is not known here either: check each player is a free agent on your league&apos;s app first.</span>
      ) : null}
    </p>
  );
}
