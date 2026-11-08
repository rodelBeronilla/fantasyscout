/**
 * A head-to-head week (#490): each team's projected category totals for the games left this
 * fantasy week (Monday to Sunday), category by category against one opponent. A total is the
 * projected per-game line (the line the board's value is scored on) times each player's games
 * counted: on My Team his started games from the week's lineup plan, which fills the league's
 * slots and leaves out and doubtful players out (#817), so a bench player's games and an injured
 * player's do not count; a percentage is made over attempted. Turnovers go to the lower total.
 * An ESPN category league adds the week's score so far, so the totals are projected finals.
 */
import type { League } from './data';
import type { PointWeights } from './fantasy-league';
import { fantasyPoints, thirdsWeights } from './league-value';
import { normalCdf } from './standings';
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

/** The key a points league's score so far keeps its fantasy points under (#877). */
export const FPTS = 'fpts';

/** A team's totals so far in this week's matchup, as its host reports them (#817). */
export interface ScoreSoFar {
  /** Each counting category's total so far; in a points league, the fantasy points (`FPTS`). */
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
 * games its lineup starts from today, a game of today's that had tipped at the read counted only
 * for what was still to play of it (#875). A percentage adds the shots, made over attempted across
 * both. A category goes from the score only when both sides have it; otherwise both project it.
 * A points league's fantasy points add up the same way (#877).
 */
export function liveWeek(cats: string[], soFar: { mine: ScoreSoFar; theirs: ScoreSoFar }, rest: { mine: WeekTotals; theirs: WeekTotals }): LiveWeek {
  const points = FPTS in soFar.mine.totals && FPTS in soFar.theirs.totals;
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
    return { ...t, cats: out, shots, fpts: points ? (s.totals[FPTS] ?? 0) + t.fpts : t.fpts };
  };
  return { mine: final(soFar.mine, rest.mine), theirs: final(soFar.theirs, rest.theirs), projectedOnly };
}

/**
 * The score so far a week can start from (#877): a points league's needs both sides' fantasy
 * points, so a score without them (a host that gave categories only) counts as none.
 */
export function usableScore<S extends { mine: ScoreSoFar; theirs: ScoreSoFar } | string>(score: S, points: boolean): S | 'no-score' {
  if (!points || typeof score === 'string') return score;
  const both = score as { mine: ScoreSoFar; theirs: ScoreSoFar };
  return FPTS in both.mine.totals && FPTS in both.theirs.totals ? score : 'no-score';
}

export interface CategoryEdge {
  cat: string;
  mine: number;
  theirs: number;
  /** The manager's margin in the category's own unit; positive favours the manager (turnovers reversed). */
  edge: number;
  /** The margin as a share of the larger total. */
  share: number;
  /** The manager's chance of winning the category this week, from the week's measured spread (#869). */
  chance: number;
  result: 'win' | 'loss' | 'close';
}

export interface WeekMatchup {
  league: League;
  cats: CategoryEdge[];
  wins: number;
  losses: number;
  close: number;
  mine: WeekTotals;
  theirs: WeekTotals;
}

/**
 * One game's spread of a player's output in each category, in the category's own unit (a
 * percentage's as makes less the pool's rate times attempts): fitted on the tuning seasons by the
 * matchup card's backtest (ops/closeness_backtest.py, #869).
 */
const GAME_SPREAD: Record<League, Record<string, number>> = PARAMS['matchup.game_spread'];

/**
 * The manager's chance of winning a category this week (#869): Φ(margin ÷ s). A counting
 * category's s is σ √(games left, both sides); a percentage's is σ √(G₁ ÷ A₁² + G₂ ÷ A₂²), each
 * side's games left over its attempts squared, so a percentage settles as the shots add up. With
 * no games left the margin is the result.
 */
export function categoryChance(league: League, cat: string, mine: WeekTotals, theirs: WeekTotals, edge: number): number {
  const sigma = GAME_SPREAD[league][cat] ?? 1;
  const perShot = (t: WeekTotals) => {
    const attempted = t.shots?.[cat]?.[1] ?? 0;
    return attempted > 0 ? t.games / (attempted * attempted) : 0;
  };
  const variance = sigma * sigma * (isRatio(cat) ? perShot(mine) + perShot(theirs) : mine.games + theirs.games);
  const s = Math.sqrt(variance);
  if (s > 0) return normalCdf(edge / s);
  return edge > 0 ? 1 : edge < 0 ? 0 : 1 / 2; // def: no games left, the margin is the result
}

/** How far a category's chance is from a coin flip: 0 for an even one. */
const fromEven = (r: CategoryEdge) => Math.abs(r.chance - 1 / 2); // def: a coin flip

/**
 * Category by category against the opponent: a category whose chance lies within `closeness` of
 * 50% is too close to call (#869).
 */
export function matchup(league: League, cats: string[], mine: WeekTotals, theirs: WeekTotals, closeness: number = PARAMS['matchup.closeness']): WeekMatchup {
  const rows = cats.map((cat): CategoryEdge => {
    const a = mine.cats[cat] ?? 0;
    const b = theirs.cats[cat] ?? 0;
    const edge = LOWER_WINS.has(cat) ? b - a : a - b;
    const share = Math.abs(edge) / Math.max(Math.abs(a), Math.abs(b), 1e-9); // def: no division by zero
    const chance = categoryChance(league, cat, mine, theirs, edge);
    return { cat, mine: a, theirs: b, edge, share, chance, result: Math.abs(chance - 1 / 2) <= closeness ? 'close' : edge > 0 ? 'win' : 'loss' }; // def: a coin flip
  });
  return {
    league,
    cats: rows,
    wins: rows.filter((r) => r.result === 'win').length,
    losses: rows.filter((r) => r.result === 'loss').length,
    close: rows.filter((r) => r.result === 'close').length,
    mine,
    theirs,
  };
}

/** The category closest to turning either way, its chance nearest a coin flip: where the week's moves count most (#817). */
export function swingCategory(m: WeekMatchup): string | null {
  return m.cats.reduce<CategoryEdge | null>((best, r) => (best === null || fromEven(r) < fromEven(best) ? r : best), null)?.cat ?? null;
}

/** The chances "too close" covers, as the card names them: "45% to 55%". */
export function closeBand(closeness: number = PARAMS['matchup.closeness']): string {
  const pct = (p: number) => `${Math.round(p * 100)}%`; // def: a percentage
  return `${pct(1 / 2 - closeness)} to ${pct(1 / 2 + closeness)}`; // def: around a coin flip
}

/** The categories nearest a coin flip first. */
export function byCloseness(rows: CategoryEdge[]): CategoryEdge[] {
  return [...rows].sort((a, b) => fromEven(a) - fromEven(b));
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
  return thirdsWeights(byCloseness(rows).map((r) => r.cat));
}
