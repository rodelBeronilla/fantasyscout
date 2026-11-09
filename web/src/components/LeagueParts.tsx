/** League pieces shared by the League page and the board: settings, the summary bar, the draft bar, a team's profile. */
import type { ReactNode } from 'react';

import { CATEGORIES, CATEGORY_LABELS } from '../lib/format';
import { normalizeSlots, SLOT_KEYS, SLOT_LABEL } from '../lib/lineup';
import {
  DEFAULT_SETTINGS,
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
import { pickupsPath } from '../lib/pickups-url';
import { href } from '../lib/site';
import { type TodayGame, todayGroups, type TodaySlot, type TodayVerdict } from '../lib/today';
import { UNIT_LABEL, type ValueUnit } from '../lib/week-value';
import { PlayoffSettings } from './PlayoffSettings';
import type { PlayerNotes } from '../lib/player-notes';
import { PlayerNoteLine } from './PlayerNoteLine';
import { Chip, InjuryTag, injuryDetail, type InjuryFields, LineupTag, Segmented, Signed, Unvalidated } from './ui';

const SCORING_LABEL: Record<Scoring, string> = { cats9: '9-cat', cats8: '8-cat (no TO)', points: 'Points' };

const FORMAT_LABEL: Record<Format, string> = { roto: 'rotisserie', h2h: 'head-to-head' };

export function describeSettings(s: LeagueSetup): string {
  const punts = s.scoring === 'points' ? [] : s.punts.map((c) => CATEGORY_LABELS[c] ?? c);
  return `${s.teams} teams × ${s.rosterSpots}, ${SCORING_LABEL[s.scoring]}${s.format === 'h2h' ? `, ${FORMAT_LABEL[s.format]}` : ''}${
    punts.length ? `, punting ${punts.join(', ')}` : ''
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
  // the lineup and the playoffs do not change values (so not part of isDefaultSettings), but Reset puts them back too
  const lineupDefault =
    SLOT_KEYS.every((k) => setup.lineup[k] === d.lineup[k]) &&
    setup.playoffs.teams === d.playoffs.teams &&
    setup.playoffs.weeks === d.playoffs.weeks &&
    setup.playoffs.start === d.playoffs.start;
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
        {(!isDefault || !lineupDefault) && (
          <button
            type="button"
            onClick={() => onChange((s) => ({ ...s, teams: d.teams, rosterSpots: d.rosterSpots, scoring: d.scoring, weights: d.weights, format: d.format, punts: d.punts, lineup: d.lineup, playoffs: d.playoffs }))}
            className="rounded border border-line px-2 py-1 text-xs hover:bg-bg"
          >
            Reset settings
          </button>
        )}
      </div>
      <fieldset className="flex flex-wrap items-end gap-3" data-testid="league-lineup">
        <legend className="mb-1 text-xs text-muted">
          Starting lineup: the slots you fill each day. PG and SG count as G, SF and PF as F; the weekly lineup planner on My Team uses them.
        </legend>
        {SLOT_KEYS.map((k) => (
          <label key={k} className="grid gap-1">
            <span className="text-xs text-muted">{SLOT_LABEL[k]}</span>
            <input
              type="number"
              min={0}
              max={6}
              value={setup.lineup[k]}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) onChange((s) => ({ ...s, lineup: normalizeSlots({ ...s.lineup, [k]: n }, s.lineup) }));
              }}
              className={`${field} w-16`}
              aria-label={`${SLOT_LABEL[k]} slots`}
            />
          </label>
        ))}
      </fieldset>
      {setup.format === 'h2h' && <PlayoffSettings setup={setup} onChange={onChange} />}
      {setup.scoring !== 'points' && (
        <fieldset className="grid gap-2" data-testid="league-punts">
          <legend className="text-xs text-muted">
            Punt: categories you give up on. Every page values players without them: Rankings, the player pages, Pickups, Trade and My Team. They are set here only.
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
  quiet = false,
}: {
  setup: LeagueSetup;
  rostered: number;
  myCount: number;
  weakest: string[];
  /** What the listed categories are: the manager's weakest, or the ones behind this week. */
  weakLabel?: string;
  /** One muted line rather than a card: the board's settings line (#714). */
  quiet?: boolean;
}) {
  if (quiet) {
    return (
      <p className="text-sm text-muted" data-testid="league-bar">
        Valued for <span data-testid="league-summary">{describeSettings(setup)}</span>
        {rostered > 0 ? (
          <>
            {' · '}
            <a href={href('/team/')} className="text-fg underline-offset-4 hover:underline">
              {setup.names[setup.mine]} ({myCount}/{setup.rosterSpots})
            </a>
          </>
        ) : null}
        {' · '}
        <a href={href('/league/')} className="font-medium text-accent underline-offset-4 hover:underline">
          {rostered > 0 ? 'Edit league' : 'Set up your league'} →
        </a>
      </p>
    );
  }
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
    <section id="upgrades" className="rounded-lg border border-line bg-card p-3" aria-labelledby="upgrades-h" data-testid="upgrades">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="upgrades-h" className="text-sm font-medium tracking-wide text-muted uppercase">
          Moves
          <Unvalidated issue={895} what="The roster review" />
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
          {week ? 'this week' : 'for the rest of the season'} than one of yours you could drop, under your league&apos;s scoring.
          {review.weakest && review.weakest.add && !review.chips.includes(review.weakest.drop) && (
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
      {review.chips.length > 0 && (
        <p className="mt-1 text-sm" data-testid="roster-chips">
          <span className="text-muted">Trade, don&apos;t drop: </span>
          {review.chips.map((id, i) => (
            <span key={id}>
              {i > 0 ? ', ' : ''}
              {player(id)}
            </span>
          ))}
          <span className="text-muted">
            {' '}
            {review.chips.length === 1 ? 'adds' : 'add'} less to your build than a free agent, but other managers rank{' '}
            {review.chips.length === 1 ? 'this player' : 'them'} among the starters.{' '}
          </span>
          <a href={href('/trade/')} className="underline underline-offset-4">
            Shop on the Trade page
          </a>
          .
          <Unvalidated issue={896} what="Trade, don't drop" />
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
  news_flag?: string | null;
}

// Built once, as in lib/format.ts (#557); tip-off times in the visitor's own zone.
const TODAY_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
const LOCAL_TIME = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });

/** The manager's game day (#464): who plays today, who is listed, who has no game. */
export function Today({
  league,
  players,
  games,
  date,
  verdict,
  need = [],
  minutesFor,
  notes,
}: {
  league: League;
  players: TodayRow[];
  /** The day's one-line notes on flagged players (#823), shown under each it has one for. */
  notes?: PlayerNotes | null;
  games: TodayGame[];
  date: string;
  /** Start and sit for today (#816), when the lineup slots and values are known. */
  verdict?: TodayVerdict | null;
  /** The matchup's close and losing categories, preselected on Pickups (#818). */
  need?: string[];
  /** Who takes an out player's minutes (#820), beside each one in the Out row; null when unknown. */
  minutesFor?: (id: string) => ReactNode;
}) {
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
      <PlayerNoteLine notes={notes} row={s.player} today={date} />
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
            {listed.length ? `, and ${listed.length} more ${listed.length === 1 ? 'is' : 'are'} on the injury report or inactive` : ''}.
            {idle.length ? ` ${idle.length} ${idle.length === 1 ? 'has' : 'have'} no game.` : ''}
          </>
        )}
      </p>
      {verdict && <TodayCalls league={league} verdict={verdict} players={players} time={time} pickups={href(pickupsPath(league, { open: [date], need }))} minutesFor={minutesFor} />}
      {leagueGames > 0 && (
        <details className="mt-2 text-sm" open={!verdict} data-testid="today-all">
          <summary className="cursor-pointer text-xs text-muted">All of today&apos;s players</summary>
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
        </details>
      )}
    </section>
  );
}

/**
 * Today's calls first (#816): who to start, who sits for want of a slot, who to check before
 * tip-off, who is out, and the open slots to stream into. The full lists follow, one click down.
 */
function TodayCalls({
  league,
  verdict,
  players,
  time,
  pickups,
  minutesFor,
}: {
  league: League;
  verdict: TodayVerdict;
  players: TodayRow[];
  time: (iso: string | null) => string;
  /** Pickups for today, with the matchup's need categories when there is one (#818). */
  pickups: string;
  minutesFor?: (id: string) => ReactNode;
}) {
  const name = new Map(players.map((p) => [p.player_id, p.full_name ?? p.player_id]));
  const who = (id: string) => (
    <a href={href(`/p/${league}/${id}/`)} className="font-medium underline-offset-4 hover:underline">
      {name.get(id) ?? id}
    </a>
  );
  return (
    <div className="mt-2 grid gap-2 text-sm" data-testid="today-calls">
      {verdict.start.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-good uppercase">Start ({verdict.start.length})</h3>
          <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1" data-testid="today-start">
            {verdict.start.map((r) => (
              <li key={r.id} data-player={r.id}>
                {who(r.id)} <span className="text-muted">{r.slot}</span>
                {r.checkBy && <span className="ml-1 text-warn" data-testid="check-by">listed: check by {time(r.checkBy)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {verdict.bench.length > 0 && (
        <p data-testid="today-bench">
          <span className="text-xs font-semibold text-muted uppercase">Bench</span> {verdict.bench.map((r, i) => <span key={r.id}>{i ? ', ' : ''}{who(r.id)}</span>)}
          <span className="text-muted">: a game today, but no slot left</span>
        </p>
      )}
      {verdict.check.length > 0 && (
        <p data-testid="today-check">
          <span className="text-xs font-semibold text-warn uppercase">Check</span> {verdict.check.map((r, i) => <span key={r.id}>{i ? ', ' : ''}{who(r.id)}{r.tipoff ? ` (tip ${time(r.tipoff)})` : ''}</span>)}
          <span className="text-muted">: doubtful; start only if the report clears him</span>
        </p>
      )}
      {verdict.out.length > 0 && (
        <p data-testid="today-out">
          <span className="text-xs font-semibold text-bad uppercase">Out</span>{' '}
          {verdict.out.map((r, i) => {
            const minutes = minutesFor?.(r.id) ?? null;
            return (
              <span key={r.id} data-player={r.id}>
                {i ? ', ' : ''}
                {who(r.id)}
                {r.inactive && (
                  <span className="text-muted" data-testid="out-inactive">
                    {' '}
                    (inactive on the team&apos;s lineup)
                  </span>
                )}
                {minutes && <> · {minutes}</>}
              </span>
            );
          })}
          {verdict.out.some((r) => minutesFor?.(r.id)) && <Unvalidated issue={763} what="Who takes an out player's minutes" />}
        </p>
      )}
      {verdict.open.length > 0 && (
        <p data-testid="today-open">
          <strong>{verdict.open.length} open {verdict.open.length === 1 ? 'slot' : 'slots'}</strong> ({verdict.open.join(', ')}):{' '}
          <a href={pickups} className="text-accent underline-offset-4 hover:underline" data-testid="today-pickups">
            stream into {verdict.open.length === 1 ? 'it' : 'them'}
          </a>
        </p>
      )}
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
