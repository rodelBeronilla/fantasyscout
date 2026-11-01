/**
 * Trade suggestions: given the players a manager has fixed on one or both sides of a trade with a
 * partner, the packages from the open side's roster that make the trade about even for the rest
 * of the season, ranked by how much they lift the manager's team in the league's category ranks.
 * Pure functions over per-player values, so the Trade page and tests share them.
 */

export interface SuggestInput {
  /** Players already fixed on each side. At least one side must have a player. */
  give: string[];
  get: string[];
  /** Rosters the open sides fill from: the manager's and the partner's active players. */
  mine: string[];
  theirs: string[];
  /** Rest-of-season value above replacement, per player. */
  rest: Map<string, number>;
  /** Category keys, empty for a points league. */
  cats: string[];
  /** Per-game category values above replacement, per player. */
  catValue: (id: string) => Record<string, number> | undefined;
  /** Each team's category totals before the trade (active players only). */
  totals: Record<string, number>[];
  myTeam: number;
  partnerTeam: number;
  /** The most players a suggestion adds to a side. */
  maxAdd?: number;
  /** How far apart the sides may be, as a share of the larger side. */
  tolerance?: number;
  limit?: number;
}

export interface Suggestion {
  give: string[];
  get: string[];
  /** Rest-of-season value the manager gains (negative: gives up). */
  net: number;
  /** Ranks gained across categories, minus ranks lost. */
  fit: number;
  /** Categories where the manager's rank improves, and where it drops. */
  ups: string[];
  downs: string[];
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

/** 1 + the number of teams whose total beats this one. */
const rankOf = (totals: number[], team: number) => 1 + totals.filter((v, t) => t !== team && v > (totals[team] ?? 0)).length;

/** The side a suggestion fills: the one with nothing fixed, or with both fixed, the lighter one. */
export function openSide(give: string[], get: string[], rest: Map<string, number>): 'give' | 'get' {
  if (!give.length) return 'give';
  if (!get.length) return 'get';
  const value = (ids: string[]) => ids.reduce((s, id) => s + (rest.get(id) ?? 0), 0);
  return value(give) < value(get) ? 'give' : 'get';
}

export function suggestTrades(input: SuggestInput): Suggestion[] {
  const { give, get, rest, cats, catValue, totals, myTeam, partnerTeam } = input;
  const maxAdd = input.maxAdd ?? 3;
  const tolerance = input.tolerance ?? 0.15;
  const limit = input.limit ?? 8;
  if (!give.length && !get.length) return [];
  const value = (ids: string[]) => ids.reduce((s, id) => s + (rest.get(id) ?? 0), 0);

  const open = openSide(give, get, rest);
  const roster = (open === 'give' ? input.mine : input.theirs).filter((id) => !give.includes(id) && !get.includes(id));
  // The biggest names first, and no more than 16 candidates, keep the search small.
  const candidates = [...roster].sort((a, b) => (rest.get(b) ?? 0) - (rest.get(a) ?? 0)).slice(0, 16);
  const add = give.length && get.length ? Math.min(maxAdd, 2) : maxAdd;

  const before = cats.map((c) => rankOf(totals.map((t) => t[c] ?? 0), myTeam));
  const out: Suggestion[] = [];
  for (const combo of combinations(candidates, add)) {
    const g = open === 'give' ? [...give, ...combo] : give;
    const r = open === 'get' ? [...get, ...combo] : get;
    const net = value(r) - value(g);
    const scale = Math.max(Math.abs(value(g)), Math.abs(value(r)), 1);
    if (Math.abs(net) > tolerance * scale) continue;
    const ups: string[] = [];
    const downs: string[] = [];
    let fit = 0;
    cats.forEach((c, i) => {
      const swing = r.reduce((s, id) => s + (catValue(id)?.[c] ?? 0), 0) - g.reduce((s, id) => s + (catValue(id)?.[c] ?? 0), 0);
      const after = totals.map((t, team) => (t[c] ?? 0) + (team === myTeam ? swing : team === partnerTeam ? -swing : 0));
      const rank = rankOf(after, myTeam);
      const was = before[i] ?? rank;
      fit += was - rank;
      if (rank < was) ups.push(c);
      else if (rank > was) downs.push(c);
    });
    out.push({ give: g, get: r, net, fit, ups, downs });
  }
  // Best fit first; then the trade that favours the manager most; then the simpler package.
  out.sort((a, b) => b.fit - a.fit || b.net - a.net || a.give.length + a.get.length - (b.give.length + b.get.length));
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
