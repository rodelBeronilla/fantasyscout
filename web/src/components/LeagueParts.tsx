/** League pieces shared by the League page and the board: settings, the summary bar, the draft bar, a team's profile. */
import { CATEGORIES, CATEGORY_LABELS, fmt } from '../lib/format';
import {
  DEFAULT_SETTINGS,
  FOCUS_WEIGHT,
  type Format,
  isDefaultSettings,
  type LeagueSetup,
  MAX_TEAMS,
  MIN_TEAMS,
  onTheClock,
  POINT_PRESETS,
  POINT_STATS,
  type Scoring,
} from '../lib/fantasy-league';
import type { League } from '../lib/data';
import type { RosterReview, Upgrade } from '../lib/roster-upgrades';
import { href } from '../lib/site';
import { isRatio, type WeekMatchup } from '../lib/matchup';
import { type TodayGame, todayGroups, type TodaySlot } from '../lib/today';
import { UNIT_LABEL, type ValueUnit } from '../lib/week-value';
import { Chip, InjuryTag, injuryDetail, type InjuryFields, LineupTag, Segmented, Signed, Td, Th } from './ui';

const SCORING_LABEL: Record<Scoring, string> = { cats9: '9-cat', cats8: '8-cat (no TO)', points: 'Points' };

const FORMAT_LABEL: Record<Format, string> = { roto: 'rotisserie', h2h: 'head-to-head' };

export function describeSettings(s: LeagueSetup): string {
  const punts = s.scoring === 'points' ? [] : s.punts.map((c) => CATEGORY_LABELS[c] ?? c);
  const focus = s.scoring === 'points' ? [] : s.focus.map((c) => CATEGORY_LABELS[c] ?? c);
  return `${s.teams} teams × ${s.rosterSpots}, ${SCORING_LABEL[s.scoring]}${s.format === 'h2h' ? `, ${FORMAT_LABEL[s.format]}` : ''}${
    punts.length ? `, punting ${punts.join(', ')}` : ''
  }${focus.length ? `, focusing ${focus.join(', ')}` : ''
  }`;
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
  const isDefault = isDefaultSettings(setup, d);
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
            <option value="cats9">9-cat</option>
            <option value="cats8">8-cat, no turnovers</option>
            <option value="points">Points</option>
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-xs text-muted">Format</span>
          <select
            value={setup.format}
            onChange={(e) => {
              const format = e.target.value as Format;
              onChange((s) => ({ ...s, format }));
            }}
            className={field}
            aria-label="Format"
            title="Head-to-head leagues get a weekly matchup against one opponent on the board"
          >
            <option value="roto">Rotisserie: season totals</option>
            <option value="h2h">Head-to-head: weekly matchups</option>
          </select>
        </label>
        {!isDefault && (
          <button
            type="button"
            onClick={() => onChange((s) => ({ ...s, teams: d.teams, rosterSpots: d.rosterSpots, scoring: d.scoring, weights: d.weights, format: d.format, punts: d.punts, focus: d.focus }))}
            className="rounded border border-line px-2 py-1 text-xs hover:bg-bg"
          >
            Reset settings
          </button>
        )}
      </div>
      {setup.scoring !== 'points' && (
        <fieldset className="grid gap-2" data-testid="league-punts">
          <legend className="text-xs text-muted">
            Punt: categories you give up on. The board, Trade, roster upgrades and Streamers value players without them.
          </legend>
          <div className="flex flex-wrap gap-1">
            {CATEGORIES.map((c) => {
              const no = setup.scoring === 'cats8' && c === 'z_turnovers';
              return (
                <Chip
                  key={c}
                  label={`Punt ${CATEGORY_LABELS[c] ?? c}`}
                  checked={setup.punts.includes(c)}
                  strike
                  disabled={no}
                  title={no ? 'An 8-category league does not count turnovers: there is nothing to punt' : undefined}
                  onChange={() =>
                    onChange((s) => ({
                      ...s,
                      punts: s.punts.includes(c) ? s.punts.filter((x) => x !== c) : [...s.punts, c],
                      focus: s.focus.filter((x) => x !== c),
                    }))
                  }
                >
                  {CATEGORY_LABELS[c] ?? c}
                </Chip>
              );
            })}
          </div>
        </fieldset>
      )}
      {setup.scoring !== 'points' && (
        <fieldset className="grid gap-2" data-testid="league-focus">
          <legend className="text-xs text-muted">
            Focus: categories you build around. They count {FOCUS_WEIGHT}× in value, Fit and trades.
          </legend>
          <div className="flex flex-wrap gap-1">
            {CATEGORIES.map((c) => {
              const no = (setup.scoring === 'cats8' && c === 'z_turnovers') || setup.punts.includes(c);
              return (
                <Chip
                  key={c}
                  label={`Focus ${CATEGORY_LABELS[c] ?? c}`}
                  checked={setup.focus.includes(c)}
                  disabled={no}
                  title={setup.punts.includes(c) ? 'Punted: un-punt it to focus on it' : no ? 'An 8-category league does not count turnovers' : undefined}
                  onChange={() => onChange((s) => ({ ...s, focus: s.focus.includes(c) ? s.focus.filter((x) => x !== c) : [...s.focus, c] }))}
                >
                  {CATEGORY_LABELS[c] ?? c}
                </Chip>
              );
            })}
          </div>
        </fieldset>
      )}
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
export function LeagueBar({
  setup,
  rostered,
  myCount,
  weakest,
  weakLabel = 'Weakest',
}: {
  setup: LeagueSetup;
  rostered: number;
  myCount: number;
  weakest: string[];
  /** What the listed categories are: the manager's weakest, or the ones behind this week. */
  weakLabel?: string;
}) {
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
          <span className="text-muted">{weakLabel} </span>
          <strong>{weakest.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')}</strong>
        </span>
      )}
      <a href={href('/league/')} className="ml-auto font-medium text-accent underline-offset-4 hover:underline">
        {rostered > 0 ? 'Edit league' : 'Set up your league'} →
      </a>
    </div>
  );
}

/**
 * The roster review: who to replace from the players nobody owns, or that the roster holds as is,
 * for the rest of the season or, when the week has games left, for this fantasy week (#466).
 */
export function Upgrades({
  league,
  review,
  nameOf,
  detailOf,
  onApply,
  unit = 'rest',
  onUnit = null,
  gamesOf = null,
}: {
  league: League;
  review: RosterReview;
  nameOf: (id: string) => string;
  detailOf: (id: string) => string;
  onApply: (u: Upgrade) => void;
  unit?: ValueUnit;
  /** Offered when the week has games left; null hides the toggle. */
  onUnit?: ((u: ValueUnit) => void) | null;
  gamesOf?: ((id: string) => number) | null;
}) {
  const list = review.upgrades;
  const week = unit === 'week';
  const detail = (id: string) => {
    const games = week && gamesOf ? gamesOf(id) : null;
    return [detailOf(id), games === null ? '' : `${games} game${games === 1 ? '' : 's'} left`].filter(Boolean).join(', ');
  };
  const player = (id: string) => (
    <>
      <a href={href(`/p/${league}/${id}/`)} className="font-medium underline-offset-4 hover:underline">
        {nameOf(id)}
      </a>
      {detail(id) ? <span className="text-muted"> ({detail(id)})</span> : null}
    </>
  );
  const labels = (cats: string[]) => cats.map((c) => CATEGORY_LABELS[c] ?? c).join(', ');
  return (
    <section className="rounded-lg border border-line bg-card p-3" aria-labelledby="upgrades-h" data-testid="upgrades">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="upgrades-h" className="text-sm font-medium tracking-wide text-muted uppercase">
          Roster review
        </h2>
        {onUnit && (
          <Segmented
            label="Value unit"
            value={unit}
            options={[
              { id: 'rest', label: 'Rest of season', title: 'Projected value over the games each player is expected to play from today' },
              { id: 'week', label: 'This week', title: 'Last-ten form over the games left this fantasy week (Monday to Sunday)' },
            ]}
            onChange={onUnit}
          />
        )}
      </div>
      {review.optimized ? (
        <p className="mt-1 text-sm" data-testid="roster-verdict">
          <strong>Your roster is optimized as is.</strong> No player nobody in your league owns is worth more{' '}
          {week ? 'this week' : 'for the rest of the season'} than one of yours, under your league&apos;s scoring.
          {review.weakest && review.weakest.add && (
            <span className="text-muted">
              {' '}
              Weakest spot: {player(review.weakest.drop)}; the best free agent, {player(review.weakest.add)}, would be{' '}
              <Signed value={review.weakest.gap} digits={1} /> {UNIT_LABEL[unit]}, so hold.
            </span>
          )}
        </p>
      ) : (
        <p className="mt-1 text-sm" data-testid="roster-verdict">
          <strong>
            {review.replace.length} of your {review.rostered} players can be upgraded
          </strong>{' '}
          from the players nobody in your league owns, under your league&apos;s scoring. Replace:{' '}
          {review.replace.map((id, i) => (
            <span key={id}>
              {i > 0 ? ', ' : ''}
              {player(id)}
            </span>
          ))}
          . Apply records the swap in the league kept here; make it in your league&apos;s app too.
        </p>
      )}
      {week && (
        <p className="mt-1 text-xs text-muted" data-testid="unit-note">
          This week counts each player&apos;s last-ten form, above your league&apos;s replacement level, over the games left this
          fantasy week (Monday to Sunday). Rest of season counts the projection over the games each player is expected to play.
        </p>
      )}
      <ul className="mt-2 grid gap-1 text-sm">
        {list.map((u) => (
          <li key={`${u.add}-${u.drop}`} className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="upgrade">
            <span>
              Add {player(u.add)} for {player(u.drop)}
            </span>
            <span>
              <Signed value={u.gain} digits={1} /> <span className="text-muted">{UNIT_LABEL[unit]}</span>
            </span>
            {u.ups.length > 0 && (
              <span className="text-xs text-good" data-testid="upgrade-ups">
                up: {labels(u.ups)}
              </span>
            )}
            {u.downs.length > 0 && (
              <span className="text-xs text-bad" data-testid="upgrade-downs">
                down: {labels(u.downs)}
              </span>
            )}
            <button
              type="button"
              onClick={() => onApply(u)}
              className="rounded border border-line px-2 py-0.5 text-xs hover:bg-bg"
              title={`Add ${nameOf(u.add)} and drop ${nameOf(u.drop)} in the league kept here`}
              data-testid="upgrade-apply"
            >
              Apply
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The week against one opponent (#490): the categories the manager projects to win, lose or split, from the games left. */
export function Matchup({
  setup,
  match,
  points,
  onOpponent,
}: {
  setup: LeagueSetup;
  match: WeekMatchup | null;
  points: boolean;
  onOpponent: (team: number | null) => void;
}) {
  const them = setup.opponent === null ? null : (setup.names[setup.opponent] ?? `Team ${setup.opponent + 1}`);
  const show = (cat: string, v: number) => (isRatio(cat) ? `${fmt(v * 100, 1)}%` : fmt(v, 0));
  const tone = (r: WeekMatchup['cats'][number]['result']) => (r === 'win' ? 'text-good' : r === 'loss' ? 'text-bad' : 'text-muted');
  return (
    <section className="rounded-lg border border-line bg-card p-3" aria-labelledby="matchup-h" data-testid="matchup">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="matchup-h" className="text-sm font-medium tracking-wide text-muted uppercase">
          This week&apos;s matchup
        </h2>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Opponent</span>
          <select
            value={setup.opponent ?? ''}
            onChange={(e) => onOpponent(e.target.value === '' ? null : Number(e.target.value))}
            className="rounded border border-line bg-bg px-2 py-1 text-sm"
            aria-label="This week's opponent"
          >
            <option value="">Choose a team</option>
            {setup.names.map((name, t) =>
              t === setup.mine ? null : (
                <option key={t} value={t}>
                  {name}
                </option>
              ),
            )}
          </select>
        </label>
      </div>
      {!match || them === null ? (
        <p className="mt-1 text-sm text-muted" data-testid="matchup-summary">
          Pick the team you face this week to see the categories you project to win and lose: each roster&apos;s projected line over the games
          left this fantasy week (Monday to Sunday).
        </p>
      ) : points ? (
        <p className="mt-1 text-sm" data-testid="matchup-summary">
          You project <strong>{fmt(match.mine.fpts, 0)} fantasy points</strong> to {them}&apos;s {fmt(match.theirs.fpts, 0)} this week, over{' '}
          {match.mine.games} games to their {match.theirs.games}.
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm" data-testid="matchup-summary">
            You project to{' '}
            <strong>
              win {match.wins} of {match.cats.length} categories
            </strong>{' '}
            against {them}, lose {match.losses}
            {match.close ? `, with ${match.close} too close to call (within 5%)` : ''}. Games left this week: you {match.mine.games}, {them}{' '}
            {match.theirs.games}. Judging this week, Fit favours the categories within reach.
          </p>
          <div className="table-scroll mt-2 overflow-auto" tabIndex={0} role="region" aria-label="Matchup, category by category">
            <table className="w-full text-sm" data-testid="matchup-table">
              <thead>
                <tr>
                  <Th>Category</Th>
                  <Th right>You</Th>
                  <Th right>{them}</Th>
                  <Th right>Edge</Th>
                  <Th>{''}</Th>
                </tr>
              </thead>
              <tbody>
                {match.cats.map((r) => (
                  <tr key={r.cat} className="border-t border-line" data-testid="matchup-row">
                    <Td>{CATEGORY_LABELS[r.cat] ?? r.cat}</Td>
                    <Td right>{show(r.cat, r.mine)}</Td>
                    <Td right>{show(r.cat, r.theirs)}</Td>
                    <Td right>
                      <Signed value={isRatio(r.cat) ? r.edge * 100 : r.edge} digits={isRatio(r.cat) ? 1 : 0} />
                    </Td>
                    <Td>
                      <span className={`text-xs font-semibold uppercase ${tone(r.result)}`}>{r.result}</span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/** A player on the Today card: the board row's identity, team, report and lineup fields. */
export interface TodayRow extends InjuryFields {
  player_id: string;
  full_name: string | null;
  team_id?: string | null;
  injury_group?: string | null;
  injury_status?: string | null;
  lineup_role?: string | null;
  lineup_confirmed?: boolean | null;
  lineup_date?: string | null;
}

// Built once, as in lib/format.ts (#557); tip-off times in the visitor's own zone.
const TODAY_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
const LOCAL_TIME = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });

/** The manager's game day (#464): who plays today, who is listed, who has no game. */
export function Today({ league, players, games, date }: { league: League; players: TodayRow[]; games: TodayGame[]; date: string }) {
  const { plays, listed, idle, leagueGames } = todayGroups(players, games, date);
  // a day with no games has nothing to plan: the card stays away rather than say so (#696)
  if (leagueGames === 0) return null;
  const day = TODAY_DAY.format(new Date(`${date}T12:00:00Z`));
  const time = (iso: string | null) => (iso ? LOCAL_TIME.format(new Date(iso)) : '');
  const line = (s: TodaySlot<TodayRow>) => (
    <li key={s.player.player_id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5" data-player={s.player.player_id}>
      <a href={href(`/p/${league}/${s.player.player_id}/`)} className="font-medium underline-offset-4 hover:underline">
        {s.player.full_name ?? s.player.player_id}
      </a>
      {s.opponent && (
        <span className="text-muted">
          {s.home ? 'v' : '@'} {s.opponent}
          {s.tipoff ? `, ${time(s.tipoff)}` : ''}
        </span>
      )}
      {s.player.lineup_date === date && (
        <LineupTag role={s.player.lineup_role} confirmed={s.player.lineup_confirmed} date={s.player.lineup_date} injuryGroup={s.player.injury_group} />
      )}
      <InjuryTag group={s.player.injury_group} status={s.player.injury_status} detail={injuryDetail(s.player)} />
    </li>
  );
  return (
    <section className="rounded-lg border border-line bg-card p-3" aria-labelledby="today-h" data-testid="today">
      <h2 id="today-h" className="text-sm font-medium tracking-wide text-muted uppercase">
        Today, {day}
      </h2>
      <p className="mt-1 text-sm" data-testid="today-summary">
        {leagueGames === 0 ? (
          <>No games on the schedule today.</>
        ) : (
          <>
            <strong>
              {plays.length} of your {players.length} active players play today
            </strong>
            {listed.length ? `, and ${listed.length} more ${listed.length === 1 ? 'is' : 'are'} on the injury report` : ''}.
            {idle.length ? ` ${idle.length} ${idle.length === 1 ? 'has' : 'have'} no game.` : ''}
          </>
        )}
      </p>
      {leagueGames > 0 && (
        <div className="mt-2 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <h3 className="text-xs font-semibold text-good uppercase">Plays ({plays.length})</h3>
            <ul className="mt-1 grid gap-1" data-testid="today-plays">
              {plays.map(line)}
            </ul>
          </div>
          <div>
            <h3 className="text-xs font-semibold text-warn uppercase">Listed ({listed.length})</h3>
            <ul className="mt-1 grid gap-1" data-testid="today-listed">
              {listed.map(line)}
            </ul>
          </div>
          <div>
            <h3 className="text-xs font-semibold text-muted uppercase">No game ({idle.length})</h3>
            <ul className="mt-1 grid gap-1" data-testid="today-idle">
              {idle.map(line)}
            </ul>
          </div>
        </div>
      )}
    </section>
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
