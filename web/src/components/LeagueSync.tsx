/**
 * Keeping an imported league current on the pages that read it (#815): the re-import itself, and
 * the line at the top of My Team that says when the copy was last synced.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { getLatest, type League } from '../lib/data';
import type { LeagueSetup } from '../lib/fantasy-league';
import { ago, copyAge, espnSetup, espnSyncLine, inSeasonFrom, readEspn, SYNC_EVERY_MS, syncDue } from '../lib/league-sync';
import { logImport } from '../lib/owner-log';
import { href } from '../lib/site';
import { easternDate } from '../lib/today';
import { weeksLines } from '../lib/yahoo-pages';

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
      .then(({ league, games }) =>
        update((current) => {
          const next = espnSetup(league, players, { leagueId, season, now: Date.now(), games }, current).setup;
          // the owner's private log (#1032), once per import however often React runs this; nothing is sent for anyone else
          void logImport(next);
          return next;
        }),
      )
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
export function SyncLine({ setup, sync, league }: { setup: LeagueSetup; sync: SyncState; league: League }) {
  const inSeason = useInSeason(league);
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
    // the bookmark's matchup page names this week's opponent (#874)
    const versus = setup.format === 'h2h' && setup.opponent !== null && source.opponents?.[setup.mine] === setup.opponent ? setup.names[setup.opponent] : null;
    return (
      <p className={line} data-testid="sync-line">
        <span data-testid="sync-summary">
          Last synced {ago(source.syncedAt, now)} from Yahoo{versus ? ` · this week vs ${versus}` : ''}
        </span>
        {copyAge(source, now, inSeason).stale && (
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

/** Whether a league is in season (#1001): its newest published data is at most a week old. */
function useInSeason(league: League): boolean {
  const [inSeason, setInSeason] = useState(false);
  useEffect(() => {
    let live = true;
    getLatest()
      .then((latest) => live && setInSeason(inSeasonFrom(latest?.data_as_of[league], easternDate())))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [league]);
  return inSeason;
}

/**
 * The line every page that uses an imported league carries (#1001): where the copy came from and
 * how old it is, and in season, once it is a day old, the way to take it again: the bookmark for a
 * Yahoo league, a re-import for an ESPN one. Nothing for a league built by hand.
 */
export function CopyAge({ setup, league }: { setup: LeagueSetup; league: League }) {
  const inSeason = useInSeason(league);
  const [now, setNow] = useState(() => Date.now());
  const source = setup.source;
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 60 * 1000); // def: a minute, in ms
    return () => window.clearInterval(tick);
  }, []);
  useEffect(() => setNow(Date.now()), [source?.syncedAt]);
  if (!source) return null;
  const { text, stale } = copyAge(source, now, inSeason);
  return (
    <p className={stale ? 'text-sm text-warn' : 'text-sm text-muted'} data-testid="copy-age" data-stale={stale || undefined}>
      {text}.{' '}
      {stale && (
        <a
          href={href(source.host === 'yahoo' ? '/league/#yahoo' : '/league/')}
          className="font-medium text-accent underline-offset-4 hover:underline"
          data-testid="copy-age-rerun"
        >
          {source.host === 'yahoo' ? 'It is over a day old: run the Yahoo bookmark again' : 'It is over a day old: import it again'} →
        </a>
      )}
    </p>
  );
}

/**
 * The League page's lines on the weeks a Yahoo import holds (#1049): which weeks are final and
 * which is so far, and the page that did not answer, so the manager knows to run the bookmark again.
 */
export function YahooWeeks({ setup }: { setup: LeagueSetup }) {
  const source = setup.source;
  if (source?.host !== 'yahoo') return null;
  const { read, stop, left } = weeksLines(source, setup.names);
  if (!read && !stop) {
    // a copy from a bookmark older than #1053 holds no weeks: say so, rather than nothing (#1070)
    return (
      <p className="text-sm" data-testid="yahoo-weeks-none">
        The league week by week (every team&apos;s category totals, week by week) needs the new Yahoo bookmark: this copy was imported by an older one.{' '}
        <a href="#yahoo" className="font-medium text-accent underline-offset-4 hover:underline">
          Add the bookmark again
        </a>{' '}
        (the steps are under &ldquo;Re-import from Yahoo&rdquo;) and run it on your league.
      </p>
    );
  }
  return (
    <div className="grid gap-0.5 text-sm text-muted">
      {read && <p data-testid="yahoo-weeks">{read}</p>}
      {left && <p data-testid="yahoo-weeks-left">{left}</p>}
      {stop && <p data-testid="yahoo-weeks-stop">{stop}</p>}
    </div>
  );
}
