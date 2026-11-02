/**
 * Roster upgrades: with the league's rosters known, the players nobody owns who are worth more for
 * the rest of the season than a player the manager has, as swaps (add one, drop one) ranked by the
 * value gained, each with the categories where the manager's league rank moves. Pure functions
 * over per-player values, so the Board and the tests share them.
 */

export interface UpgradeInput {
  /** The manager's active players (not on the injured list). */
  mine: string[];
  /** Players on no roster in the league. */
  available: string[];
  /** Rest-of-season value above replacement, per player. */
  rest: Map<string, number>;
  /** Category keys, empty for a points league. */
  cats: string[];
  /** Per-game category values above replacement, per player. */
  catValue: (id: string) => Record<string, number> | undefined;
  /** Each team's category totals before the swap (active players only). */
  totals: Record<string, number>[];
  myTeam: number;
  /** The least rest-of-season value a swap must gain to be worth the roster move. */
  minGain?: number;
  /** How many available players, best first, are considered. */
  candidates?: number;
  limit?: number;
}

export interface Upgrade {
  add: string;
  drop: string;
  /** Rest-of-season value gained. */
  gain: number;
  /** Ranks gained across categories, minus ranks lost. */
  fit: number;
  /** Categories where the manager's rank improves, and where it drops. */
  ups: string[];
  downs: string[];
}

/** 1 + the number of teams whose total beats this one. */
const rankOf = (totals: number[], team: number) => 1 + totals.filter((v, t) => t !== team && v > (totals[team] ?? 0)).length;

export function suggestUpgrades(input: UpgradeInput): Upgrade[] {
  const { mine, available, rest, cats, catValue, totals, myTeam } = input;
  const minGain = input.minGain ?? 0.5;
  const limit = input.limit ?? 5;
  const value = (id: string) => rest.get(id) ?? 0;
  if (!mine.length || !available.length) return [];

  // The best available players and the manager's weakest, by rest-of-season value.
  const adds = [...available]
    .filter((id) => value(id) > 0)
    .sort((a, b) => value(b) - value(a))
    .slice(0, input.candidates ?? 25);
  const drops = [...mine].sort((a, b) => value(a) - value(b));
  const before = cats.map((c) => rankOf(totals.map((t) => t[c] ?? 0), myTeam));

  const pairs: Upgrade[] = [];
  for (const add of adds) {
    for (const drop of drops) {
      const gain = value(add) - value(drop);
      if (gain < minGain) continue;
      const ups: string[] = [];
      const downs: string[] = [];
      let fit = 0;
      cats.forEach((c, i) => {
        const swing = (catValue(add)?.[c] ?? 0) - (catValue(drop)?.[c] ?? 0);
        const after = totals.map((t, team) => (t[c] ?? 0) + (team === myTeam ? swing : 0));
        const rank = rankOf(after, myTeam);
        const was = before[i] ?? rank;
        fit += was - rank;
        if (rank < was) ups.push(c);
        else if (rank > was) downs.push(c);
      });
      pairs.push({ add, drop, gain, fit, ups, downs });
    }
  }
  // The biggest gain first, ranks gained breaking ties; each player appears in one swap, so the
  // list reads as moves the manager can make one after another.
  pairs.sort((a, b) => b.gain - a.gain || b.fit - a.fit);
  const used = new Set<string>();
  const out: Upgrade[] = [];
  for (const p of pairs) {
    if (used.has(p.add) || used.has(p.drop)) continue;
    used.add(p.add);
    used.add(p.drop);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}
