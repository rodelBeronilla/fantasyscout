/**
 * The Board's numbers, as plain functions over its rows (#633): the rest-of-season value the
 * Trade page shares, each row's value in the view shown, and the ranks and tiers over that order.
 * The component keeps only the useMemo calls, so these are tested without rendering the page.
 */
import type { BoardView } from './board-url';
import { leagueTiers, marketPriorShift, primaryPosition, scaleValue, type ScaleRow, type Tier } from './league-value';

/** A board row as these functions read it: the scale fields, a position and any column by name. */
export interface ModelRow extends ScaleRow {
  player_id: string;
  position: string | null;
  [key: string]: unknown;
}

/** The two views that show a stat line rather than category z-scores. */
export const isLine = (view: BoardView) => view === 'pergame' || view === 'projected';

const Z_PREFIX: Partial<Record<BoardView, string>> = { season: 'season_', last20: 'last20_', recent: 'recent_' };

/** The column of a category's z-score in a windowed view ("season_z_points"), or the category itself. */
export function zKey(view: BoardView, category: string): string {
  return `${Z_PREFIX[view] ?? ''}${category}`;
}

/** A numeric column, or null when it is missing or not a number. */
export function num(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  return typeof v === 'number' && !Number.isNaN(v) ? v : null;
}

/** What the league-sized values are: per-category values (categories) or points (a points league). */
export interface LeagueValues {
  points: boolean;
  leaguePoints: Map<string, { fpts: number; value: number }> | null;
  leagueCats: Map<string, Record<string, number>> | null;
  activeCats: string[];
  /** This league's replacement level per category on the published scale, taken from the windowed views too (ADR 0019). */
  replacement?: Record<string, number> | null;
}

/** Rest-of-season value under the league's scoring, per player: the scale the Trade page uses; a categories league's carries the market prior (#848). */
export function restValues(rows: ModelRow[], { points, leaguePoints, leagueCats, activeCats }: LeagueValues): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const v = points
      ? (leaguePoints?.get(r.player_id)?.value ?? 0)
      : activeCats.reduce((s, c) => s + (leagueCats?.get(r.player_id)?.[c] ?? 0), 0) + marketPriorShift(r);
    out.set(r.player_id, scaleValue(v, r));
  }
  return out;
}

export interface Scored<R> {
  row: R;
  /** The value shown in the view: league value, a stat line's points, or the window's value above this league's replacement level; null when the view has none. */
  value: number | null;
  /** League value weighted by the manager's category needs (the value view of a categories league with weights). */
  fit: number | null;
}

/** Each row's value in the view shown. */
export function scoreRows<R extends ModelRow>(
  rows: R[],
  opts: LeagueValues & { view: BoardView; countGames: boolean; restOfSeason: boolean; weights: Record<string, number> | null },
): Scored<R>[] {
  const { view, activeCats, leagueCats, leaguePoints, weights } = opts;
  const scale = (r: R, v: number) => scaleValue(v, r, { countGames: opts.countGames, restOfSeason: opts.restOfSeason });
  return rows.map((r) => {
    let value: number | null;
    let fit: number | null = null;
    if (isLine(view)) {
      value = num(r, view === 'projected' ? 'proj_points_pg' : 'points_pg');
    } else if (view === 'value' && leaguePoints) {
      value = scale(r, leaguePoints.get(r.player_id)?.value ?? 0);
    } else if (view === 'value' && leagueCats) {
      const cats = leagueCats.get(r.player_id) ?? {};
      // the market prior's shift as a total on top of the categories, as mart_board's value (#848)
      const prior = marketPriorShift(r);
      value = scale(r, activeCats.reduce((s, c) => s + (cats[c] ?? 0), 0) + prior);
      if (weights) fit = scale(r, activeCats.reduce((s, c) => s + (weights[c] ?? 1) * (cats[c] ?? 0), 0) + prior);
    } else {
      const parts = activeCats.map((c) => num(r, zKey(view, c)));
      const repl = opts.replacement ?? {};
      value = parts.every((p) => p === null) ? null : parts.reduce<number>((s, p, i) => s + (p ?? 0) - (repl[activeCats[i] ?? ''] ?? 0), 0);
    }
    return { row: r, value, fit };
  });
}

export interface Ranking {
  /** Position rank in the current value order ("G3"). */
  posRank: Map<string, string>;
  /** Overall rank under this league's settings, for the gap to the market. */
  overall: Map<string, number>;
  /** In the value view: the tiers, each player's tier, and how many in each are on no roster. */
  tiers: { list: Tier[]; of: Map<string, number>; left: Map<number, number> } | null;
}

/** Position ranks and tiers, over every player in the current value order. */
export function rankAndTier<R extends ModelRow>(
  scored: Scored<R>[],
  opts: { view: BoardView; teams: number; rosterSpots: number; owned: (id: string) => boolean },
): Ranking {
  const order = [...scored].filter((s) => s.value !== null).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const counts = new Map<string, number>();
  const posRank = new Map<string, string>();
  const overall = new Map(order.map((s, i) => [s.row.player_id, i + 1]));
  for (const s of order) {
    const p = primaryPosition(s.row.position);
    if (!p) continue;
    counts.set(p, (counts.get(p) ?? 0) + 1);
    posRank.set(s.row.player_id, `${p}${counts.get(p)}`);
  }
  if (opts.view !== 'value') return { posRank, overall, tiers: null };
  const list = leagueTiers(order.map((s) => s.value ?? 0), opts.teams, opts.rosterSpots);
  const of = new Map<string, number>();
  const left = new Map<number, number>();
  for (const t of list) {
    const members = order.slice(t.start, t.end + 1);
    for (const s of members) of.set(s.row.player_id, t.tier);
    left.set(t.tier, members.filter((s) => !opts.owned(s.row.player_id)).length);
  }
  return { posRank, overall, tiers: { list, of, left } };
}
