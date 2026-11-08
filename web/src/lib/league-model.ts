/**
 * The league as the trade tools read it (#809): each player's worth under the league's settings,
 * the league state the standings model runs on (ADR 0015), the market's price of each player, and
 * the fairness check a suggested trade must pass. The Trade page and My Team's build plan share
 * them, so a move suggested on one page is judged the same way on the other. Pure functions; the
 * components keep only the memoising.
 */
import type { League } from './data';
import { type Format, weightedSum } from './fantasy-league';
import { scaleValue, type ScaleRow } from './league-value';
import { type LeagueState, rostersAfter } from './trade-impact';
import { type Lens, lens, limits, marketValues } from './trade-fairness';
import { weekValue } from './week-value';

/** A player's worth under the league's settings: per game, over the season, for the rest of it, and for this fantasy week. */
export interface Worth {
  perGame: number;
  season: number;
  rest: number;
  week: number;
  cats: Record<string, number>;
  fpts: number | null;
}

/** What the worth reads of a board row. */
export interface WorthRow extends ScaleRow {
  player_id: string;
  games_this_week?: number | null;
}

export interface WorthInput {
  /** A points league scores fantasy points; a categories league its kept categories. */
  points: boolean;
  /** The kept categories (after the league's punts). */
  cats: string[];
  /** Each kept category's weight: 1, a punted one left out. */
  catWeight: Record<string, number>;
  /** Per-game category values above this league's replacement level, in a categories league. */
  catValues: Map<string, Record<string, number>> | null;
  /** Fantasy points a game and their value above replacement, in a points league. */
  pointValues: Map<string, { fpts: number; value: number }> | null;
  /** Last-ten form's category values, for the week's figure; null leaves it on the projection. */
  recentCats: Map<string, Record<string, number>> | null;
}

/** Every player's worth under the league's settings. */
export function playerWorth(rows: WorthRow[], input: WorthInput): Map<string, Worth> {
  const { points, cats, catWeight, catValues, pointValues, recentCats } = input;
  const out = new Map<string, Worth>();
  for (const r of rows) {
    const c: Record<string, number> = {};
    if (catValues) for (const k of cats) c[k] = catValues.get(r.player_id)?.[k] ?? 0;
    const pv = pointValues?.get(r.player_id);
    const perGame = points ? (pv?.value ?? 0) : weightedSum(c, catWeight);
    const season = scaleValue(perGame, r, { restOfSeason: false });
    const rest = scaleValue(perGame, r);
    const recent = points ? perGame : weightedSum(recentCats?.get(r.player_id), catWeight);
    out.set(r.player_id, { perGame, season, rest, week: weekValue(recent, r.games_this_week), cats: c, fpts: pv ? pv.fpts : null });
  }
  return out;
}

/** What the league state reads of a board row. */
export interface StateRow {
  player_id: string;
  availability_multiplier?: number | null;
  games_remaining?: number | null;
}

export interface StateInput {
  league: League;
  format: Format;
  points: boolean;
  cats: string[];
  rosters: string[][];
  il: string[];
  rosterSpots: number;
  /** Each rostered player's team. */
  owner: Map<string, number>;
  worth: Map<string, Worth>;
  /** Judge on this fantasy week's figure rather than the rest of the season's. */
  week: boolean;
}

/**
 * The league as the standings model reads it (#663, ADR 0015): active rosters, free agents best
 * first, each player's category values and the share of the games left he is expected to play.
 * A categories league with rosters in only; null otherwise.
 */
export function leagueState(rows: StateRow[], input: StateInput): LeagueState | null {
  if (input.points || input.owner.size === 0) return null;
  const { worth, week, owner, il } = input;
  const availability = new Map(rows.map((r) => [r.player_id, r.availability_multiplier ?? 1]));
  const value = (id: string) => {
    const w = worth.get(id);
    return w ? (week ? w.week : w.rest) : 0;
  };
  return {
    league: input.league,
    format: input.format,
    cats: input.cats,
    rosters: input.rosters.map((r) => r.filter((id) => !il.includes(id))),
    rosterSpots: input.rosterSpots,
    freeAgents: rows
      .filter((r) => !owner.has(r.player_id))
      .map((r) => r.player_id)
      .sort((a, b) => value(b) - value(a)),
    rest: value,
    catValue: (id) => worth.get(id)?.cats,
    availability: (id) => availability.get(id) ?? 1,
    gamesLeft: rows.reduce((m, r) => Math.max(m, r.games_remaining ?? 0), 0),
  };
}

/**
 * The market's price of each player (#692): his ESPN rank, priced at the rest-of-season value the
 * board's player of that rank has, so it reads on the same scale as the projected value.
 */
export function marketMap(rows: { player_id: string; market_rank?: number | null }[], worth: Map<string, Worth>): Map<string, number> {
  return marketValues(rows, (id) => worth.get(id)?.rest ?? 0);
}

/** What the fairness check reads: the league, the manager's team, and the two prices of a player. */
export interface FairnessModel {
  /** The league whose limits apply. */
  league: League;
  /** Null without rosters: the roster spots are not settled. */
  state: LeagueState | null;
  mine: number;
  /** The figure a trade is judged on: rest of season, or this fantasy week. */
  value: (id: string) => number;
  market: Map<string, number>;
  /** Whether the market ranks the player at all. */
  ranked: (id: string) => boolean;
}

/** A trade's value and market lenses for the manager, the roster spots settled (#692). */
export function tradeLenses(model: FairnessModel, partner: number, give: string[], get: string[]): { value: Lens; market: Lens | null; settled: ReturnType<typeof rostersAfter>['mine'] | null } {
  const settled = model.state && partner >= 0 ? rostersAfter(model.state, model.mine, partner, give, get).mine : null;
  const outgoing = [...give, ...(settled?.dropped ?? [])];
  const incoming = [...get, ...(settled?.added ?? [])];
  const value = lens(outgoing, incoming, model.value);
  const ranked = [...give, ...get].some(model.ranked);
  const market = ranked ? lens(outgoing, incoming, (id) => model.market.get(id) ?? 0) : null;
  return { value, market, settled };
}

/** Not a bad trade for the manager on value or market: what suggestions, the finder and the build plan keep (#692). */
export function acceptable(model: FairnessModel, partner: number, give: string[], get: string[]): boolean {
  const { value, market } = tradeLenses(model, partner, give, get);
  const { value: v, market: m } = limits(model.league);
  return value.share > v.bad && (!market || market.share > m.bad);
}
