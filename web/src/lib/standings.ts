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
import { PARAMS } from '../generated/parameters';

/**
 * One game's standard deviation of a player's output in each category, in the z units the board
 * scores (the pool's spread of per-game averages). Measured on the lakehouse: within-player
 * spread over games against the 180 NBA or 90 WNBA players with the most minutes and 20 games or
 * more, averaged over 2023-24 to 2025-26 (NBA) and 2022 to 2026 (WNBA), steady from season to
 * season. A steal or a shooting night swings far more than the gaps between players; points,
 * rebounds and assists about as much.
 */
export const GAME_SPREAD: Record<League, Record<string, number>> = PARAMS['standings.game_spread'];

/** Games a player's team plays in a fantasy week on average: a regular season's games over its weeks. */
const GAMES_PER_WEEK: Record<League, number> = PARAMS['standings.games_per_week'];

/**
 * The error of a projected per-game z-score against what the player goes on to produce, per
 * category: a rotisserie season's uncertainty beyond its games' own spread. A weekly head-to-head
 * matchup is dominated by the games' spread and leaves it out.
 */
const PROJECTION_SPREAD: Record<League, number> = PARAMS['standings.projection_spread'];

/**
 * A multiplier on the games' spread of the gap between two teams, in both formats: what the
 * per-game spreads miss over a week (a projection's own error, games that move together). Fitted
 * by the walk-forward backtest (ops/standings_backtest.py, #755).
 */
const SPREAD_SCALE: Record<League, number> = PARAMS['standings.spread_scale'];

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
  const projection = format === 'roto' ? PROJECTION_SPREAD[league] * PROJECTION_SPREAD[league] * 2 * n : 0; // def: the gap between two teams
  for (const c of cats) {
    const game = SPREAD_SCALE[league] * (GAME_SPREAD[league][c] ?? 1);
    spread[c] = Math.sqrt((game * game * 2 * n) / games + projection); // def: the gap between two teams
  }
  return { cats, spread };
}

/** The standard normal distribution function (Abramowitz and Stegun 7.1.26, error below 1e-7). */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z); // def: Abramowitz and Stegun 7.1.26
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))); // def: A&S 7.1.26
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf); // def: the normal distribution
}

const normalPdf = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); // def: the normal density

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
    out[c] = others.length ? others.reduce((sum, t) => sum + normalCdf((mine - (totals[t]?.[c] ?? 0)) / s), 0) / others.length : 0.5; // def: no rival is a coin flip
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
  const least = Math.max(1, Math.ceil(rosterSpots * PARAMS['standings.rival_min_share']));
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

export interface PowerRank {
  team: number;
  /** Expected categories won a week against an average rival (head-to-head) or the share of rivals beaten per category (rotisserie), summed. */
  expectedCats: number;
  /** Head-to-head: the chance of winning a matchup against a team picked at random from the rest, a tie counting half. */
  matchupWin: number | null;
  /** Rotisserie: expected points, one per category plus one per team finished ahead of. */
  rotoPoints: number | null;
}

/**
 * The chance of winning a head-to-head matchup from each category's win chance: the exact
 * distribution of categories won, more than half winning and exactly half splitting.
 */
export function matchupChance(chances: number[]): number {
  let dist = [1];
  for (const p of chances) {
    const next = new Array<number>(dist.length + 1).fill(0);
    dist.forEach((q, k) => {
      next[k] = (next[k] ?? 0) + q * (1 - p);
      next[k + 1] = (next[k + 1] ?? 0) + q * p;
    });
    dist = next;
  }
  const n = chances.length;
  return dist.reduce((s, q, k) => s + (2 * k > n ? q : 2 * k === n ? q / 2 : 0), 0); // def: more than half wins, half splits
}

/**
 * Power rankings (#743): every team with half a roster or more, best first, by what it projects to
 * win under the standings model: in head-to-head, its categories against an average rival and its
 * matchup win rate against the rest; in rotisserie, its expected points. Null with fewer than two.
 */
export function powerRankings(
  league: League,
  setup: StandingsLeague,
  cats: string[],
  catValue: (id: string) => Record<string, number> | undefined,
  availability: (id: string) => number,
  gamesLeft: number,
): PowerRank[] | null {
  const teams = rivals(setup.rosters, -1, setup.rosterSpots);
  if (teams.length < 2 || !cats.length) return null; // def: a ranking needs two teams
  const active = setup.rosters.map((r) => r.filter((id) => !setup.il.includes(id)));
  const totals = active.map((r) => teamTotals(r, cats, catValue, availability));
  const players = teams.reduce((s, t) => s + (active[t] ?? []).reduce((n, id) => n + availability(id), 0), 0) / teams.length;
  const model = standingsModel(league, cats, players, setup.format, gamesLeft);
  const h2h = setup.format === 'h2h';
  const chance = (a: number, b: number, c: string) => normalCdf(((totals[a]?.[c] ?? 0) - (totals[b]?.[c] ?? 0)) / (model.spread[c] ?? 1));
  const out = teams.map((team) => {
    const others = teams.filter((t) => t !== team);
    const expectedCats = expectedWins(winChances(totals, team, others, model));
    const matchupWin = h2h ? others.reduce((s, o) => s + matchupChance(cats.map((c) => chance(team, o, c))), 0) / others.length : null;
    const rotoPoints = h2h ? null : cats.reduce((s, c) => s + 1 + others.reduce((n, o) => n + chance(team, o, c), 0), 0);
    return { team, expectedCats, matchupWin, rotoPoints };
  });
  return out.sort((a, b) => (h2h ? (b.matchupWin ?? 0) - (a.matchupWin ?? 0) : (b.rotoPoints ?? 0) - (a.rotoPoints ?? 0)));
}
