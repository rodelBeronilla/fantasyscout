/**
 * The League page's account line (#684): sign in with Yahoo to save the league's setup to an
 * account, or, signed in, sign out or delete what the account holds. Hidden where the site cannot
 * sign in (a preview, the tests). For the site's owner alone, "Your data" downloads or deletes his
 * private log (#1032), and turns on the owner preview, the calls not yet validated (#1056).
 */
import { useEffect, useState } from 'react';

import { accountStatus, type AccountStatus, deleteAccount } from '../lib/account';
import type { League } from '../lib/data';
import { isRememberedOwner } from '../lib/owner';
import { deleteOwnerLog, OWNER_LOG_DOWNLOAD, ownerStatus } from '../lib/owner-log';
import { previewSwitchOn, setPreviewSwitch } from '../lib/owner-preview';
import { SignInLink } from './SignInLink';

const NOTICE: Record<string, string> = {
  signedin: 'Signed in: this league is saved to your Yahoo account and follows you to any device you sign in on.',
  failed: 'The Yahoo sign-in did not finish. Try again.',
  noid: 'Yahoo did not say which account signed in, so nothing was saved.',
  unavailable: 'Signing in is not available on this site.',
};

export default function AccountBox({ league }: { league: League }) {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [owner, setOwner] = useState(false);
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    void accountStatus().then(setStatus);
    const said = new URLSearchParams(window.location.search).get('account');
    if (said && NOTICE[said]) setNotice(NOTICE[said]);
    // The owner's "Your data" (#1032): asked only in a browser that signed in as the owner, or
    // that has just signed in, which may be the owner. Nobody else's browser asks.
    if (isRememberedOwner() || said === 'signedin') void ownerStatus().then(setOwner);
    setPreview(previewSwitchOn());
  }, []);
  if (!status?.configured) return null;
  const forget = async () => {
    if (!window.confirm('Delete every league setup saved to your account and sign out? This browser keeps its own copy.')) return;
    const ok = await deleteAccount();
    setNotice(ok ? 'Deleted: your account holds nothing now, and this browser is signed out.' : 'The delete did not go through. Try again.');
    setStatus(await accountStatus(true));
  };
  const forgetLog = async () => {
    if (!window.confirm('Delete your whole log of pages, imports and calls? This cannot be undone.')) return;
    const ok = await deleteOwnerLog();
    setNotice(ok ? 'Deleted: your log is empty now.' : 'The delete did not go through. Try again.');
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
          <SignInLink to={`/auth/account/start?league=${league}`} className="font-medium text-accent underline-offset-4 hover:underline" testId="account-signin">
            Sign in with Yahoo to save it to your account
          </SignInLink>
        </>
      )}
      {owner && (
        <div className="flex basis-full flex-wrap items-center gap-x-3 gap-y-1" data-testid="owner-data">
          <span className="font-medium">Your data</span>
          <span className="text-muted">
            A private log of the pages you open, your imports and the calls shown to you, written only while you are signed in as the owner (
            <a href="/sources/#retention-h" className="underline underline-offset-4">
              what it holds
            </a>
            ).
          </span>
          <a href={OWNER_LOG_DOWNLOAD} download className="underline underline-offset-4">
            Download the log
          </a>
          <button type="button" className="rounded-full border border-line px-3 py-0.5 text-xs hover:bg-bg" onClick={() => void forgetLog()}>
            Delete the log
          </button>
          <label className="flex basis-full items-center gap-2">
            <input
              type="checkbox"
              checked={preview}
              onChange={(e) => {
                setPreviewSwitch(e.target.checked);
                setPreview(e.target.checked);
              }}
              data-testid="owner-preview-switch"
            />
            <span>Show calls that have not passed their check (preview)</span>
          </label>
          <span className="basis-full text-xs text-muted">
            Kept in this browser only. Each one shows on its page under &quot;Preview: not validated&quot;, to you alone, and goes to your log.
          </span>
        </div>
      )}
      {notice && (
        <p className="basis-full text-muted" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
