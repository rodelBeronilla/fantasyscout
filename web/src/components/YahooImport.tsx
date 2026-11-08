/**
 * Import a Yahoo Fantasy league into the League page. The Worker holds the sign-in (an HttpOnly
 * cookie) and calls Yahoo; this card only sees league data. Until the Worker reports the import
 * live (Yahoo has approved the app), the card says it is coming soon.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';

import type { League } from '../lib/data';
import { DEFAULT_SETTINGS, type LeagueSetup, matchNames, normalize, type PointWeights } from '../lib/fantasy-league';
import { href } from '../lib/site';
import { yahooBookmarklet } from '../lib/yahoo-bookmarklet';
import { Card } from './ui';

interface Status {
  configured: boolean;
  live: boolean;
  connected: boolean;
}

interface LeagueSummary {
  key: string;
  name: string;
  season: string;
  teams: number;
}

interface YahooLeague {
  name: string;
  settings: { teams: number; rosterSpots: number; scoring: LeagueSetup['scoring']; weights: Partial<PointWeights> | null };
  teams: { name: string; mine: boolean; players: { name: string; team: string; position: string }[] }[];
}

const button = 'rounded border border-line px-2 py-1 text-xs hover:bg-bg disabled:opacity-50';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(href(path), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `${path} returned ${res.status}`);
  return (await res.json()) as T;
}

/** The League page's setup from a Yahoo league, with players matched to the board by name. */
function fromYahoo(
  league: League,
  data: YahooLeague,
  players: { player_id: string; full_name: string | null }[],
): { setup: LeagueSetup; matched: number; total: number; unmatched: string[] } {
  const unmatched: string[] = [];
  let matched = 0;
  const rosters = data.teams.map((t) => {
    const found = matchNames(t.players.map((p) => p.name).join('\n'), players);
    matched += found.matched.length;
    unmatched.push(...found.unmatched);
    return found.matched;
  });
  const base = DEFAULT_SETTINGS[league];
  const setup = normalize(
    {
      teams: data.teams.length || data.settings.teams,
      rosterSpots: data.settings.rosterSpots || base.rosterSpots,
      scoring: data.settings.scoring,
      weights: data.settings.weights ? { ...base.weights, ...data.settings.weights } : base.weights,
      names: data.teams.map((t) => t.name),
      rosters,
      mine: Math.max(0, data.teams.findIndex((t) => t.mine)),
      drafting: false,
      picks: [],
    },
    base,
  );
  return { setup, matched, total: data.teams.reduce((s, t) => s + t.players.length, 0), unmatched };
}

/**
 * The import's frame: a card while the league is empty; with rosters in, one folded line (#716),
 * open when My Team's "Re-sync" link (/league/#yahoo) brought the manager here (#815).
 */
function Shell({ folded, children }: { folded: boolean; children: ReactNode }) {
  const [asked] = useState(() => typeof window !== 'undefined' && window.location.hash === '#yahoo');
  return folded ? (
    <details className="rounded-lg border border-line bg-card px-3 py-2" id="yahoo" open={asked || undefined} data-testid="yahoo-folded">
      <summary className="cursor-pointer text-sm font-medium">Re-import from Yahoo</summary>
      <div className="mt-2">{children}</div>
    </details>
  ) : (
    <Card title="Import from Yahoo" id="yahoo">
      {children}
    </Card>
  );
}

export default function YahooImport({
  league,
  players,
  hasRosters,
  onImport,
}: {
  league: League;
  players: { player_id: string; full_name: string | null }[];
  hasRosters: boolean;
  onImport: (setup: LeagueSetup) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [leagues, setLeagues] = useState<LeagueSummary[] | null>(null);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(() => {
    const flag = new URLSearchParams(window.location.search).get('yahoo');
    return flag === 'connected' ? 'Signed in to Yahoo.' : flag === 'failed' ? 'The Yahoo sign-in did not complete; try again.' : null;
  });

  useEffect(() => {
    getJson<Status>('/api/yahoo/status')
      .then(setStatus)
      .catch(() => setStatus({ configured: false, live: false, connected: false }));
  }, []);

  useEffect(() => {
    if (!status?.live || !status.connected || league !== 'nba') return;
    getJson<LeagueSummary[]>('/api/yahoo/leagues')
      .then((list) => {
        setLeagues(list);
        setChosen(list[0]?.key ?? '');
      })
      .catch((e: unknown) => setNote(e instanceof Error ? e.message : String(e)));
  }, [status, league]);

  const bookmarklet = yahooBookmarklet(typeof window === 'undefined' ? '' : `${window.location.origin}${href('/league/')}?league=nba`);
  // React refuses a javascript: href, so the bookmarklet link gets its address on the element itself.
  const bookmarkRef = useRef<HTMLAnchorElement>(null);
  // Phones have no bookmarks bar: a tap copies the code and the steps say where to paste it.
  const [touch] = useState(() => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches);
  const [copied, setCopied] = useState<boolean | null>(null);
  const copyCode = () => {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard) {
      setCopied(false);
      return;
    }
    clipboard.writeText(bookmarklet).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  useEffect(() => {
    bookmarkRef.current?.setAttribute('href', bookmarklet);
  }, [bookmarklet, status]);
  if (!status) return null;
  if (!status.live) {
    // Parked until Yahoo approves the app for its Fantasy API; Yahoo runs NBA leagues only.
    if (league !== 'nba') return null;
    return (
      <Shell folded={hasRosters && !note}>
        <div className="grid gap-1 text-sm" data-testid="yahoo-soon">
          <p>
            <span className="mr-2 rounded-full border border-accent px-2 py-0.5 text-xs font-medium text-accent">Coming soon</span>
            Bring in a Yahoo league&apos;s settings, team names and every roster in one step.
          </p>
          <p className="text-muted">
            Yahoo is reviewing FantasyScout&apos;s access to its Fantasy API. Until then there are two ways in.
          </p>
          <div className="rounded border border-line p-3" data-testid="yahoo-bookmarklet">
            <p>
              <strong>Import with a bookmark, today.</strong>{' '}
              {touch ? 'Tap to copy the bookmark code:' : 'Drag this to your bookmarks bar, or tap it to copy the code:'}{' '}
              <a
                ref={bookmarkRef}
                draggable
                onClick={(e) => {
                  e.preventDefault();
                  copyCode();
                }}
                title="Drag this link to your bookmarks bar, or click to copy its code"
                className="rounded border border-accent px-2 py-0.5 font-medium text-accent"
                data-testid="yahoo-bookmarklet-link"
              >
                Import Yahoo league
              </a>
              {copied !== null && (
                <span role="status" className="ml-2 text-xs text-muted" data-testid="yahoo-copied">
                  {copied ? 'Code copied.' : 'Copy the code from the box below.'}
                </span>
              )}
            </p>
            <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-muted">
              <li>
                Save the code as a bookmark. {' '}
                <strong className="text-fg">Phone or tablet:</strong> bookmark any page, then edit that bookmark and paste the code in
                place of its address (iPhone: Bookmarks, Edit; Android Chrome: the star, then the pencil).
              </li>
              <li>
                Open your league on Yahoo in this browser, signed in, on the website rather than in the Yahoo app: best is the league&apos;s{' '}
                <strong className="text-fg">Starting Rosters</strong> page (League, then Starting Rosters), which lists every team&apos;s roster.
                The My Team or League page works too; the bookmark then reads each team&apos;s page the way your browser does.
              </li>
              <li>
                Run the bookmark <strong className="text-fg">on that page</strong>. On a phone, tap the address bar, type the bookmark&apos;s
                name and tap it in the list: opening it from the Bookmarks menu would run it in a new tab instead. It brings you back here with
                the rosters. A bookmark saved before this note appeared read the pages differently: save it again from the link above.
              </li>
              <li>Check the rosters below: a name Yahoo spells differently is listed as not found, and you can add it by hand.</li>
            </ol>
            <details className="mt-2 text-xs text-muted" open={copied === false || undefined}>
              <summary className="cursor-pointer">The bookmark code</summary>
              <textarea
                readOnly
                value={bookmarklet}
                rows={3}
                onFocus={(e) => e.currentTarget.select()}
                className="mt-1 w-full rounded border border-line bg-bg p-1 font-mono text-[10px]"
                aria-label="Bookmarklet code"
              />
            </details>
            <p className="mt-2 text-xs text-muted">
              Nothing leaves your browser except the team and player names, which go to this page in the address after the #, a part the
              browser never sends to a server. Private leagues work, since it runs as you.
            </p>
          </div>
          <p className="text-muted">
            Or open <strong className="text-fg">Paste a roster</strong> on each team below and paste the player names from your league&apos;s
            team pages, one per line.
          </p>
        </div>
      </Shell>
    );
  }

  const run = async () => {
    const summary = leagues?.find((l) => l.key === chosen);
    if (!summary) return;
    if (hasRosters && !window.confirm(`Replace this league with ${summary.name} from Yahoo?`)) return;
    setBusy(true);
    try {
      const data = await getJson<YahooLeague>(`/api/yahoo/league/${encodeURIComponent(summary.key)}`);
      const { setup, matched, total, unmatched } = fromYahoo(league, data, players);
      onImport(setup);
      setNote(
        `Imported ${data.name}: ${setup.teams} teams, ${matched} of ${total} players matched.${unmatched.length ? ` Not on the board: ${unmatched.join(', ')}.` : ''}`,
      );
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell folded={hasRosters && !note}>
      <div className="grid gap-2 text-sm" data-testid="yahoo-import">
        {league !== 'nba' ? (
          <p className="text-muted">Yahoo runs NBA leagues only; switch to the NBA to import one.</p>
        ) : !status.connected ? (
          <>
            <p className="text-muted">
              Sign in to Yahoo to bring in a league&apos;s settings, team names and every roster. FantasyScout only reads your leagues, and the sign-in
              stays in a cookie that only this site&apos;s server can read.
            </p>
            <a href={href('/auth/yahoo/start')} className="justify-self-start rounded border border-accent bg-accent px-3 py-1 text-accent-fg">
              Sign in with Yahoo
            </a>
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {leagues === null ? (
              <span className="text-muted">Loading your Yahoo leagues…</span>
            ) : leagues.length === 0 ? (
              <span className="text-muted">No NBA leagues on this Yahoo account this season.</span>
            ) : (
              <>
                <select value={chosen} onChange={(e) => setChosen(e.target.value)} className="rounded border border-line bg-bg px-2 py-1" aria-label="Yahoo league">
                  {leagues.map((l) => (
                    <option key={l.key} value={l.key}>
                      {l.name} ({l.teams} teams, {l.season})
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => void run()} disabled={busy || !chosen} className={button}>
                  {busy ? 'Importing…' : 'Import this league'}
                </button>
              </>
            )}
            <a href={href('/auth/yahoo/logout')} className="text-xs text-muted underline underline-offset-4">
              Sign out of Yahoo
            </a>
          </div>
        )}
        {note && (
          <p role="status" data-testid="yahoo-note">
            {note}
          </p>
        )}
      </div>
    </Shell>
  );
}
