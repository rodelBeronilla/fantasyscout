/**
 * Import a public ESPN league into the League page (#745): its settings, lineup, teams and rosters,
 * read from ESPN's league API in the browser and matched to the board by name. The pages that read
 * the league import it again on a visit (#815).
 */
import { useState } from 'react';

import { espnLeagueId } from '../lib/espn-league';
import type { LeagueSetup } from '../lib/fantasy-league';
import { espnSetup, readEspn } from '../lib/league-sync';

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
      const { league, games } = await readEspn(id, season, Date.now());
      const { setup, matched, total, unmatched } = espnSetup(league, players, { leagueId: id, season, now: Date.now(), games }, null);
      onImport(setup);
      setNote(
        `Imported ${league.name}: ${league.teams.length} teams, ${matched} of ${total} players matched.` +
          (unmatched.length ? ` Not on the board: ${unmatched.join(', ')}.` : '') +
          ' ESPN does not say which team is yours: pick it below with My team. My Team and Trade read the league from ESPN again when you open them, so the rosters stay current.',
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
