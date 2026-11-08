/**
 * Keeping an imported league current on the pages that read it (#815): the re-import itself, and
 * the line at the top of My Team that says when the copy was last synced.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { LeagueSetup } from '../lib/fantasy-league';
import { ago, espnSetup, espnSyncLine, fetchEspnLeague, syncDue, yahooStale } from '../lib/league-sync';
import { href } from '../lib/site';

type Players = { player_id: string; full_name: string | null }[];

export interface SyncState {
  busy: boolean;
  error: string | null;
  /** Re-imports the ESPN league now, replacing any edits made by hand. */
  resync: () => void;
}

/**
 * Re-imports an ESPN league once the board's players are in to match names against, when the copy
 * is more than a quarter hour old and the manager has not edited the rosters since; one request at
 * a time.
 */
export function useEspnSync(setup: LeagueSetup, update: (change: (current: LeagueSetup) => LeagueSetup) => void, players: Players | null): SyncState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const source = setup.source;

  const run = useCallback(() => {
    if (!players || source?.host !== 'espn' || !source.season || running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    const { leagueId, season } = source;
    fetchEspnLeague(leagueId, season)
      .then((imported) => update((current) => espnSetup(imported, players, { leagueId, season, now: Date.now() }, current).setup))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        running.current = false;
        setBusy(false);
      });
  }, [players, source, update]);

  const due = syncDue(setup, Date.now()) === 'due';
  useEffect(() => {
    // once per visit: an error waits for the next one rather than asking again
    if (due && !error) run();
  }, [due, error, run]);

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
