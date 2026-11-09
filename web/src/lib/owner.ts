/**
 * Whether this browser has signed in as the site's owner (#940). The SQL console is the owner's
 * alone (ADR 0008), so its nav link is hidden from everyone else. The Worker's session cookie is
 * HttpOnly, and asking the Worker on every page would cost every visitor a request, so the console
 * remembers here what the Worker told it, and the nav shows the link where it is set. It only
 * shows a link: the console still asks the Worker, which alone serves the tables.
 */
const KEY = 'fantasyscout:owner';

export function rememberOwner(owner: boolean): void {
  try {
    if (owner) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // storage blocked: the link stays hidden, and /sql/ still works
  }
}

export function isRememberedOwner(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}
