/**
 * Auction values (#741): what a player is worth in an auction draft, from value above replacement.
 * A league holds teams × budget dollars, and every roster spot costs at least the minimum bid; the
 * dollars beyond the minimums go to the players a league this size rosters in proportion to their
 * value above replacement. A player below replacement who still makes the pool is a minimum bid;
 * a player outside it is worth nothing.
 */
import { PARAMS } from '../generated/parameters';
export const AUCTION_BUDGET: number = PARAMS['auction.budget'];

export function auctionValues(
  values: Map<string, number>,
  { teams, rosterSpots, budget = AUCTION_BUDGET, minBid = PARAMS['auction.min_bid'] }: { teams: number; rosterSpots: number; budget?: number; minBid?: number },
): Map<string, number> {
  const pool = teams * rosterSpots;
  const ranked = [...values].sort((a, b) => b[1] - a[1]);
  const rostered = ranked.slice(0, pool);
  const above = rostered.reduce((s, [, v]) => s + Math.max(0, v), 0);
  const spare = teams * budget - rostered.length * minBid;
  const perPoint = above > 0 ? spare / above : 0;
  const out = new Map<string, number>(ranked.map(([id]) => [id, 0]));
  for (const [id, v] of rostered) out.set(id, minBid + Math.max(0, v) * perPoint);
  return out;
}
