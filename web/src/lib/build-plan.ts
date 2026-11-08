/**
 * Build your team (#809): for a categories league over the rest of the season, where the team
 * stands in each category, the players worth going after, the players it can spare, and the one
 * move that makes each happen.
 *
 * With rival rosters in, everything is judged by the standings model the Trade page uses (ADR
 * 0015): a target is scored by the expected categories won when he takes the place of the least
 * useful player (the one whose loss costs the fewest), and a move must gain at least the
 * meaningful change. Without them there is no league to win categories against, so the plan falls
 * back to Fit's need-weighted value across the whole board and leaves the deals out. Punted
 * categories are not in `cats`, so they count for nothing either way. Pure functions over
 * per-player values, so My Team and the tests share them.
 */
import { weightedSum } from './fantasy-league';
import { fitWeights } from './league-value';
import { keepsPositions } from './players';
import { rivals } from './standings';
import { type LeagueState, meaningful, scoreWith, type Standings, teamNeeds, tradeImpact } from './trade-impact';
import { combinations } from './trade-suggest';
import { PARAMS } from '../generated/parameters';

/**
 * What a category is for the team: a swing category (close against the league, where a gain moves
 * most), one it has locked or is conceding; without the standings, its weakest or strongest third.
 */
export type CategoryLabel = 'swing' | 'locked' | 'conceding' | 'weak' | 'strong';

export interface CategoryStanding {
  cat: string;
  /** The team's place in the category among the teams compared (1 is best); null without the standings. */
  rank: number | null;
  teams: number | null;
  /** The chance of beating an average rival in the category; null without the standings. */
  chance: number | null;
  labels: CategoryLabel[];
}

/** A category a player moves: the change in the team's chance of winning it, or without the standings his need-weighted value in it. */
interface Reason {
  cat: string;
  delta: number;
}

/** The one move suggested for a player: a pickup (add a free agent, drop a player) or a trade. */
export type Move =
  | { kind: 'pickup'; add: string; drop: string; gain: number }
  | { kind: 'trade'; partner: number; give: string[]; get: string[]; gain: number; partnerGain: number };

export interface PlanPlayer {
  id: string;
  /** The team the player is on; null for a free agent. */
  team: number | null;
  /**
   * Targets: the gain in expected categories won (without the standings, need-weighted value).
   * Surplus: what losing him costs in expected categories (without, his need-weighted value).
   * Lowest value: his rest-of-season value.
   */
  score: number;
  /** The categories he moves most: up for a target, what the team would lose for a player let go. */
  reasons: Reason[];
  move: Move | null;
}

export interface BuildPlan {
  /** True when the standings model judged the plan (a rival roster is in). */
  standings: boolean;
  picture: CategoryStanding[];
  punted: string[];
  targets: PlanPlayer[];
  /** The players whose loss costs the fewest expected categories (without the standings, the lowest need-weighted value). */
  surplus: PlanPlayer[];
  /** The lowest rest-of-season value. */
  lowest: PlanPlayer[];
}

/** The standings model and the fairness check (league-model.ts), present when a rival roster is in. */
export interface PlanModel {
  state: LeagueState;
  standings: Standings;
  /** Not a bad trade for the manager on value or market (#692). */
  acceptable: (partner: number, give: string[], get: string[]) => boolean;
}

export interface PlanInput {
  /** The kept categories (after the league's punts). */
  cats: string[];
  punted: string[];
  mine: number;
  /** The manager's active players. */
  roster: string[];
  /** Every other player on the board: the candidates without the standings. */
  others: string[];
  /** The team of each rostered player. */
  owner: (id: string) => number | undefined;
  /** Rest-of-season value above replacement. */
  rest: (id: string) => number;
  /** Per-game category values above replacement. */
  catValue: (id: string) => Record<string, number> | undefined;
  /** Value per game scaled to the rest of the season, as the board scales it (league-value.ts scaleValue). */
  scale: (id: string, perGame: number) => number;
  /** Each player's position ("G-F"): no move leaves a position letter the roster covers uncovered (#489). */
  position: (id: string) => string | null | undefined;
  /** Whether a player may be dropped for a free agent (#710); absent, anyone may be. */
  droppable?: (id: string) => boolean;
  model: PlanModel | null;
  /** Names per list. */
  limit?: number;
}

const LIMIT = 5; // display: names per list

/** The categories a player moves most in the direction asked: up (+1) for a target, down (-1) for a player let go. */
function topReasons(deltas: Reason[], sign: 1 | -1, least: number): Reason[] {
  return deltas
    .filter((r) => sign * r.delta >= least)
    .sort((a, b) => sign * b.delta - sign * a.delta)
    .slice(0, 3); // display: categories named
}

export function buildPlan(input: PlanInput): BuildPlan {
  return input.model ? withStandings(input, input.model) : withoutStandings(input);
}

/** Without a rival roster: Fit's need-weighted value across the whole board, and no deals. */
function withoutStandings(input: PlanInput): BuildPlan {
  const { cats, roster, catValue, rest } = input;
  const limit = input.limit ?? LIMIT;
  const totals = Object.fromEntries(cats.map((c) => [c, roster.reduce((s, id) => s + (catValue(id)?.[c] ?? 0), 0)]));
  const weights = fitWeights(totals);
  const need = (id: string) => input.scale(id, weightedSum(catValue(id), weights));
  const contributions = (id: string): Reason[] => cats.map((c) => ({ cat: c, delta: (weights[c] ?? 0) * (catValue(id)?.[c] ?? 0) }));
  const row = (id: string, score: number, sign: 1 | -1): PlanPlayer => ({
    id,
    team: input.owner(id) ?? null,
    score,
    reasons: topReasons(sign === 1 ? contributions(id) : contributions(id).map((r) => ({ ...r, delta: -r.delta })), sign, Number.MIN_VALUE),
    move: null,
  });
  const thirds = PARAMS['fit.thirds'];
  return {
    standings: false,
    picture: cats.map((c) => ({
      cat: c,
      rank: null,
      teams: null,
      chance: null,
      labels: weights[c] === thirds.weak ? ['weak'] : weights[c] === thirds.strong ? ['strong'] : [],
    })),
    punted: input.punted,
    targets: [...input.others]
      .sort((a, b) => need(b) - need(a))
      .slice(0, limit)
      .map((id) => row(id, need(id), 1)),
    surplus: [...roster]
      .sort((a, b) => need(a) - need(b))
      .slice(0, limit)
      .map((id) => row(id, need(id), -1)),
    lowest: [...roster]
      .sort((a, b) => rest(a) - rest(b))
      .slice(0, limit)
      .map((id) => row(id, rest(id), -1)),
  };
}

/** With rival rosters in: the standings model judges every candidate and every move. */
function withStandings(input: PlanInput, model: PlanModel): BuildPlan {
  const { state, standings } = model;
  const { mine, roster, rest } = input;
  const limit = input.limit ?? LIMIT;
  const threshold = meaningful(state, mine);
  const moved: number = PARAMS['trade.category_change'];
  const before = scoreWith(state, standings, mine, roster);
  const swap = (out: string[], incoming: string[]) => [...roster.filter((id) => !out.includes(id)), ...incoming];
  const keeps = (after: string[]) => keepsPositions(roster, after, input.position);
  const deltas = (chances: Record<string, number>): Reason[] => state.cats.map((c) => ({ cat: c, delta: (chances[c] ?? 0) - (before.chances[c] ?? 0) }));
  const mayDrop = (id: string) => !input.droppable || input.droppable(id);
  const positive = (id: string) => rest(id) > 0;
  const valueOf = (ids: string[]) => ids.reduce((s, id) => s + Math.max(0, rest(id)), 0);

  // What losing each player costs: the expected categories won without him, his spot left open.
  const removal = new Map(roster.map((id) => [id, scoreWith(state, standings, mine, swap([id], []))]));
  const cost = (id: string) => before.score - (removal.get(id)?.score ?? before.score);
  const expendable = [...roster].sort((a, b) => cost(a) - cost(b) || rest(a) - rest(b));

  /**
   * A player in for the most expendable one the positions (and, for a pickup, the drop rule)
   * allow. A free agent leaves every other team as it stands; a rostered player is a one-for-one
   * trade, so his team's totals change too, as the Trade page counts them.
   */
  const swapIn = (id: string, team: number | null) => {
    for (const out of expendable) {
      if (team === null && !mayDrop(out)) continue;
      const after = swap([out], [id]);
      if (!keeps(after)) continue;
      if (team === null) {
        const s = scoreWith(state, standings, mine, after);
        return { drop: out, gain: s.score - before.score, chances: s.chances };
      }
      const e = tradeImpact(state, standings, mine, team, [out], [id]);
      return { drop: out, gain: e.mine.gain, chances: e.mine.after };
    }
    return null;
  };

  /**
   * The trade judged as the finder judges one (#664): it raises the manager's categories by the
   * meaningful change, passes the fairness check, and gives the partner a reason to say yes (their
   * categories rise, or they gain value).
   */
  const trade = (partner: number, give: string[], get: string[]): Move | null => {
    if (!keeps(swap(give, get))) return null;
    const e = tradeImpact(state, standings, mine, partner, give, get);
    if (e.mine.gain < threshold) return null;
    if (e.partner.gain <= 0 && valueOf(get) - valueOf(give) > 0) return null;
    if (!model.acceptable(partner, give, get)) return null;
    return { kind: 'trade', partner, give, get, gain: e.mine.gain, partnerGain: e.partner.gain };
  };
  const better = (a: Move | null, b: Move | null) => {
    if (!a) return b;
    if (!b) return a;
    const size = (m: Move) => (m.kind === 'trade' ? m.give.length + m.get.length : 1);
    return b.gain > a.gain || (b.gain === a.gain && size(b) < size(a)) ? b : a;
  };

  const partners = rivals(state.rosters, mine, state.rosterSpots);
  const freeAgents = state.freeAgents.filter(positive).slice(0, PARAMS['roster.candidates']);
  const rostered = partners.flatMap((team) => (state.rosters[team] ?? []).filter(positive).map((id) => ({ id, team })));

  // Let go: the cheapest to lose, and the lowest value.
  const letGo = (id: string, score: number): PlanPlayer => ({
    id,
    team: mine,
    score,
    reasons: topReasons(deltas(removal.get(id)?.chances ?? before.chances), -1, moved),
    move: null,
  });
  const surplus = expendable.slice(0, limit).map((id) => letGo(id, cost(id)));
  const lowest = [...roster]
    .sort((a, b) => rest(a) - rest(b))
    .slice(0, limit)
    .map((id) => letGo(id, rest(id)));
  const spare = [...new Set([...surplus, ...lowest].map((p) => p.id))].filter(positive);

  /** A player let go: his best free-agent replacement if it gains enough, else his best trade. */
  const replacement = new Map<string, Move | null>();
  const replace = (id: string): Move | null => {
    if (replacement.has(id)) return replacement.get(id) ?? null;
    let best: Move | null = null;
    if (mayDrop(id)) {
      for (const fa of freeAgents) {
        const after = swap([id], [fa]);
        if (!keeps(after)) continue;
        const gain = scoreWith(state, standings, mine, after).score - before.score;
        if (gain >= threshold) best = better(best, { kind: 'pickup', add: fa, drop: id, gain });
      }
    }
    if (!best) for (const r of rostered) best = better(best, trade(r.team, [id], [r.id]));
    replacement.set(id, best);
    return best;
  };

  // Targets: free agents and players on rival rosters, by what they add in the place of the least
  // useful player; a free agent needs a player the drop rule lets go, a rostered one a fair package
  // from the players let go. The package search is the slow part, so it stops after the trade
  // search's pool of rostered players.
  const scored = [...freeAgents.map((id) => ({ id, team: null as number | null })), ...rostered]
    .map((c) => ({ ...c, s: swapIn(c.id, c.team) }))
    .filter((c) => c.s && c.s.gain >= threshold)
    .sort((a, b) => (b.s?.gain ?? 0) - (a.s?.gain ?? 0));
  const packages = combinations(spare, PARAMS['trade.search'].max_add);
  const targets: PlanPlayer[] = [];
  let searched = 0;
  for (const c of scored) {
    if (targets.length >= limit || !c.s) break;
    let move: Move | null;
    if (c.team === null) {
      move = { kind: 'pickup', add: c.id, drop: c.s.drop, gain: c.s.gain };
    } else {
      if (searched >= PARAMS['trade.search'].pool) continue;
      searched += 1;
      move = null;
      for (const give of packages) move = better(move, trade(c.team, give, [c.id]));
      if (!move) continue;
    }
    targets.push({ id: c.id, team: c.team, score: c.s.gain, reasons: topReasons(deltas(c.s.chances), 1, moved), move });
  }

  const needs = teamNeeds(state, standings, mine);
  const mineTotals = standings.totals[mine] ?? {};
  return {
    standings: true,
    picture: state.cats.map((c) => ({
      cat: c,
      rank: 1 + partners.filter((t) => (standings.totals[t]?.[c] ?? 0) > (mineTotals[c] ?? 0)).length,
      teams: partners.length + 1,
      chance: before.chances[c] ?? null,
      labels: [
        ...(needs.swing.includes(c) ? (['swing'] as const) : []),
        ...(needs.locked.includes(c) ? (['locked'] as const) : []),
        ...(needs.conceding.includes(c) ? (['conceding'] as const) : []),
      ],
    })),
    punted: input.punted,
    targets,
    surplus: surplus.map((p) => ({ ...p, move: replace(p.id) })),
    lowest: lowest.map((p) => ({ ...p, move: replace(p.id) })),
  };
}
