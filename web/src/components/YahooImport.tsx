/**
 * Import a Yahoo Fantasy league into the League page. The Worker holds the sign-in (an HttpOnly
 * cookie) and calls Yahoo; this card only sees league data. It shows nothing until the Worker
 * reports the import configured.
 */
import { useEffect, useState } from 'react';

import type { League } from '../lib/data';
import { DEFAULT_SETTINGS, type LeagueSetup, matchNames, normalize, type PointWeights } from '../lib/fantasy-league';
import { href } from '../lib/site';
import { Card } from './ui';

interface Status {
  configured: boolean;
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
export function fromYahoo(
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
      .catch(() => setStatus({ configured: false, connected: false }));
  }, []);

  useEffect(() => {
    if (!status?.connected || league !== 'nba') return;
    getJson<LeagueSummary[]>('/api/yahoo/leagues')
      .then((list) => {
        setLeagues(list);
        setChosen(list[0]?.key ?? '');
      })
      .catch((e: unknown) => setNote(e instanceof Error ? e.message : String(e)));
  }, [status, league]);

  if (!status?.configured) return null;

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
    <Card title="Import from Yahoo" id="yahoo">
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
    </Card>
  );
}
