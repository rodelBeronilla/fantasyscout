/**
 * The owner's log (#1032): a private record of the owner's own use of the site, approved by him on
 * 2026-11-17, kept by the Worker (worker/src/owner-log.ts) under a prefix the public data route
 * never serves. Three kinds of event: a page opened, a league import, and a call shown to him.
 *
 * Only the signed-in owner's browser writes it. A browser that has never signed in as the owner
 * (every visitor but one) asks nothing: the check starts from the flag the owner's sign-in leaves
 * (owner.ts), and only then asks the Worker, once a page, whether the owner's cookie still holds.
 * The Worker refuses the log to anyone else in any case.
 */
import type { LeagueSetup } from './fantasy-league';
import { isRememberedOwner, rememberOwner } from './owner';
import type { TeamRecord } from './records';
import type { CallResult } from '../../../worker/src/owner-log-event';

const LOG = '/api/owner/log';

/** A page the owner opened: its path, without the query or the fragment. */
interface PageEvent {
  kind: 'page';
  path: string;
}

/** A league import: every team's roster and record, the slots the host had set, and when it ran. */
interface ImportEvent {
  kind: 'import';
  host: 'yahoo' | 'espn';
  /** The owner's team, by index; null when the import does not say. */
  mine: number | null;
  /** When the import ran, ms since the epoch. */
  time: number;
  rosters: string[][];
  /** Each rostered player's slot as the host had it set (PG, UTIL, BN, IL...), by player id. */
  slots: Record<string, string>;
  records: (TeamRecord | null)[];
}

/** A call shown to the owner, with what the naive manager would have said in its place. */
export interface CallShown {
  /** The Eastern date the call is for, YYYY-MM-DD. */
  date: string;
  /** The kind of call, lower-case words joined by hyphens: "start", "pickup", "trade"... */
  call: string;
  /** What the call is about: a player id, or a trade's players. */
  subject: string;
  /** What the call said. */
  value: number | string;
  /** What the naive manager would have said; null where there is no naive answer. */
  naive: number | string | null;
  /** The build the call was made from. */
  build: string;
}

type OwnerLogEvent = PageEvent | ImportEvent | ({ kind: 'call' } & CallShown);

let owner: Promise<boolean> | null = null;

/**
 * Whether the Worker says this browser is signed in as the owner, asked once a page. The answer
 * is remembered for the nav and for `ownerLogOn`. Callers ask it only where a request is already
 * fine: the owner's own pages, or a browser signed in to an account.
 */
export function ownerStatus(): Promise<boolean> {
  owner ??= fetch('/api/owner/status', { credentials: 'same-origin', headers: { accept: 'application/json' } })
    .then(async (r) => {
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return false;
      const is = !!((await r.json()) as { owner?: unknown }).owner;
      rememberOwner(is);
      return is;
    })
    .catch(() => false);
  return owner;
}

/** Whether to write the log: false at once, with no request, in any browser that never signed in as the owner. */
export function ownerLogOn(): Promise<boolean> {
  return isRememberedOwner() ? ownerStatus() : Promise.resolve(false);
}

// one write at a time, so two events from one page never race for the day's file
let queue: Promise<unknown> = Promise.resolve();

function write(event: OwnerLogEvent): Promise<boolean> {
  const next = queue.then(async () => {
    if (!(await ownerLogOn())) return false;
    try {
      const r = await fetch(LOG, {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      });
      return r.ok;
    } catch {
      return false;
    }
  });
  queue = next;
  return next;
}

/** Logs the page the owner opened. */
export function logPage(path: string): Promise<boolean> {
  return write({ kind: 'page', path });
}

/** The import event of a setup just imported, or null when the setup came from no import. */
export function importEvent(setup: LeagueSetup): ImportEvent | null {
  const source = setup.source;
  if (!source) return null;
  return {
    kind: 'import',
    host: source.host,
    mine: source.host === 'yahoo' ? setup.mine : null,
    time: source.syncedAt,
    rosters: source.rosters,
    slots: source.slots ?? {},
    records: source.records ?? [],
  };
}

// the imports logged this page, by host and time: an import is logged once however often its result is read
const imported = new Set<string>();

/** Logs a league import: the rosters, slots and records it brought, and when. */
export function logImport(setup: LeagueSetup): Promise<boolean> {
  const event = importEvent(setup);
  if (!event || imported.has(`${event.host}:${event.time}`)) return Promise.resolve(false);
  imported.add(`${event.host}:${event.time}`);
  return write(event);
}

/**
 * Logs one call shown to the owner, alone. The owner preview logs its calls in batches through
 * logCalls instead; this one-event form stays for the log's own tests and any single call.
 */
export function logCall(call: CallShown): Promise<boolean> {
  return write({ kind: 'call', date: call.date, call: call.call, subject: call.subject, value: call.value, naive: call.naive, build: call.build });
}

/** A call of the owner preview as it is logged (#1056): a call shown, with the league's import it was made for. */
export type PreviewEntry = CallShown & { league: string };

// def: how long the log has to answer a batch before the frames say it did not (#1137)
export const LOG_TIMEOUT_MS = 10_000;

/**
 * Logs a batch of the owner preview's calls in one request (#1056). The Worker answers call by call
 * (stored, kept or refused); "timeout" when it has not answered in LOG_TIMEOUT_MS (#1137); null
 * when it did not answer so (not the owner, refused whole, no network). Sent with keepalive, so a
 * request already sent is stored even when the page is left.
 */
export async function logCalls(calls: readonly PreviewEntry[]): Promise<CallResult[] | 'timeout' | null> {
  if (!(await ownerLogOn())) return null;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), LOG_TIMEOUT_MS);
  try {
    const r = await fetch(LOG, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'calls', calls }),
      signal: timeout.signal,
    });
    if (!r.ok) return null;
    const { results } = (await r.json()) as { results?: unknown };
    return Array.isArray(results) && results.length === calls.length ? (results as CallResult[]) : null;
  } catch {
    return timeout.signal.aborted ? 'timeout' : null;
  } finally {
    clearTimeout(timer);
  }
}

/** Where the owner downloads the whole log. */
export const OWNER_LOG_DOWNLOAD = LOG;

/** Deletes the whole log; false when it could not. */
export async function deleteOwnerLog(): Promise<boolean> {
  try {
    return (await fetch(LOG, { method: 'DELETE', credentials: 'same-origin' })).ok;
  } catch {
    return false;
  }
}
