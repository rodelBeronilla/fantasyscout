/**
 * The League page's account line (#684): sign in with Yahoo to save the league's setup to an
 * account, or, signed in, sign out or delete what the account holds. Hidden where the site cannot
 * sign in (a preview, the tests).
 */
import { useEffect, useState } from 'react';

import { accountStatus, type AccountStatus, deleteAccount } from '../lib/account';
import type { League } from '../lib/data';

const NOTICE: Record<string, string> = {
  signedin: 'Signed in: this league is saved to your Yahoo account and follows you to any device you sign in on.',
  failed: 'The Yahoo sign-in did not finish. Try again.',
  noid: 'Yahoo did not say which account signed in, so nothing was saved.',
  unavailable: 'Signing in is not available on this site.',
};

export default function AccountBox({ league }: { league: League }) {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    void accountStatus().then(setStatus);
    const said = new URLSearchParams(window.location.search).get('account');
    if (said && NOTICE[said]) setNotice(NOTICE[said]);
  }, []);
  if (!status?.configured) return null;
  const forget = async () => {
    if (!window.confirm('Delete every league setup saved to your account and sign out? This browser keeps its own copy.')) return;
    const ok = await deleteAccount();
    setNotice(ok ? 'Deleted: your account holds nothing now, and this browser is signed out.' : 'The delete did not go through. Try again.');
    setStatus(await accountStatus(true));
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="account-box">
      {status.signedIn ? (
        <>
          <span>Saved to your Yahoo account: your setups follow you across devices.</span>
          <a href="/auth/account/logout" className="underline underline-offset-4">
            Sign out
          </a>
          <button type="button" className="rounded-full border border-line px-3 py-0.5 text-xs hover:bg-bg" onClick={() => void forget()}>
            Delete my saved data
          </button>
        </>
      ) : (
        <>
          <span className="text-muted">Your league lives in this browser only.</span>
          <a href={`/auth/account/start?league=${league}`} className="font-medium text-accent underline-offset-4 hover:underline" data-testid="account-signin">
            Sign in with Yahoo to save it to your account
          </a>
        </>
      )}
      {notice && (
        <p className="basis-full text-muted" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
