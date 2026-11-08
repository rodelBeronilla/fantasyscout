/**
 * The standings by hand (#874), for a head-to-head league whose import brings no records: a league
 * built here, or a Yahoo league before the bookmark read its standings. Each team's won, lost and
 * tied, and how the league counts them. My Team leads with the place they give and starts the
 * playoff odds from them. An import that brings records takes over from these.
 */
import type { LeagueSetup, Tally } from '../lib/fantasy-league';
import type { TeamRecord } from '../lib/records';

const field = 'w-14 rounded border border-line bg-bg px-1.5 py-1 text-right text-sm';
const KEYS = ['wins', 'losses', 'ties'] as const;
const LABEL: Record<(typeof KEYS)[number], string> = { wins: 'W', losses: 'L', ties: 'T' };
const WORD: Record<(typeof KEYS)[number], string> = { wins: 'won', losses: 'lost', ties: 'tied' };

export function StandingsEntry({ setup, onChange }: { setup: LeagueSetup; onChange: (change: (s: LeagueSetup) => LeagueSetup) => void }) {
  const { records, tally } = setup.standings;
  const entered = records.filter(Boolean).length;
  const set = (team: number, key: (typeof KEYS)[number], value: string) =>
    onChange((s) => {
      const n = Math.max(0, Math.floor(Number(value) || 0));
      const current: TeamRecord = s.standings.records[team] ?? { wins: 0, losses: 0, ties: 0, seed: null };
      const next = { ...current, [key]: n };
      const empty = !next.wins && !next.losses && !next.ties;
      return { ...s, standings: { ...s.standings, records: s.standings.records.map((r, i) => (i === team ? (empty ? null : next) : r)) } };
    });
  return (
    <details className="rounded-lg border border-line bg-card px-3 py-2 text-sm" data-testid="standings-entry">
      <summary className="cursor-pointer font-medium">
        Standings{entered ? ` (${entered} of ${setup.teams} teams entered)` : ": enter each team's record"}
      </summary>
      <p className="mt-2 text-xs text-muted">
        Copy each team&apos;s won, lost and tied from your league&apos;s standings. My Team then leads with your place and starts the playoff odds
        from these records rather than level ones.
      </p>
      <label className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted">The records count</span>
        <select
          value={tally}
          onChange={(e) => onChange((s) => ({ ...s, standings: { ...s.standings, tally: e.target.value as Tally } }))}
          className="rounded border border-line bg-bg px-2 py-1 text-sm"
          aria-label="How the records count"
        >
          <option value="categories">each category (e.g. 45-30-6)</option>
          <option value="matchups">one result a week (e.g. 5-3-0)</option>
        </select>
      </label>
      <div className="table-scroll mt-2 overflow-auto" tabIndex={0} role="region" aria-label="Each team's record">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="py-1 text-left text-xs font-medium text-muted">Team</th>
              {KEYS.map((k) => (
                <th key={k} className="py-1 text-right text-xs font-medium text-muted">
                  {LABEL[k]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {setup.names.map((name, t) => (
              <tr key={t} className="border-t border-line" data-testid="standings-entry-row">
                <td className="max-w-[10rem] truncate py-1 pr-2">{name}</td>
                {KEYS.map((k) => (
                  <td key={k} className="py-1 pl-1 text-right">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      value={records[t]?.[k] ?? ''}
                      onChange={(e) => set(t, k, e.target.value)}
                      className={field}
                      aria-label={`${name}: ${WORD[k]}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
