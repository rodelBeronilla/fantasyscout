/**
 * A head-to-head week (#490): each team's projected category totals for the games left this
 * fantasy week (Monday to Sunday), category by category against one opponent. A total is the
 * projected per-game line (the line the board's value is scored on) times each player's games
 * counted: on My Team his started games from the week's lineup plan, which fills the league's
 * slots and leaves out and doubtful players out (#817), so a bench player's games and an injured
 * player's do not count; a percentage is made over attempted. Turnovers go to the lower total.
 * An ESPN category league adds the week's score so far, so the totals are projected finals.
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
  /** Made and attempted behind each percentage category, which a score so far adds to (#817). */
  shots?: Record<string, [number, number]>;
}

/** A team's projected totals for the games left this week, from the rows of its active players. */
export function weekTotals(rows: Row[], cats: string[], weights?: PointWeights, gamesOf?: (row: Row) => number): WeekTotals {
  // the games a player is counted for: his started games when the lineup plan is known (#817),
  // else every game his team has left this week
  const games = gamesOf ?? ((r: Row) => n(r, 'games_this_week'));
  const out: Record<string, number> = {};
  const shots: Record<string, [number, number]> = {};
  for (const c of cats) {
    const counting = COUNTING[c];
    const ratio = RATIO[c];
    if (counting) out[c] = rows.reduce((s, r) => s + n(r, counting) * games(r), 0);
    else if (ratio) {
      const made = rows.reduce((s, r) => s + n(r, ratio[0]) * games(r), 0);
      const attempted = rows.reduce((s, r) => s + n(r, ratio[1]) * games(r), 0);
      out[c] = attempted > 0 ? made / attempted : 0;
      shots[c] = [made, attempted];
    } else out[c] = 0;
  }
  return {
    cats: out,
    games: rows.reduce((s, r) => s + games(r), 0),
    fpts: weights ? rows.reduce((s, r) => s + fantasyPoints(r, weights) * games(r), 0) : 0,
    shots,
  };
}

/** A team's totals so far in this week's matchup, as its host reports them (#817). */
export interface ScoreSoFar {
  /** Each counting category's total so far. */
  totals: Record<string, number>;
  /** Made and attempted so far behind each percentage category, where the host's numbers tell them. */
  shots: Record<string, [number, number]>;
}

export interface LiveWeek {
  mine: WeekTotals;
  theirs: WeekTotals;
  /** The categories the score so far does not give for both sides: these are projected only. */
  projectedOnly: string[];
}

/**
 * The week's projected final from the score so far (#817): each side's totals to date plus the
 * games its lineup starts from today. A percentage adds the shots, made over attempted across
 * both. A category goes from the score only when both sides have it; otherwise both project it.
 */
export function liveWeek(cats: string[], soFar: { mine: ScoreSoFar; theirs: ScoreSoFar }, rest: { mine: WeekTotals; theirs: WeekTotals }): LiveWeek {
  const has = (s: ScoreSoFar, c: string) => (isRatio(c) ? c in s.shots : c in s.totals);
  const projectedOnly = cats.filter((c) => !has(soFar.mine, c) || !has(soFar.theirs, c));
  const final = (s: ScoreSoFar, t: WeekTotals): WeekTotals => {
    const out: Record<string, number> = { ...t.cats };
    const shots: Record<string, [number, number]> = { ...t.shots };
    for (const c of cats) {
      if (projectedOnly.includes(c)) continue;
      if (!isRatio(c)) {
        out[c] = (s.totals[c] ?? 0) + (t.cats[c] ?? 0);
        continue;
      }
      const [made, attempted] = s.shots[c] ?? [0, 0];
      const [restMade, restAttempted] = t.shots?.[c] ?? [0, 0];
      shots[c] = [made + restMade, attempted + restAttempted];
      out[c] = attempted + restAttempted > 0 ? (made + restMade) / (attempted + restAttempted) : 0;
    }
    return { ...t, cats: out, shots };
  };
  return { mine: final(soFar.mine, rest.mine), theirs: final(soFar.theirs, rest.theirs), projectedOnly };
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

/** The category closest to turning either way, by share: where the week's moves count most (#817). */
export function swingCategory(m: WeekMatchup): string | null {
  return m.cats.reduce<CategoryEdge | null>((best, r) => (best === null || r.share < best.share ? r : best), null)?.cat ?? null;
}

/** The week's call, e.g. "Winning 5, losing 3, 1 too close: steals is the swing category" (#817). */
export function matchupCall(m: WeekMatchup, name: (cat: string) => string): string {
  const swing = swingCategory(m);
  return `Winning ${m.wins}, losing ${m.losses}${m.close ? `, ${m.close} too close` : ''}${swing ? `: ${name(swing)} is the swing category` : ''}`;
}

/**
 * Fit weights for the week: the categories within reach count most. Sorted by closeness, the
 * closest third weighs 1.5, the farthest third (won or lost by a lot) 0.5, the middle 1: the
 * same shape as the rotisserie weights, which rank the manager's own categories instead.
 */
export function matchupWeights(rows: CategoryEdge[]): Record<string, number> {
  return thirdsWeights([...rows].sort((a, b) => a.share - b.share).map((r) => r.cat));
}
