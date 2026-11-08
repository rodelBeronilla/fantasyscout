/**
 * Is a trade even? (#692) One number cannot say: a trade of three stars for four good players
 * was judged even on value per game, favoured the four on projected rest-of-season value (+32%),
 * and favoured the three in the market's eyes (+25%), and it went the market's way. A trade is
 * judged through three lenses, and called even only when they agree:
 *
 * - value: projected rest-of-season value above replacement, with the roster spots settled (the
 *   side that receives more players drops its lowest-valued one; the side that sends more picks
 *   up the best free agent), so a 4-for-3 does not count the fourth player for free;
 * - market: what other managers pay, read from ESPN's draft ranks, each rank priced at the value
 *   the board's player of that rank has, so it is on the same scale as the value lens;
 * - categories: the change in the categories the manager expects to win (trade-impact.ts).
 *
 * Pure functions, so the Trade page and tests share them.
 */
import { PARAMS } from '../generated/parameters';

export interface Lens {
  give: number;
  get: number;
  /** get − give: positive favours the manager. */
  net: number;
  /** net as a share of the larger side. */
  share: number;
}

/** A lens from the two sides' values; a player below replacement counts as zero. */
export function lens(give: string[], get: string[], value: (id: string) => number): Lens {
  const sum = (ids: string[]) => ids.reduce((s, id) => s + Math.max(0, value(id)), 0);
  const g = sum(give);
  const r = sum(get);
  const net = r - g;
  return { give: g, get: r, net, share: net / Math.max(g, r, 1e-9) }; // def: no division by zero
}

/**
 * The market's value of each player: the value the board's player of the same ESPN rank has, so a
 * consensus top-10 pick is worth what a top-10 player is worth on this board. A player the market
 * does not rank keeps his own value.
 */
export function marketValues(players: { player_id: string; market_rank?: number | null }[], value: (id: string) => number): Map<string, number> {
  const curve = players.map((p) => Math.max(0, value(p.player_id))).sort((a, b) => b - a);
  return new Map(
    players.map((p) => {
      const r = p.market_rank;
      return [p.player_id, typeof r === 'number' && r >= 1 && r <= curve.length ? (curve[r - 1] ?? 0) : value(p.player_id)];
    }),
  );
}

/** How far a lens may favour the partner before it is a bad trade, and a terrible one. */
export const LIMITS = {
  value: PARAMS['trade.value_limits'],
  market: PARAMS['trade.market_limits'],
} as const;
/** Categories: a loss of this many times the meaningful change is bad, of the second terrible. */
const CATEGORY_LIMITS = PARAMS['trade.category_limits'];
/** Two lenses this far apart (in shares) mean the trade is a bet on one of them. */
const DISAGREEMENT: number = PARAMS['trade.disagreement'];
/** Within this share, a lens calls the sides even. */
const EVEN = PARAMS['trade.even'];

export interface Fairness {
  value: Lens;
  market: Lens | null;
  /** The manager's change in expected categories, when the standings judge it. */
  categories: number | null;
  /** All the lenses at hand call it even. */
  even: boolean;
  /** The worst any lens says, for the manager. */
  severity: 'fine' | 'bad' | 'terrible';
  /** Why the trade is bad for the manager, lens by lens. */
  reasons: string[];
  /** The value and market lenses point opposite ways by more than DISAGREEMENT. */
  disagree: boolean;
}

const pct = (share: number) => `${Math.round(Math.abs(share) * 100)}%`; // def: a percentage

export function judge(value: Lens, market: Lens | null, categories: number | null, threshold: number): Fairness {
  const reasons: string[] = [];
  let severity: Fairness['severity'] = 'fine';
  const worse = (s: 'bad' | 'terrible') => {
    if (s === 'terrible' || severity === 'fine') severity = s;
  };
  if (value.share <= LIMITS.value.terrible) {
    worse('terrible');
    reasons.push(`You give ${pct(value.share)} more projected value than you get, roster spots counted.`);
  } else if (value.share <= LIMITS.value.bad) {
    worse('bad');
    reasons.push(`You give ${pct(value.share)} more projected value than you get, roster spots counted.`);
  }
  if (market && market.share <= LIMITS.market.terrible) {
    worse('terrible');
    reasons.push(`By ESPN's ranks, the market values what you give ${pct(market.share)} above what you get: most managers would call it a win for your partner.`);
  } else if (market && market.share <= LIMITS.market.bad) {
    worse('bad');
    reasons.push(`By ESPN's ranks, what you give is worth ${pct(market.share)} more than what you get.`);
  }
  if (categories !== null && threshold > 0) {
    if (categories <= -CATEGORY_LIMITS.terrible * threshold) {
      worse('terrible');
      reasons.push('It costs you a large share of the categories you expect to win.');
    } else if (categories <= -CATEGORY_LIMITS.bad * threshold) {
      worse('bad');
      reasons.push('It costs you categories you expect to win.');
    }
  }
  const disagree = !!market && Math.abs(value.share - market.share) >= DISAGREEMENT && Math.sign(value.share) !== Math.sign(market.share);
  const even =
    Math.abs(value.share) <= EVEN.value &&
    (!market || Math.abs(market.share) <= EVEN.market) &&
    (categories === null || Math.abs(categories) < CATEGORY_LIMITS.bad * threshold);
  return { value, market, categories, even, severity, reasons, disagree };
}
