/**
 * Roster upgrades: with the league's rosters known, the players nobody owns who are worth more for
 * the rest of the season than a player the manager has, as swaps (add one, drop one) ranked by the
 * value gained, each with the categories where the manager's league rank moves. Pure functions
 * over per-player values, so the Board and the tests share them.
 */
import { keepsPositions } from './players';

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
  /** Each player's position ("G-F"); when given, no swap leaves a position letter the roster covers uncovered (#489). */
  position?: (id: string) => string | null | undefined;
  /**
   * Whether a player may be dropped (#710). A player the league or the market ranks among the
   * starters is a trade, not a drop, however little they add to the manager's build; and a week's
   * form drops nobody but the bench's weakest. Absent, anyone may be.
   */
  droppable?: (id: string) => boolean;
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

/** The verdict on the manager's roster: the swaps, who to replace, or that it holds as is. */
export interface RosterReview {
  upgrades: Upgrade[];
  /** The manager's players an available player beats: the weak spots, in swap order. */
  replace: string[];
  /** True when the manager has players and no available player beats one of them by the minimum gain. */
  optimized: boolean;
  /** The manager's lowest-valued player who may be dropped (else the lowest) and the best available alternative; the gap is negative when the roster holds. */
  weakest: { drop: string; add: string | null; gap: number } | null;
  /** How many of the manager's players were judged. */
  rostered: number;
  /**
   * The manager's players a free agent beats for the build but who may not be dropped: worth
   * more to other managers than to this build, so trade chips (#710). Lowest value first.
   */
  chips: string[];
}

export function reviewRoster(input: UpgradeInput): RosterReview {
  const upgrades = suggestUpgrades(input);
  const value = (id: string) => input.rest.get(id) ?? 0;
  const keep = input.droppable;
  const mine = [...input.mine].sort((a, b) => value(a) - value(b));
  const bestAdd = [...input.available].filter((id) => value(id) > 0).sort((a, b) => value(b) - value(a))[0] ?? null;
  // the weakest spot is the lowest player who may go; with none, the lowest of all
  const lowest = (keep ? mine.find((id) => keep(id)) : undefined) ?? mine[0];
  const weakest =
    lowest === undefined ? null : { drop: lowest, add: bestAdd, gap: bestAdd ? value(bestAdd) - value(lowest) : -value(lowest) };
  // the players the free agents beat but who stay: the trade chips
  const minGain = input.minGain ?? 0.5;
  const chips =
    keep && bestAdd
      ? mine.filter((id) => !keep(id) && value(bestAdd) - value(id) >= minGain)
      : [];
  return {
    upgrades,
    replace: upgrades.map((u) => u.drop),
    optimized: mine.length > 0 && upgrades.length === 0,
    weakest,
    rostered: mine.length,
    chips,
  };
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
  const drops = [...mine].filter((id) => !input.droppable || input.droppable(id)).sort((a, b) => value(a) - value(b));
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
  // the roster as the swaps so far leave it, for the position check
  let roster = [...mine];
  for (const p of pairs) {
    if (used.has(p.add) || used.has(p.drop)) continue;
    if (input.position) {
      const after = [...roster.filter((id) => id !== p.drop), p.add];
      if (!keepsPositions(roster, after, input.position)) continue;
      roster = after;
    }
    used.add(p.add);
    used.add(p.drop);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}
