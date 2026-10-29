/** The board's league settings and My team panels. */
import { CATEGORY_LABELS, fmt } from '../lib/format';
import { DEFAULT_SETTINGS, type LeagueSettings, POINT_PRESETS, POINT_STATS, type Scoring } from '../lib/fantasy-league';
import type { League } from '../lib/data';
import { Signed } from './ui';

const SCORING_LABEL: Record<Scoring, string> = { cats9: '9-cat', cats8: '8-cat (no TO)', points: 'Points' };

export function describeSettings(s: LeagueSettings): string {
  return `${s.teams} teams × ${s.rosterSpots}, ${SCORING_LABEL[s.scoring]}`;
}

export function LeagueSettingsPanel({
  league,
  settings,
  onChange,
}: {
  league: League;
  settings: LeagueSettings;
  onChange: (next: LeagueSettings) => void;
}) {
  const field = 'rounded border border-line bg-card px-2 py-1 w-20';
  const isDefault = JSON.stringify(settings) === JSON.stringify(DEFAULT_SETTINGS[league]);
  return (
    <details className="rounded-lg border border-line bg-card px-3 py-2" data-testid="league-settings">
      <summary className="cursor-pointer text-sm">
        <span className="font-medium">Your league:</span> <span data-testid="league-summary">{describeSettings(settings)}</span>
        <span className="ml-2 text-xs text-muted">
          Value is measured against the players just outside your league&apos;s rosters. Saved in this browser.
        </span>
      </summary>
      <div className="mt-3 grid gap-3 text-sm">
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1">
            <span className="text-xs text-muted">Teams</span>
            <input
              type="number"
              min={4}
              max={20}
              value={settings.teams}
              onChange={(e) => onChange({ ...settings, teams: Math.min(20, Math.max(4, Number(e.target.value) || settings.teams)) })}
              className={field}
              aria-label="Teams in the league"
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-muted">Roster spots</span>
            <input
              type="number"
              min={6}
              max={20}
              value={settings.rosterSpots}
              onChange={(e) => onChange({ ...settings, rosterSpots: Math.min(20, Math.max(6, Number(e.target.value) || settings.rosterSpots)) })}
              className={field}
              aria-label="Roster spots"
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-muted">Scoring</span>
            <select
              value={settings.scoring}
              onChange={(e) => onChange({ ...settings, scoring: e.target.value as Scoring })}
              className="rounded border border-line bg-card px-2 py-1"
              aria-label="Scoring"
            >
              <option value="cats9">9-cat (head-to-head or roto)</option>
              <option value="cats8">8-cat, no turnovers</option>
              <option value="points">Points</option>
            </select>
          </label>
          {!isDefault && (
            <button type="button" onClick={() => onChange(DEFAULT_SETTINGS[league])} className="rounded border border-line px-2 py-1 text-xs hover:bg-bg">
              Reset
            </button>
          )}
        </div>
        {settings.scoring === 'points' && (
          <fieldset className="grid gap-2" data-testid="point-weights">
            <legend className="text-xs text-muted">
              Points per stat{' '}
              {Object.entries(POINT_PRESETS).map(([id, p]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => onChange({ ...settings, weights: p.weights })}
                  className="ml-1 rounded border border-line px-2 py-0.5 text-xs hover:bg-bg"
                >
                  {p.label}
                </button>
              ))}
            </legend>
            <div className="flex flex-wrap gap-2">
              {POINT_STATS.map((s) => (
                <label key={s.key} className="grid gap-1">
                  <span className="text-xs text-muted">{s.label}</span>
                  <input
                    type="number"
                    step={0.1}
                    value={settings.weights[s.key]}
                    onChange={(e) => onChange({ ...settings, weights: { ...settings.weights, [s.key]: Number(e.target.value) || 0 } })}
                    className="w-16 rounded border border-line bg-bg px-1 py-0.5"
                    aria-label={`Points per ${s.label}`}
                  />
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>
    </details>
  );
}

interface TeamPlayer {
  player_id: string;
  full_name: string | null;
  position: string | null;
}

/** The manager's team: who is on it, by position, and how it stands in each category. */
export function MyTeamPanel({
  players,
  totals,
  weakest,
  points,
  onClear,
}: {
  players: TeamPlayer[];
  totals: Record<string, number> | null;
  weakest: string[];
  points: { fpts: number; value: number } | null;
  onClear: () => void;
}) {
  const byPos = ['G', 'F', 'C'].map((p) => [p, players.filter((x) => (x.position ?? '').toUpperCase().includes(p)).length] as const);
  const entries = totals ? Object.entries(totals) : [];
  const span = Math.max(1, ...entries.map(([, v]) => Math.abs(v)));
  const W = 120;
  return (
    <section className="min-w-0 rounded-lg border border-line bg-card p-3" aria-labelledby="my-team-h" data-testid="my-team">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="my-team-h" className="text-sm font-medium tracking-wide text-muted uppercase">
          My team ({players.length} player{players.length === 1 ? '' : 's'})
        </h2>
        <button type="button" onClick={onClear} className="rounded border border-line px-2 py-0.5 text-xs hover:bg-bg">
          Clear my team
        </button>
      </div>
      <p className="mt-1 text-sm">
        {players.map((p) => p.full_name).join(', ')}
        <span className="ml-2 text-xs text-muted">{byPos.map(([p, c]) => `${p} ${c}`).join(' · ')}</span>
      </p>
      {points && (
        <p className="mt-2 text-sm">
          Projected {fmt(points.fpts, 1)} fantasy points a game; {fmt(points.value, 1)} above replacement.
        </p>
      )}
      {totals && (
        <div className="mt-2 grid gap-1 text-xs" data-testid="category-profile">
          <p className="text-muted">
            Category profile: the team&apos;s value above replacement in each category. Weakest:{' '}
            <strong className="text-fg">{weakest.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')}</strong>. The Fit column ranks
            players by how much they add where the team is weak.
          </p>
          <div className="grid grid-cols-[3rem_auto_3.5rem] items-center gap-x-2 gap-y-0.5">
            {entries.map(([c, v]) => {
              const w = (Math.abs(v) / span) * (W / 2);
              return [
                <span key={`${c}-l`} className={weakest.includes(c) ? 'font-semibold text-bad' : ''}>
                  {CATEGORY_LABELS[c] ?? c}
                </span>,
                <svg key={`${c}-b`} width={W} height="10" viewBox={`0 0 ${W} 10`} aria-hidden="true">
                  <line x1={W / 2} x2={W / 2} y1="0" y2="10" className="stroke-line" />
                  <rect x={v >= 0 ? W / 2 : W / 2 - w} y="2" width={w} height="6" className={v >= 0 ? 'fill-good' : 'fill-bad'} />
                </svg>,
                <span key={`${c}-v`} className="text-right">
                  <Signed value={v} digits={1} />
                </span>,
              ];
            })}
          </div>
        </div>
      )}
    </section>
  );
}
