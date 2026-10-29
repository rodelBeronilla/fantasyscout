/** League pieces shared by the League page and the board: settings, the summary bar, the draft bar, a team's profile. */
import { CATEGORY_LABELS } from '../lib/format';
import {
  DEFAULT_SETTINGS,
  type LeagueSetup,
  MAX_TEAMS,
  MIN_TEAMS,
  onTheClock,
  POINT_PRESETS,
  POINT_STATS,
  type Scoring,
} from '../lib/fantasy-league';
import type { League } from '../lib/data';
import { href } from '../lib/site';
import { Signed } from './ui';

export const SCORING_LABEL: Record<Scoring, string> = { cats9: '9-cat', cats8: '8-cat (no TO)', points: 'Points' };

export function describeSettings(s: LeagueSetup): string {
  return `${s.teams} teams × ${s.rosterSpots}, ${SCORING_LABEL[s.scoring]}`;
}

const field = 'rounded border border-line bg-bg px-2 py-1';

/** Teams, roster spots, scoring and the points per stat. */
export function LeagueSettingsForm({
  league,
  setup,
  onChange,
}: {
  league: League;
  setup: LeagueSetup;
  onChange: (change: (s: LeagueSetup) => LeagueSetup) => void;
}) {
  const d = DEFAULT_SETTINGS[league];
  const isDefault =
    setup.teams === d.teams &&
    setup.rosterSpots === d.rosterSpots &&
    setup.scoring === d.scoring &&
    JSON.stringify(setup.weights) === JSON.stringify(d.weights);
  return (
    <div className="grid gap-3 text-sm" data-testid="league-settings">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1">
          <span className="text-xs text-muted">Teams</span>
          <input
            type="number"
            min={MIN_TEAMS}
            max={MAX_TEAMS}
            value={setup.teams}
            onChange={(e) => {
              const teams = Number(e.target.value);
              if (teams) onChange((s) => ({ ...s, teams }));
            }}
            className={`${field} w-20`}
            aria-label="Teams in the league"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-xs text-muted">Roster spots</span>
          <input
            type="number"
            min={6}
            max={20}
            value={setup.rosterSpots}
            onChange={(e) => {
              const rosterSpots = Number(e.target.value);
              if (rosterSpots) onChange((s) => ({ ...s, rosterSpots }));
            }}
            className={`${field} w-20`}
            aria-label="Roster spots"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-xs text-muted">Scoring</span>
          <select
            value={setup.scoring}
            onChange={(e) => {
              const scoring = e.target.value as Scoring;
              onChange((s) => ({ ...s, scoring }));
            }}
            className={field}
            aria-label="Scoring"
          >
            <option value="cats9">9-cat (head-to-head or roto)</option>
            <option value="cats8">8-cat, no turnovers</option>
            <option value="points">Points</option>
          </select>
        </label>
        {!isDefault && (
          <button
            type="button"
            onClick={() => onChange((s) => ({ ...s, teams: d.teams, rosterSpots: d.rosterSpots, scoring: d.scoring, weights: d.weights }))}
            className="rounded border border-line px-2 py-1 text-xs hover:bg-bg"
          >
            Reset settings
          </button>
        )}
      </div>
      {setup.scoring === 'points' && (
        <fieldset className="grid gap-2" data-testid="point-weights">
          <legend className="text-xs text-muted">
            Points per stat{' '}
            {Object.entries(POINT_PRESETS).map(([id, p]) => (
              <button
                key={id}
                type="button"
                onClick={() => onChange((s) => ({ ...s, weights: p.weights }))}
                className="ml-1 rounded border border-line px-2 py-0.5 text-xs hover:bg-bg"
              >
                {p.label}
              </button>
            ))}
          </legend>
          <div className="flex flex-wrap gap-2">
            {POINT_STATS.map((stat) => (
              <label key={stat.key} className="grid gap-1">
                <span className="text-xs text-muted">{stat.label}</span>
                <input
                  type="number"
                  step={0.1}
                  value={setup.weights[stat.key]}
                  onChange={(e) => {
                    const v = Number(e.target.value) || 0;
                    onChange((s) => ({ ...s, weights: { ...s.weights, [stat.key]: v } }));
                  }}
                  className="w-16 rounded border border-line bg-bg px-1 py-0.5"
                  aria-label={`Points per ${stat.label}`}
                />
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}

/** One line on the board: the league it values for, the manager's team, and the way to the League page. */
export function LeagueBar({ setup, rostered, myCount, weakest }: { setup: LeagueSetup; rostered: number; myCount: number; weakest: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line bg-card px-3 py-2 text-sm" data-testid="league-bar">
      <span>
        <span className="text-muted">Valued for </span>
        <span data-testid="league-summary">{describeSettings(setup)}</span>
      </span>
      {rostered > 0 ? (
        <span>
          <span className="text-muted">Your team </span>
          <strong>{setup.names[setup.mine]}</strong>{' '}
          <span className="text-muted">
            ({myCount}/{setup.rosterSpots}) · {rostered} rostered in the league
          </span>
        </span>
      ) : (
        <span className="text-muted">Add your league&apos;s rosters to see who is still available and what your team needs.</span>
      )}
      {weakest.length > 0 && (
        <span>
          <span className="text-muted">Weakest </span>
          <strong>{weakest.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')}</strong>
        </span>
      )}
      <a href={href('/league/')} className="ml-auto font-medium text-accent underline-offset-4 hover:underline">
        {rostered > 0 ? 'Edit league' : 'Set up your league'} →
      </a>
    </div>
  );
}

/** Who is on the clock in a draft, with undo. */
export function DraftBar({
  setup,
  lastName,
  onUndo,
  onEnd,
}: {
  setup: LeagueSetup;
  lastName: string | null;
  onUndo: () => void;
  onEnd: () => void;
}) {
  const clock = onTheClock(setup);
  const yours = clock.team === setup.mine;
  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border-2 bg-card px-3 py-2 text-sm ${yours ? 'border-good' : 'border-accent'}`}
      role="status"
      data-testid="draft-bar"
    >
      <span>
        Round {clock.round}, pick {clock.pick} (#{clock.overall}): <strong>{setup.names[clock.team]}</strong>{' '}
        {yours ? 'is your team: your pick.' : 'is on the clock.'}
      </span>
      {lastName && <span className="text-muted">Last pick: {lastName}</span>}
      <span className="ml-auto flex gap-2">
        <button
          type="button"
          onClick={onUndo}
          disabled={!setup.picks.length}
          className="rounded border border-line px-2 py-0.5 text-xs hover:bg-bg disabled:opacity-50"
        >
          Undo last pick
        </button>
        <button type="button" onClick={onEnd} className="rounded border border-line px-2 py-0.5 text-xs hover:bg-bg">
          End draft
        </button>
      </span>
    </div>
  );
}

/** A team's value above replacement in each category, as bars either side of zero. */
export function CategoryProfile({ totals, weakest }: { totals: Record<string, number>; weakest: string[] }) {
  const entries = Object.entries(totals);
  const span = Math.max(1, ...entries.map(([, v]) => Math.abs(v)));
  const W = 120;
  return (
    <div className="grid w-fit grid-cols-[3rem_120px_3.5rem] items-center gap-x-2 gap-y-0.5 text-xs" data-testid="category-profile">
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
  );
}
