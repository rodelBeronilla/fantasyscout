/**
 * A head-to-head week (#490): each team's projected category totals for the games left this
 * fantasy week (Monday to Sunday), category by category against one opponent. A total is the
 * projected per-game line (the line the board's value is scored on) times each player's games
 * left; a percentage is made over attempted. Turnovers go to the lower total.
 */
import type { PointWeights } from './fantasy-league';
import { fantasyPoints, thirdsWeights } from './league-value';
import { PARAMS } from '../generated/parameters';

type Row = Record<string, unknown>;

const n = (row: Row, key: string): number => {
  const v = row[key];
  return typeof v === 'number' && !Number.isNaN(v) ? v : 0;
};

/** The projected per-game column behind each counting category. */
const COUNTING: Record<string, string> = {
  z_points: 'proj_points_pg',
  z_rebounds_total: 'proj_rebounds_total_pg',
  z_assists: 'proj_assists_pg',
  z_steals: 'proj_steals_pg',
  z_blocks: 'proj_blocks_pg',
  z_three_pointers_made: 'proj_three_pointers_made_pg',
  z_turnovers: 'proj_turnovers_pg',
};
/** Made and attempted behind each percentage category. */
const RATIO: Record<string, [string, string]> = {
  z_field_goal_pct: ['proj_fgm_pg', 'proj_fga_pg'],
  z_free_throw_pct: ['proj_ftm_pg', 'proj_fta_pg'],
};
const LOWER_WINS = new Set(['z_turnovers']);
export const isRatio = (cat: string): boolean => cat in RATIO;

export interface WeekTotals {
  /** Each category's projected total for the week (a percentage as a ratio 0 to 1). */
  cats: Record<string, number>;
  /** Games left this week over the roster. */
  games: number;
  /** Fantasy points for the week under the league's weights, when given. */
  fpts: number;
}

/** A team's projected totals for the games left this week, from the rows of its active players. */
export function weekTotals(rows: Row[], cats: string[], weights?: PointWeights): WeekTotals {
  const games = (r: Row) => n(r, 'games_this_week');
  const out: Record<string, number> = {};
  for (const c of cats) {
    const counting = COUNTING[c];
    const ratio = RATIO[c];
    if (counting) out[c] = rows.reduce((s, r) => s + n(r, counting) * games(r), 0);
    else if (ratio) {
      const made = rows.reduce((s, r) => s + n(r, ratio[0]) * games(r), 0);
      const attempted = rows.reduce((s, r) => s + n(r, ratio[1]) * games(r), 0);
      out[c] = attempted > 0 ? made / attempted : 0;
    } else out[c] = 0;
  }
  return {
    cats: out,
    games: rows.reduce((s, r) => s + games(r), 0),
    fpts: weights ? rows.reduce((s, r) => s + fantasyPoints(r, weights) * games(r), 0) : 0,
  };
}

export interface CategoryEdge {
  cat: string;
  mine: number;
  theirs: number;
  /** The manager's margin in the category's own unit; positive favours the manager (turnovers reversed). */
  edge: number;
  /** The margin as a share of the larger total: how close the category is. */
  share: number;
  result: 'win' | 'loss' | 'close';
}

export interface WeekMatchup {
  cats: CategoryEdge[];
  wins: number;
  losses: number;
  close: number;
  mine: WeekTotals;
  theirs: WeekTotals;
}

/** Category by category against the opponent; a margin within `closeness` of the larger total is too close to call. */
export function matchup(cats: string[], mine: WeekTotals, theirs: WeekTotals, closeness: number = PARAMS['matchup.closeness']): WeekMatchup {
  const rows = cats.map((cat): CategoryEdge => {
    const a = mine.cats[cat] ?? 0;
    const b = theirs.cats[cat] ?? 0;
    const edge = LOWER_WINS.has(cat) ? b - a : a - b;
    const share = Math.abs(edge) / Math.max(Math.abs(a), Math.abs(b), 1e-9); // def: no division by zero
    return { cat, mine: a, theirs: b, edge, share, result: share <= closeness ? 'close' : edge > 0 ? 'win' : 'loss' };
  });
  return {
    cats: rows,
    wins: rows.filter((r) => r.result === 'win').length,
    losses: rows.filter((r) => r.result === 'loss').length,
    close: rows.filter((r) => r.result === 'close').length,
    mine,
    theirs,
  };
}

/**
 * Fit weights for the week: the categories within reach count most. Sorted by closeness, the
 * closest third weighs 1.5, the farthest third (won or lost by a lot) 0.5, the middle 1: the
 * same shape as the rotisserie weights, which rank the manager's own categories instead.
 */
export function matchupWeights(rows: CategoryEdge[]): Record<string, number> {
  return thirdsWeights([...rows].sort((a, b) => a.share - b.share).map((r) => r.cat));
}
