/**
 * League standings in a categories league (#662): how likely the manager's team is to beat each
 * other team in each category, from the gap between the teams' totals and how much that category
 * moves from week to week. Fit, the Trade page's verdict and its suggestions read the same model,
 * so a gain counts for what it does to the chance of winning categories, not for its size alone.
 *
 * Totals are in the board's units: per-game z-scores above replacement, summed over a team's
 * active players and each weighted by the share of the games left the player is expected to play.
 */
import type { League } from './data';
import type { Format } from './fantasy-league';

/**
 * One game's standard deviation of a player's output in each category, in the z units the board
 * scores (the pool's spread of per-game averages). Measured on the lakehouse: within-player
 * spread over games against the 180 NBA or 90 WNBA players with the most minutes and 20 games or
 * more, averaged over 2023-24 to 2025-26 (NBA) and 2022 to 2026 (WNBA), steady from season to
 * season. A steal or a shooting night swings far more than the gaps between players; points,
 * rebounds and assists about as much.
 */
export const GAME_SPREAD: Record<League, Record<string, number>> = {
  nba: {
    z_points: 1.14,
    z_rebounds_total: 1.1,
    z_assists: 1.03,
    z_steals: 3.12,
    z_blocks: 1.77,
    z_three_pointers_made: 1.61,
    z_turnovers: 1.63,
    z_field_goal_pct: 2.85,
    z_free_throw_pct: 2.67,
  },
  wnba: {
    z_points: 1.13,
    z_rebounds_total: 1.05,
    z_assists: 1.07,
    z_steals: 2.47,
    z_blocks: 1.62,
    z_three_pointers_made: 1.43,
    z_turnovers: 1.82,
    z_field_goal_pct: 2.69,
    z_free_throw_pct: 2.83,
  },
};

/** Games a player's team plays in a fantasy week on average: a regular season's games over its weeks. */
const GAMES_PER_WEEK: Record<League, number> = { nba: 3.3, wnba: 2.6 };

/**
 * The error of a projected per-game z-score against what the player goes on to produce, per
 * category: a rotisserie season's uncertainty beyond its games' own spread. An assumption, not a
 * measurement; a weekly head-to-head matchup is dominated by the games' spread and leaves it out.
 */
const PROJECTION_SPREAD = 0.3;

export interface StandingsModel {
  cats: string[];
  /** The standard deviation of the gap between two teams' totals, per category. */
  spread: Record<string, number>;
}

/**
 * The model for a league whose teams field about `players` active players each. Head-to-head: the
 * gap over one week's games. Rotisserie: over the games left in the season (a week at least),
 * plus the projections' own error.
 */
export function standingsModel(league: League, cats: string[], players: number, format: Format, gamesLeft = 0): StandingsModel {
  const n = Math.max(players, 1);
  const games = format === 'h2h' ? GAMES_PER_WEEK[league] : Math.max(gamesLeft, GAMES_PER_WEEK[league]);
  const spread: Record<string, number> = {};
  for (const c of cats) {
    const game = GAME_SPREAD[league][c] ?? 1;
    const projection = format === 'roto' ? PROJECTION_SPREAD * PROJECTION_SPREAD * 2 * n : 0;
    spread[c] = Math.sqrt((game * game * 2 * n) / games + projection);
  }
  return { cats, spread };
}

/** The standard normal distribution function (Abramowitz and Stegun 7.1.26, error below 1e-7). */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

const normalPdf = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/**
 * A team's category totals: each active player's per-game value above replacement in the
 * category, times the share of the games left the player is expected to play.
 */
export function teamTotals(
  roster: string[],
  cats: string[],
  catValue: (id: string) => Record<string, number> | undefined,
  availability: (id: string) => number,
): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(cats.map((c) => [c, 0]));
  for (const id of roster) {
    const v = catValue(id);
    if (!v) continue;
    const a = availability(id);
    for (const c of cats) out[c] = (out[c] ?? 0) + (v[c] ?? 0) * a;
  }
  return out;
}

/**
 * The team's chance of beating each of `others` in each category, averaged over them: in
 * head-to-head, the chance of winning the category in a week against an average opponent; in
 * rotisserie, the share of the other teams it finishes ahead of.
 */
export function winChances(totals: Record<string, number>[], team: number, others: number[], model: StandingsModel): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of model.cats) {
    const mine = totals[team]?.[c] ?? 0;
    const s = model.spread[c] ?? 1;
    out[c] = others.length ? others.reduce((sum, t) => sum + normalCdf((mine - (totals[t]?.[c] ?? 0)) / s), 0) / others.length : 0.5;
  }
  return out;
}

/** The categories the team is expected to win: the sum of its chances. */
export function expectedWins(chances: Record<string, number>): number {
  return Object.values(chances).reduce((s, p) => s + p, 0);
}

/**
 * Fit weights from the standings: how much one more unit in each category raises the chance of
 * beating the other teams in it, scaled so the weights average 1. A category the team is close in
 * against many teams counts most; one it wins or loses against everyone by a wide margin counts
 * little, whatever its raw total. Null without another team to compare with.
 */
export function standingWeights(totals: Record<string, number>[], team: number, others: number[], model: StandingsModel): Record<string, number> | null {
  if (!others.length || !model.cats.length) return null;
  const raw = model.cats.map((c) => {
    const mine = totals[team]?.[c] ?? 0;
    const s = model.spread[c] ?? 1;
    return others.reduce((sum, t) => sum + normalPdf((mine - (totals[t]?.[c] ?? 0)) / s) / s, 0) / others.length;
  });
  const mean = raw.reduce((s, v) => s + v, 0) / raw.length;
  return Object.fromEntries(model.cats.map((c, i) => [c, mean > 0 ? (raw[i] ?? 0) / mean : 1]));
}

/**
 * The teams to compare against: every other team with at least half a roster entered, so a team
 * the manager has only started to fill in does not read as an easy win.
 */
export function rivals(rosters: string[][], team: number, rosterSpots: number): number[] {
  const least = Math.max(1, Math.ceil(rosterSpots / 2));
  return rosters.map((r, t) => (t !== team && r.length >= least ? t : -1)).filter((t) => t >= 0);
}

/** What the standings read from the league kept here. */
export interface StandingsLeague {
  rosters: string[][];
  mine: number;
  rosterSpots: number;
  il: string[];
  format: Format;
}

export interface LeagueStandings {
  /** Fit weights from the standings (null without a rival). */
  weights: Record<string, number> | null;
  /** The chance of beating an average rival in each category. */
  chances: Record<string, number>;
  /** Every team's category totals (active players only). */
  totals: Record<string, number>[];
  /** The teams compared against. */
  others: number[];
}

/**
 * The manager's standings in the league kept here (#662): every team's totals, each active player
 * counted by the share of the games left they are expected to play, and the chance of beating each
 * rival in each category. Null until another team has half a roster in.
 */
export function leagueStandings(
  league: League,
  setup: StandingsLeague,
  cats: string[],
  catValue: (id: string) => Record<string, number> | undefined,
  availability: (id: string) => number,
  gamesLeft: number,
): LeagueStandings | null {
  const others = rivals(setup.rosters, setup.mine, setup.rosterSpots);
  if (!others.length || !cats.length) return null;
  const active = setup.rosters.map((r) => r.filter((id) => !setup.il.includes(id)));
  const totals = active.map((r) => teamTotals(r, cats, catValue, availability));
  const ranked = [setup.mine, ...others];
  const players = ranked.reduce((s, t) => s + (active[t] ?? []).reduce((n, id) => n + availability(id), 0), 0) / ranked.length;
  const model = standingsModel(league, cats, players, setup.format, gamesLeft);
  return { weights: standingWeights(totals, setup.mine, others, model), chances: winChances(totals, setup.mine, others, model), totals, others };
}
