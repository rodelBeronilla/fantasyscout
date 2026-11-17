/**
 * A "Sign in with Yahoo" link that knows where it is: on the preview, which Yahoo will not send a
 * sign-in back to, it says sign-in works on the live site instead of offering a link that fails.
 */
import { useEffect, useState, type ReactNode } from 'react';

import { isPreviewHost, LIVE_SITE } from '../lib/site';

export function SignInLink({ to, className, testId, children }: { to: string; className: string; testId?: string; children: ReactNode }) {
  // decided after the first render, so the page built ahead of time and the browser agree
  const [preview, setPreview] = useState(false);
  useEffect(() => setPreview(isPreviewHost(window.location.hostname)), []);
  if (preview) {
    return (
      <span className="text-sm text-muted" data-testid="signin-preview">
        Sign-in works on{' '}
        <a href={LIVE_SITE} className="underline underline-offset-4">
          the live site
        </a>{' '}
        only; this preview cannot sign in to Yahoo.
      </span>
    );
  }
  return (
    <a href={to} className={className} data-testid={testId}>
      {children}
    </a>
  );
}
