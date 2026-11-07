/**
 * Import a public ESPN league into the League page (#745): its settings, lineup, teams and rosters,
 * read from ESPN's league API in the browser and matched to the board by name.
 */
import { useState } from 'react';

import { espnLeagueId, espnLeagueUrl, fromEspnLeague } from '../lib/espn-league';
import { DEFAULT_SETTINGS, type LeagueSetup, matchNames, normalize } from '../lib/fantasy-league';

const field = 'rounded border border-line bg-bg px-2 py-1 text-sm';
const button = 'rounded border border-accent bg-accent px-3 py-1 text-sm text-accent-fg disabled:opacity-50';

export default function EspnImport({
  season,
  players,
  hasRosters,
  onImport,
}: {
  /** The board's season, e.g. 2026-27. */
  season: string;
  players: { player_id: string; full_name: string | null }[];
  hasRosters: boolean;
  onImport: (setup: LeagueSetup) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const id = espnLeagueId(text);

  const run = async () => {
    if (!id) return;
    if (hasRosters && !window.confirm('Replace this league with the ESPN league?')) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(espnLeagueUrl(id, season), { headers: { accept: 'application/json' } });
      if (res.status === 401 || res.status === 403) {
        throw new Error('ESPN keeps this league private. Its manager can make it viewable to the public in the league settings (Basic Settings, Make League Viewable to Public), then import again.');
      }
      if (res.status === 404) throw new Error(`ESPN has no ${season} league with ID ${id}.`);
      if (!res.ok) throw new Error(`ESPN answered ${res.status}; try again in a moment.`);
      const league = fromEspnLeague(await res.json());
      const base = DEFAULT_SETTINGS.nba;
      const unmatched: string[] = [];
      let matched = 0;
      const rosters = league.teams.map((t) => {
        const found = matchNames(t.players.join('\n'), players);
        matched += found.matched.length;
        unmatched.push(...found.unmatched);
        return found.matched;
      });
      onImport(
        normalize(
          {
            teams: league.teams.length || league.settings.teams,
            rosterSpots: league.settings.rosterSpots || base.rosterSpots,
            scoring: league.settings.scoring,
            format: league.settings.format,
            weights: league.settings.weights ? { ...base.weights, ...league.settings.weights } : base.weights,
            lineup: league.settings.lineup,
            names: league.teams.map((t) => t.name),
            rosters,
            mine: 0,
            drafting: false,
            picks: [],
          },
          base,
        ),
      );
      const total = league.teams.reduce((s, t) => s + t.players.length, 0);
      setNote(
        `Imported ${league.name}: ${league.teams.length} teams, ${matched} of ${total} players matched.` +
          (unmatched.length ? ` Not on the board: ${unmatched.join(', ')}.` : '') +
          ' ESPN does not say which team is yours: pick it below with My team.',
      );
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    // open while the league is empty, and while an import has something to say
    <details className="rounded-lg border border-line bg-card px-3 py-2" open={!hasRosters || !!note} data-testid="espn-import">
      <summary className="cursor-pointer text-sm font-medium">Import from ESPN</summary>
      <div className="mt-2 grid gap-2 text-sm">
        <p className="text-muted">
          Paste your ESPN league&apos;s address or its league ID: settings, starting lineup, teams and every roster come in at once. Public leagues
          only; a private league&apos;s manager can make it viewable to the public in ESPN&apos;s league settings.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">ESPN league address or ID</span>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="https://fantasy.espn.com/basketball/league?leagueId=…"
              className={`${field} w-full`}
              aria-label="ESPN league address or ID"
            />
          </label>
          <button type="button" className={button} disabled={!id || busy} onClick={() => void run()}>
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
        {note && (
          <p role="status" data-testid="espn-note">
            {note}
          </p>
        )}
      </div>
    </details>
  );
}
