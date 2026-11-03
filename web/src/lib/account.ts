/**
 * The manager's account (#684): with a Yahoo sign-in, the League page's setups are saved to the
 * account and follow the manager across devices. The Worker holds them (worker/src/account.ts);
 * this side asks whether the browser is signed in, reads and writes a league's setup, and deletes
 * everything on request. Without the Worker (a preview, the tests) nobody is signed in and the
 * setups stay in this browser alone.
 */

export interface AccountStatus {
  /** The site can sign in with Yahoo at all. */
  configured: boolean;
  signedIn: boolean;
}

const NONE: AccountStatus = { configured: false, signedIn: false };
let status: Promise<AccountStatus> | null = null;

/** Whether this browser is signed in to an account, asked once per page. */
export function accountStatus(refresh = false): Promise<AccountStatus> {
  if (!status || refresh) {
    status = fetch('/api/account/status', { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return NONE;
        const body = (await r.json()) as Partial<AccountStatus>;
        return { configured: !!body.configured, signedIn: !!body.signedIn };
      })
      .catch(() => NONE);
  }
  return status;
}

export interface SavedSetup {
  setup: unknown;
  /** When the setup was saved, in ms since the epoch; the newer copy wins. */
  savedAt: number | null;
}

/** The setup the account holds for a league, or null when it holds none or cannot be read. */
export async function loadSaved(league: string): Promise<SavedSetup | null> {
  try {
    const r = await fetch(`/api/account/setup?league=${encodeURIComponent(league)}`, { credentials: 'same-origin' });
    if (!r.ok) return null;
    const body = (await r.json()) as SavedSetup;
    return body.setup ? body : null;
  } catch {
    return null;
  }
}

/** Saves a league's setup to the account; false when it could not. */
async function saveToAccount(league: string, setup: unknown, savedAt: number): Promise<boolean> {
  try {
    const r = await fetch(`/api/account/setup?league=${encodeURIComponent(league)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setup, savedAt }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Deletes everything the account holds and signs this browser out of it. */
export async function deleteAccount(): Promise<boolean> {
  try {
    const r = await fetch('/api/account', { method: 'DELETE', credentials: 'same-origin' });
    status = null;
    return r.ok;
  } catch {
    return false;
  }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Saves a league's setup to the account shortly, once the manager pauses: one write per burst of edits. */
export function saveSoon(league: string, read: () => { setup: unknown; savedAt: number } | null, delay = 800): void {
  const pending = timers.get(league);
  if (pending) clearTimeout(pending);
  timers.set(
    league,
    setTimeout(() => {
      timers.delete(league);
      void accountStatus().then((s) => {
        const current = read();
        if (s.signedIn && current) void saveToAccount(league, current.setup, current.savedAt);
      });
    }, delay),
  );
}
