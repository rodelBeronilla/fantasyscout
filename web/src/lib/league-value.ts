/**
 * Value for the manager's league, computed in the browser from the published board.
 *
 * Categories: each category's value per game is re-measured against the replacement level of
 * this league (the average of the players ranked just outside teams x roster spots, the same
 * definition the lakehouse uses), so at the default league size it equals the published value
 * exactly. Points: fantasy points per game from the projected line with the league's weights,
 * minus the replacement level's. Either way, value above replacement is then counted over the
 * projected share of games played.
 */
import { POINT_STATS, type PointWeights } from './fantasy-league';

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

/** Category values above this league's replacement level, per player id. */
export function categoryValues(rows: Row[], categories: string[], pool: number, teams: number): Map<string, Record<string, number>> {
  const total = (r: Row) => categories.reduce((s, c) => s + n(r, c), 0);
  const repl = replacementLevel(rows, categories, total, pool, teams);
  return new Map(rows.map((r) => [String(r['player_id']), Object.fromEntries(categories.map((c) => [c, n(r, c) - (repl[c] ?? 0)]))]));
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
  const order = Object.entries(teamTotals).sort((a, b) => a[1] - b[1]).map(([c]) => c);
  const third = Math.max(1, Math.round(order.length / 3));
  return Object.fromEntries(order.map((c, i) => [c, i < third ? 1.5 : i >= order.length - third ? 0.5 : 1]));
}

/** The first letter of a player's listed position ("G-F" is a G). */
export const primaryPosition = (position: string | null | undefined): string => (position ?? '').trim().charAt(0).toUpperCase();
