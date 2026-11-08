/**
 * Value for the manager's league, computed in the browser from the published board.
 *
 * Categories: each category's value per game is re-measured against the replacement level of
 * this league (the average of the players ranked just outside teams x roster spots, the same
 * definition the lakehouse uses), so at the default league size it equals the published value
 * exactly. The replacement level is measured once, on the projection, and the same offset is
 * taken from every window (the last ten games, the season), so they stay on the projection's
 * scale (ADR 0019). Points: fantasy points per game from the projected line with the league's weights,
 * minus the replacement level's. Either way, value above replacement is then counted over the
 * projected share of games played.
 *
 * A categories league's projected value also carries the market prior (ADR 0020), as a total on
 * top of the categories (`marketPriorShift`), so it matches the published value per game. The
 * windows (last ten, last twenty, the season) do not carry it, as on the board. Nor does a points
 * league: the prior was fitted and judged on the nine-category value only.
 */
import { POINT_STATS, type PointWeights } from './fantasy-league';
import { CATEGORIES } from './format';
import { PARAMS } from '../generated/parameters';

type Row = Record<string, unknown>;

const n = (row: Row, key: string): number => {
  const v = row[key];
  return typeof v === 'number' && !Number.isNaN(v) ? v : 0;
};

/** Mean of each key over the players ranked pool+1 .. pool+teams by `score`. */
export function replacementLevel(rows: Row[], keys: string[], score: (row: Row) => number, pool: number, teams: number): Record<string, number> {
  const ranked = [...rows].sort((a, b) => score(b) - score(a));
  const band = ranked.slice(Math.min(pool, Math.max(ranked.length - teams, 0)), pool + teams);
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = band.length ? band.reduce((s, r) => s + n(r, k), 0) / band.length : 0;
  return out;
}

/**
 * This league's replacement level per category on the published scale, measured on `basis` (the
 * board's projected values): zero at the default league size, the offset for any other.
 */
export function categoryReplacement(basis: Row[], categories: string[], pool: number, teams: number): Record<string, number> {
  const total = (r: Row) => categories.reduce((s, c) => s + n(r, c), 0);
  return replacementLevel(basis, categories, total, pool, teams);
}

/**
 * Category values above this league's replacement level, per player id. The level is measured
 * on `basis`, the projection, whichever window `rows` holds, so a window's values are on the
 * projection's scale rather than re-centred on their own.
 */
export function categoryValues(
  rows: Row[],
  categories: string[],
  pool: number,
  teams: number,
  basis: Row[] = rows,
): Map<string, Record<string, number>> {
  const repl = categoryReplacement(basis, categories, pool, teams);
  return new Map(rows.map((r) => [String(r['player_id']), Object.fromEntries(categories.map((c) => [c, n(r, c) - (repl[c] ?? 0)]))]));
}

/** What the market prior reads of a board row (ADR 0020). */
export interface PriorRow {
  market_prior_weight?: number | null;
  market_prior_value?: number | null;
}

/**
 * The market prior's shift of a player's value per game in a categories league (ADR 0020, #848).
 * mart_board blends the nine categories' sum toward market_prior_value, the board's own value at
 * the player's rank in ESPN's draft order: `own + weight * (market - own)`. It leaves the nine
 * category columns alone, so a league value rebuilt from them adds the same shift as a total.
 *
 * Both terms are on the board's nine-category scale, and the shift is their difference. A league
 * of another size only moves every player by its replacement offset, which cancels, so the shift
 * is the one its own curve would give. A punt build keeps the shift whole: the draft order prices
 * a player's whole game, and repricing his rank on a punt build's curve would pull the categories
 * the manager gave up back in. Zero when the weight is (the WNBA, a player past the fade, between
 * seasons) or the player has no market price.
 */
export function marketPriorShift(board: object): number {
  // a board row: the prior's two columns (PriorRow) and the nine categories' z_ columns
  const row = board as Row;
  const weight = n(row, 'market_prior_weight');
  const market = row['market_prior_value'];
  if (!(weight > 0) || typeof market !== 'number' || Number.isNaN(market)) return 0;
  const own = CATEGORIES.reduce((s, c) => s + n(row, c), 0);
  return weight * (market - own);
}

export function fantasyPoints(row: Row, weights: PointWeights): number {
  return POINT_STATS.reduce((s, stat) => s + weights[stat.key] * n(row, stat.column), 0);
}

/** Points per game above this league's replacement level, per player id. */
export function pointValues(rows: Row[], weights: PointWeights, pool: number, teams: number): Map<string, { fpts: number; value: number }> {
  const fpts = new Map(rows.map((r) => [String(r['player_id']), fantasyPoints(r, weights)]));
  const repl = replacementLevel(rows.map((r) => ({ player_id: r['player_id'], fpts: fpts.get(String(r['player_id'])) ?? 0 })), ['fpts'], (r) => n(r, 'fpts'), pool, teams);
  return new Map([...fpts].map(([id, f]) => [id, { fpts: f, value: f - (repl['fpts'] ?? 0) }]));
}

/**
 * Exact one-dimensional clustering (Jenks natural breaks): the split of values, sorted high to
 * low, into at most `k` runs with the least squared deviation within the runs. Returns the index
 * each run starts at.
 */
export function naturalBreaks(values: number[], k: number): number[] {
  const n = values.length;
  if (n === 0) return [];
  const runs = Math.max(1, Math.min(k, n));
  const s1 = [0];
  const s2 = [0];
  for (const v of values) {
    s1.push((s1.at(-1) ?? 0) + v);
    s2.push((s2.at(-1) ?? 0) + v * v);
  }
  // Squared deviation of values[i..j] about their mean.
  const cost = (i: number, j: number) => {
    const sum = (s1[j + 1] ?? 0) - (s1[i] ?? 0);
    return (s2[j + 1] ?? 0) - (s2[i] ?? 0) - (sum * sum) / (j - i + 1);
  };
  let prev = values.map((_, j) => cost(0, j));
  const back: number[][] = [];
  for (let m = 1; m < runs; m += 1) {
    const cur = new Array<number>(n).fill(Infinity);
    const from = new Array<number>(n).fill(m);
    for (let j = m; j < n; j += 1) {
      for (let i = m; i <= j; i += 1) {
        const c = (prev[i - 1] ?? Infinity) + cost(i, j);
        if (c < (cur[j] ?? Infinity)) {
          cur[j] = c;
          from[j] = i;
        }
      }
    }
    back.push(from);
    prev = cur;
  }
  const starts = [0];
  let j = n - 1;
  for (let m = runs - 1; m >= 1; m -= 1) {
    const i = back[m - 1]?.[j] ?? 0;
    starts.push(i);
    j = i - 1;
  }
  return [...new Set(starts)].sort((a, b) => a - b);
}

export interface Tier {
  tier: number;
  /** First and last player of the tier, as positions in the value order (from 0). */
  start: number;
  end: number;
  high: number;
  low: number;
  /** Rounds of a draft in this league the tier's picks fall in (from 1). */
  firstRound: number;
  lastRound: number;
}

/**
 * Tiers for a league: the players a league this size rosters (teams x roster spots), split into
 * one tier per roster spot where their values naturally separate, so a tier is a run of players
 * of about the same value and its picks say where it goes in a draft.
 */
export function leagueTiers(values: number[], teams: number, rosterSpots: number): Tier[] {
  const pool = values.slice(0, teams * rosterSpots);
  const starts = naturalBreaks(pool, rosterSpots);
  const round = (i: number) => Math.floor(i / teams) + 1;
  return starts.map((start, t) => {
    const end = (starts[t + 1] ?? pool.length) - 1;
    return { tier: t + 1, start, end, high: pool[start] ?? 0, low: pool[end] ?? 0, firstRound: round(start), lastRound: round(end) };
  });
}

/**
 * Weights for the categories by how the manager's team stands in them: the weakest third count
 * 1.5, the middle third 1, the strongest third 0.5 (in head-to-head categories, shoring up a
 * weak category wins more weeks than piling onto a strong one).
 */
export function fitWeights(teamTotals: Record<string, number>): Record<string, number> {
  return thirdsWeights(Object.entries(teamTotals).sort((a, b) => a[1] - b[1]).map(([c]) => c));
}

/**
 * Weights by thirds of an ordered list of categories, most in need first (fit.thirds): the first
 * third, the middle and the last. Fit's fallback before a rival roster is in, and the week's.
 */
export function thirdsWeights(order: string[]): Record<string, number> {
  const w = PARAMS['fit.thirds'];
  const third = Math.max(1, Math.round(order.length / 3)); // def: a third of the categories
  return Object.fromEntries(order.map((c, i) => [c, i < third ? w.weak : i >= order.length - third ? w.strong : w.middle]));
}

/** The first letter of a player's listed position ("G-F" is a G). */
export const primaryPosition = (position: string | null | undefined): string => (position ?? '').trim().charAt(0).toUpperCase();

/** The row fields that turn value per game into value over a season. */
export interface ScaleRow {
  games_share?: number | null;
  ros_factor?: number | null;
  season_complete?: boolean | null;
}

/**
 * Value per game above replacement, scaled to the season the way mart_board does (#478): only a
 * positive value counts games (times the projected share of team games played), because a game
 * missed by a player not worth rostering costs nothing; and only a positive value is scaled to the
 * rest of the season (times ros_factor, the team's remaining share of its regular season times
 * the player's availability), except once the season is over. The SQL's value_total is
 * `scaleValue(v, row, { restOfSeason: false })` and its value_rest_of_season `scaleValue(v, row)`.
 */
export function scaleValue(perGame: number, row: ScaleRow, { countGames = true, restOfSeason = true } = {}): number {
  let value = perGame;
  if (value > 0 && countGames) value *= row.games_share ?? 1;
  if (value > 0 && restOfSeason && !row.season_complete) value *= row.ros_factor ?? 1;
  return value;
}

