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
 * Tier breaks over values sorted high to low: a new tier starts where the drop to the next
 * player is at least 2.5 times the median drop among the top `span` (at most 12 tiers).
 */
export function tierStarts(values: number[], span = 150): Set<number> {
  const top = values.slice(0, span);
  const gaps = top.slice(1).map((v, i) => (top[i] ?? 0) - v).filter((g) => g >= 0);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted.length ? (sorted[Math.floor(sorted.length / 2)] ?? 0) : 0;
  const threshold = Math.max(median * 2.5, 1e-6);
  const starts = new Set<number>([0]);
  for (let i = 1; i < top.length && starts.size < 12; i += 1) {
    if ((top[i - 1] ?? 0) - (top[i] ?? 0) >= threshold) starts.add(i);
  }
  return starts;
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
