/**
 * What a trade does to the two teams in a categories league (#663): both rosters after it, with
 * the roster spots settled, and each team's expected categories won before and after, from the
 * standings model (ADR 0015). The Trade page's verdict and its suggestions read it, so a package
 * is judged by the categories it wins, not by its total value alone.
 */
import type { League } from './data';
import type { Format } from './fantasy-league';
import { expectedWins, rivals, standingsModel, type StandingsModel, standingWeights, teamTotals, winChances } from './standings';
import { PARAMS } from '../generated/parameters';

export interface LeagueState {
  league: League;
  format: Format;
  /** The kept categories (after the league's punts). */
  cats: string[];
  /** Each team's active players (not on the injured list). */
  rosters: string[][];
  rosterSpots: number;
  /** Players on no roster, best first: who fills a spot a trade opens. */
  freeAgents: string[];
  /** Value above replacement: the player a side drops when it receives more than it sends. */
  rest: (id: string) => number;
  /** Per-game category values above replacement. */
  catValue: (id: string) => Record<string, number> | undefined;
  /** The share of the games left the player is expected to play. */
  availability: (id: string) => number;
  /** Games left in the season, for a rotisserie league's spread. */
  gamesLeft: number;
}

export interface Standings {
  model: StandingsModel;
  /** Each team's category totals before any trade. */
  totals: Record<string, number>[];
}

/** The league's standings before a trade, or null with no rival roster to compare against. */
export function leagueStandings(state: LeagueState, team: number): Standings | null {
  const others = rivals(state.rosters, team, state.rosterSpots);
  if (!others.length || !state.cats.length) return null;
  const totals = state.rosters.map((r) => teamTotals(r, state.cats, state.catValue, state.availability));
  const ranked = [team, ...others];
  const players = ranked.reduce((s, t) => s + (state.rosters[t] ?? []).reduce((n, id) => n + state.availability(id), 0), 0) / ranked.length;
  return { model: standingsModel(state.league, state.cats, players, state.format, state.gamesLeft), totals };
}

export interface SideAfter {
  team: number;
  after: string[];
  /** Players the side drops to make room for the extra players it receives. */
  dropped: string[];
  /** Free agents the side picks up for the spots it opens. */
  added: string[];
}

/**
 * Both rosters after the trade. A side that receives more players than it sends drops its
 * lowest-valued players to stay at its size; one that sends more picks up the best free agents,
 * the manager's side first.
 */
export function rostersAfter(state: LeagueState, mine: number, partner: number, give: string[], get: string[]): { mine: SideAfter; partner: SideAfter } {
  const taken = new Set<string>([...give, ...get]);
  const settle = (team: number, out: string[], incoming: string[]): SideAfter => {
    const before = state.rosters[team] ?? [];
    let after = [...before.filter((id) => !out.includes(id)), ...incoming];
    const dropped: string[] = [];
    while (after.length > before.length) {
      const worst = after.reduce((w, id) => (state.rest(id) < state.rest(w) ? id : w));
      after = after.filter((id) => id !== worst);
      dropped.push(worst);
    }
    const added: string[] = [];
    for (const id of state.freeAgents) {
      if (after.length >= before.length) break;
      if (taken.has(id)) continue;
      taken.add(id);
      after.push(id);
      added.push(id);
    }
    return { team, after, dropped, added };
  };
  return { mine: settle(mine, give, get), partner: settle(partner, get, give) };
}

interface TeamChange {
  /** The chance of winning each kept category: a week against an average rival (head-to-head), or the share of rivals beaten (rotisserie). */
  before: Record<string, number>;
  after: Record<string, number>;
  /** Expected categories won in a week (head-to-head), or rotisserie points. */
  scoreBefore: number;
  scoreAfter: number;
  gain: number;
}

export interface TradeImpact {
  /** The manager's category totals before and after. */
  totals: { before: Record<string, number>; after: Record<string, number> };
  mine: TeamChange;
  partner: TeamChange;
  sides: { mine: SideAfter; partner: SideAfter };
  /** The categories where the manager's chance rises, and where it falls, by at least two points. */
  ups: string[];
  downs: string[];
  /** The same for the partner (#682). */
  partnerUps: string[];
  partnerDowns: string[];
}

/** Head-to-head: expected categories won a week. Rotisserie: points, one per category plus one per rival finished ahead of. */
function score(state: LeagueState, chances: Record<string, number>, rivalCount: number): number {
  const wins = expectedWins(chances);
  return state.format === 'roto' ? Object.keys(chances).length + wins * rivalCount : wins;
}

/**
 * The team's chances and score with `roster` in place of its own, every other team as it stands: a
 * pickup or a drop judged on the same scale as a trade (#809).
 */
export function scoreWith(state: LeagueState, standings: Standings, team: number, roster: string[]): { chances: Record<string, number>; score: number } {
  const totals = [...standings.totals];
  totals[team] = teamTotals(roster, state.cats, state.catValue, state.availability);
  const others = rivals(state.rosters, team, state.rosterSpots);
  const chances = winChances(totals, team, others, standings.model);
  return { chances, score: score(state, chances, others.length) };
}

/** What the trade does to both teams' rosters and standings. */
export function tradeImpact(state: LeagueState, standings: Standings, mine: number, partner: number, give: string[], get: string[]): TradeImpact {
  const sides = rostersAfter(state, mine, partner, give, get);
  const totals = [...standings.totals];
  totals[mine] = teamTotals(sides.mine.after, state.cats, state.catValue, state.availability);
  totals[partner] = teamTotals(sides.partner.after, state.cats, state.catValue, state.availability);
  const change = (team: number): TeamChange => {
    const others = rivals(state.rosters, team, state.rosterSpots);
    const before = winChances(standings.totals, team, others, standings.model);
    const after = winChances(totals, team, others, standings.model);
    const scoreBefore = score(state, before, others.length);
    const scoreAfter = score(state, after, others.length);
    return { before, after, scoreBefore, scoreAfter, gain: scoreAfter - scoreBefore };
  };
  const m = change(mine);
  const p = change(partner);
  const moves = (t: TeamChange) => ({
    up: state.cats.filter((c) => (t.after[c] ?? 0) - (t.before[c] ?? 0) >= PARAMS['trade.category_change']),
    down: state.cats.filter((c) => (t.before[c] ?? 0) - (t.after[c] ?? 0) >= PARAMS['trade.category_change']),
  });
  const mm = moves(m);
  const pm = moves(p);
  return {
    totals: { before: standings.totals[mine] ?? {}, after: totals[mine] ?? {} },
    mine: m,
    partner: p,
    sides,
    ups: mm.up,
    downs: mm.down,
    partnerUps: pm.up,
    partnerDowns: pm.down,
  };
}

export interface TeamNeeds {
  /** The categories a gain moves most: close against the league (the standings weights' top three). */
  swing: string[];
  /** The categories the team is conceding: under a one-in-four chance against the league. */
  conceding: string[];
  /** The categories the team has locked: over a three-in-four chance. */
  locked: string[];
}

/** A team's needs read from the standings: where a gain matters, and what it concedes or has locked (#682). */
export function teamNeeds(state: LeagueState, standings: Standings, team: number): TeamNeeds {
  const others = rivals(state.rosters, team, state.rosterSpots);
  const chances = winChances(standings.totals, team, others, standings.model);
  const weights = standingWeights(standings.totals, team, others, standings.model) ?? {};
  return {
    swing: [...state.cats].sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0)).slice(0, 3), // display: categories named
    conceding: state.cats.filter((c) => (chances[c] ?? 0.5) < PARAMS['trade.chance_bands'].conceding), // def: unknown is a coin flip
    locked: state.cats.filter((c) => (chances[c] ?? 0.5) > PARAMS['trade.chance_bands'].locked), // def: unknown is a coin flip
  };
}

export type Objective = 'win-win' | 'you' | 'them' | 'even' | 'neither';

/**
 * The trade judged from both sides by each team's change in expected categories: good for both
 * (win-win, only when both gain), for one side, about even for both, or a loss for both. A change
 * smaller than `threshold` counts as even.
 */
export function objective(mineGain: number, partnerGain: number, threshold: number): Objective {
  const me = mineGain >= threshold ? 1 : mineGain <= -threshold ? -1 : 0;
  const them = partnerGain >= threshold ? 1 : partnerGain <= -threshold ? -1 : 0;
  if (me > 0 && them > 0) return 'win-win';
  if (me > 0) return 'you';
  if (them > 0) return 'them';
  if (me === 0 && them === 0) return 'even';
  return 'neither';
}

/**
 * The smallest change worth calling (per league, fitted by the walk-forward backtest, #756):
 * categories a week in head-to-head, or the same share of the rivals in rotisserie points.
 */
export function meaningful(state: LeagueState, team: number): number {
  const gain: number = PARAMS['trade.meaningful_gain'][state.league];
  return state.format === 'roto' ? gain * Math.max(1, rivals(state.rosters, team, state.rosterSpots).length) : gain;
}
