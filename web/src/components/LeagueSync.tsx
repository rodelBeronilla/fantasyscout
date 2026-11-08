/**
 * Keeping an imported league current on the pages that read it (#815): the re-import itself, and
 * the line at the top of My Team that says when the copy was last synced.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { LeagueSetup } from '../lib/fantasy-league';
import { ago, espnSetup, espnSyncLine, readEspn, SYNC_EVERY_MS, syncDue, yahooStale } from '../lib/league-sync';
import { href } from '../lib/site';

type Players = { player_id: string; full_name: string | null }[];

export interface SyncState {
  busy: boolean;
  error: string | null;
  /** Re-imports the ESPN league now, replacing any edits made by hand. */
  resync: () => void;
}

/** How often an open page in view checks whether its copy is due; the read itself waits for SYNC_EVERY_MS. */
const LOOK_EVERY_MS = 60 * 1000; // def: a minute, in ms

/**
 * Re-imports an ESPN league once the board's players are in to match names against, when the copy
 * is more than a quarter hour old and the manager has not edited the rosters since; one request at
 * a time. A page left open does the same while it is in view, and checks the moment its tab comes
 * back into view (#875). A failed read waits a full quarter hour before the page asks ESPN again.
 */
export function useEspnSync(setup: LeagueSetup, update: (change: (current: LeagueSetup) => LeagueSetup) => void, players: Players | null): SyncState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [tried, setTried] = useState(0);
  const running = useRef(false);
  const source = setup.source;

  const run = useCallback(() => {
    if (!players || source?.host !== 'espn' || !source.season || running.current) return;
    running.current = true;
    setTried(Date.now());
    setBusy(true);
    setError(null);
    const { leagueId, season } = source;
    readEspn(leagueId, season, Date.now())
      .then(({ league, games }) => update((current) => espnSetup(league, players, { leagueId, season, now: Date.now(), games }, current).setup))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        running.current = false;
        setBusy(false);
      });
  }, [players, source, update]);

  useEffect(() => {
    // a hidden tab asks nothing of ESPN; it looks again when it comes back into view
    const look = () => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    };
    const tick = window.setInterval(look, LOOK_EVERY_MS);
    document.addEventListener('visibilitychange', look);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', look);
    };
  }, []);

  const due = syncDue(setup, now) === 'due' && now - tried >= SYNC_EVERY_MS;
  useEffect(() => {
    if (due) run();
  }, [due, run]);

  return { busy, error, resync: run };
}

const button = 'rounded border border-accent px-2 py-0.5 text-xs font-medium text-accent hover:bg-bg disabled:opacity-50';

/** The line that leads My Team: when the league was last synced, what changed, and the way to sync again. */
export function SyncLine({ setup, sync }: { setup: LeagueSetup; sync: SyncState }) {
  const [now, setNow] = useState(() => Date.now());
  const source = setup.source;
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 60 * 1000); // def: a minute, in ms
    return () => window.clearInterval(tick);
  }, []);
  // a sync that just landed reads "just now", not the minute the page opened
  useEffect(() => setNow(Date.now()), [source?.syncedAt]);
  if (!source) return null;
  const line = 'flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted';

  if (source.host === 'yahoo') {
    return (
      <p className={line} data-testid="sync-line">
        <span>Last synced {ago(source.syncedAt, now)} from Yahoo</span>
        {yahooStale(source, now) && (
          <a href={href('/league/#yahoo')} className="font-medium text-accent underline-offset-4 hover:underline" data-testid="yahoo-resync">
            Re-sync
          </a>
        )}
      </p>
    );
  }

  const edited = syncDue(setup, now) === 'edited';
  const opponent = setup.format === 'h2h' && setup.opponent !== null ? setup.names[setup.opponent] : null;
  const scheduled = typeof source.opponents?.[setup.mine] === 'number' && source.opponents[setup.mine] === setup.opponent;
  return (
    <div className={line} data-testid="sync-line">
      {sync.busy ? (
        <span role="status">Syncing with ESPN…</span>
      ) : edited ? (
        <span>Synced from ESPN {ago(source.syncedAt, now)}; you have changed the rosters here since, so they stay as you left them.</span>
      ) : (
        <span role="status" data-testid="sync-summary">
          {espnSyncLine(source, now)}
          {opponent && scheduled ? ` · this week vs ${opponent}` : ''}
        </span>
      )}
      {sync.error && (
        <span className="text-bad" data-testid="sync-error">
          Could not re-sync: {sync.error}
        </span>
      )}
      {edited && (
        <button
          type="button"
          className={button}
          disabled={sync.busy}
          onClick={sync.resync}
        >
          Re-sync from ESPN (replaces your edits)
        </button>
      )}
    </div>
  );
}
