/**
 * Trade suggestions: given the players a manager has fixed on one or both sides of a trade with a
 * partner, the packages from the open side's roster worth making. In a categories league with
 * rival rosters in, a package must raise the manager's expected categories won (#663) and be one
 * the partner could accept: it costs them little value, or it helps their categories too. Without
 * that model (a points league, or no rival rosters) it must make the two sides about even in value.
 * Pure functions over per-player values, so the Trade page and tests share them.
 */
import { keepsPositions } from './players';

/** What a package does to both teams' categories, from the standings model (trade-impact.ts). */
export interface CategoryEffect {
  /** The manager's change in expected categories won (rotisserie: points). */
  gain: number;
  /** The partner's. */
  partnerGain: number;
  /** Categories where the manager's chance rises, and where it falls. */
  ups: string[];
  downs: string[];
}

export interface SuggestInput {
  /** Players already fixed on each side. At least one side must have a player. */
  give: string[];
  get: string[];
  /** Rosters the open sides fill from: the manager's and the partner's active players. */
  mine: string[];
  theirs: string[];
  /** Rest-of-season value above replacement, per player. */
  rest: Map<string, number>;
  /** The category effect of a package; absent in a points league or without rival rosters. */
  effect?: (give: string[], get: string[]) => CategoryEffect;
  /** The least category gain a suggestion must bring the manager. */
  minGain?: number;
  /** Only packages that raise the partner's expected categories too (#682). */
  winWin?: boolean;
  /** Whether a package is fair enough to suggest: not a bad trade for the manager on value or market (#692). */
  acceptable?: (give: string[], get: string[]) => boolean;
  /** The most players a suggestion adds to a side. */
  maxAdd?: number;
  /** How much value the partner may give up (or, without the category model, how far apart the sides may be), as a share of the larger side. */
  tolerance?: number;
  limit?: number;
  /** Each player's position ("G-F"); when given, no package leaves a position letter the manager's roster covers uncovered (#489). */
  position?: (id: string) => string | null | undefined;
}

export interface Suggestion {
  give: string[];
  get: string[];
  /** Rest-of-season value the manager gains (negative: gives up); the partner gains the opposite. */
  net: number;
  /** The category effect, when the model applies. */
  effect: CategoryEffect | null;
}

/** Every subset of `items` with 1 to `max` members. */
export function combinations<T>(items: T[], max: number): T[][] {
  const out: T[][] = [];
  const walk = (start: number, chosen: T[]) => {
    if (chosen.length) out.push(chosen);
    if (chosen.length >= max) return;
    for (let i = start; i < items.length; i += 1) walk(i + 1, [...chosen, items[i] as T]);
  };
  walk(0, []);
  return out;
}

/** The side a suggestion fills: the one with nothing fixed, or with both fixed, the lighter one. */
export function openSide(give: string[], get: string[], rest: Map<string, number>): 'give' | 'get' {
  if (!give.length) return 'give';
  if (!get.length) return 'get';
  const value = (ids: string[]) => ids.reduce((s, id) => s + (rest.get(id) ?? 0), 0);
  return value(give) < value(get) ? 'give' : 'get';
}

export function suggestTrades(input: SuggestInput): Suggestion[] {
  const { give, get, rest, effect } = input;
  const maxAdd = input.maxAdd ?? 3;
  const tolerance = input.tolerance ?? 0.15;
  const limit = input.limit ?? 8;
  const minGain = input.minGain ?? 0.05;
  if (!give.length && !get.length) return [];
  const value = (ids: string[]) => ids.reduce((s, id) => s + Math.max(0, rest.get(id) ?? 0), 0);

  const open = openSide(give, get, rest);
  const roster = (open === 'give' ? input.mine : input.theirs).filter((id) => !give.includes(id) && !get.includes(id));
  // The biggest names first, and no more than 16 candidates, keep the search small.
  // Only players worth more than replacement: one below it adds nothing a free agent would not,
  // so padding a package with him only makes the trade look more even than it is.
  const candidates = [...roster]
    .filter((id) => (rest.get(id) ?? 0) > 0)
    .sort((a, b) => (rest.get(b) ?? 0) - (rest.get(a) ?? 0))
    .slice(0, 16);
  const add = give.length && get.length ? Math.min(maxAdd, 2) : maxAdd;

  const out: Suggestion[] = [];
  for (const combo of combinations(candidates, add)) {
    const g = open === 'give' ? [...give, ...combo] : give;
    const r = open === 'get' ? [...get, ...combo] : get;
    const net = value(r) - value(g);
    const scale = Math.max(value(g), value(r), 1);
    if (input.position && !keepsPositions(input.mine, [...input.mine.filter((id) => !g.includes(id)), ...r], input.position)) continue;
    if (input.acceptable && !input.acceptable(g, r)) continue;
    if (effect) {
      // Worth making: the manager's categories rise. One the partner could accept: it costs them
      // little value, or their categories rise too.
      const e = effect(g, r);
      if (e.gain < minGain) continue;
      if (input.winWin ? e.partnerGain <= 0 : net > tolerance * scale && e.partnerGain < 0) continue;
      out.push({ give: g, get: r, net, effect: e });
    } else {
      if (Math.abs(net) > tolerance * scale) continue;
      out.push({ give: g, get: r, net, effect: null });
    }
  }
  // The biggest category gain first (then the partner's), or without the model the trade that
  // favours the manager most; then the simpler package.
  const size = (s: Suggestion) => s.give.length + s.get.length;
  out.sort((a, b) =>
    a.effect && b.effect
      ? b.effect.gain - a.effect.gain || b.effect.partnerGain - a.effect.partnerGain || size(a) - size(b)
      : b.net - a.net || size(a) - size(b),
  );
  return out.slice(0, limit);
}

/** Players worth about the same as the given ones for the rest of the season, nearest first. */
export function nearestInValue(target: string[], rest: Map<string, number>, exclude: string[], limit = 8): { id: string; diff: number }[] {
  const want = target.reduce((s, id) => s + (rest.get(id) ?? 0), 0);
  const skip = new Set([...target, ...exclude]);
  return [...rest]
    .filter(([id, v]) => !skip.has(id) && v > 0)
    .map(([id, v]) => ({ id, diff: v - want }))
    .sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff))
    .slice(0, limit);
}

export interface FinderInput {
  /** The manager's active players. */
  mine: string[];
  /** Every other team with its active players. */
  partners: { team: number; roster: string[] }[];
  /** Rest-of-season value above replacement, per player. */
  rest: Map<string, number>;
  /** The category effect of a trade with a partner. */
  effect: (partner: number, give: string[], get: string[]) => CategoryEffect;
  /** The least category gain a trade must bring the manager. */
  minGain: number;
  /** Only trades that raise the partner's expected categories too (#682). */
  winWin?: boolean;
  /** Whether a trade is fair enough to list: not a bad trade for the manager on value or market (#692). */
  acceptable?: (partner: number, give: string[], get: string[]) => boolean;
  /** How many of each roster's most valuable players are tried. */
  candidates?: number;
  /** The most trades listed with one partner, so the list is not one team's. */
  perPartner?: number;
  limit?: number;
  position?: (id: string) => string | null | undefined;
}

export interface FoundTrade extends Suggestion {
  partner: number;
  effect: CategoryEffect;
}

/**
 * The trade finder (#664): one-for-one, two-for-one and one-for-two trades with every partner,
 * kept when they raise the manager's expected categories won and give the partner a reason to say
 * yes (their categories rise, or they gain value), biggest gain first.
 */
export function findTrades(input: FinderInput): FoundTrade[] {
  const { rest, effect, minGain } = input;
  const n = input.candidates ?? 8;
  const value = (ids: string[]) => ids.reduce((s, id) => s + Math.max(0, rest.get(id) ?? 0), 0);
  const top = (roster: string[]) =>
    [...roster]
      .filter((id) => (rest.get(id) ?? 0) > 0)
      .sort((a, b) => (rest.get(b) ?? 0) - (rest.get(a) ?? 0))
      .slice(0, n);
  const mine = top(input.mine);
  const out: FoundTrade[] = [];
  for (const { team, roster } of input.partners) {
    const theirs = top(roster);
    const found: FoundTrade[] = [];
    const shapes: [string[][], string[][]][] = [
      [combinations(mine, 1), combinations(theirs, 1)],
      [combinations(mine, 2).filter((c) => c.length === 2), combinations(theirs, 1)],
      [combinations(mine, 1), combinations(theirs, 2).filter((c) => c.length === 2)],
    ];
    for (const [gives, gets] of shapes) {
      for (const give of gives) {
        for (const get of gets) {
          if (input.position && !keepsPositions(input.mine, [...input.mine.filter((id) => !give.includes(id)), ...get], input.position)) continue;
          if (input.acceptable && !input.acceptable(team, give, get)) continue;
          const e = effect(team, give, get);
          const net = value(get) - value(give);
          if (e.gain < minGain || (e.partnerGain <= 0 && (input.winWin || net > 0))) continue;
          found.push({ partner: team, give, get, net, effect: e });
        }
      }
    }
    found.sort((a, b) => b.effect.gain - a.effect.gain || b.effect.partnerGain - a.effect.partnerGain);
    out.push(...found.slice(0, input.perPartner ?? 3));
  }
  out.sort((a, b) => b.effect.gain - a.effect.gain || b.effect.partnerGain - a.effect.partnerGain);
  return out.slice(0, input.limit ?? 10);
}
