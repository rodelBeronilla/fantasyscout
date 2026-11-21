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
      <div className="mt-2 grid gap-3">{children}</div>
    </section>
  );
}
