/**
 * Each side of a trade under its own build (#938). The manager's side is valued under the league's
 * settings and the manager's punts. The partner's side is valued under the partner's: no team's
 * punts are stored and none are inferred from a roster, so the partner counts every category the
 * league scores (valuation.ts, partnerSettings). Before this, a punter's partner was priced under
 * the manager's punts, so a star's points and assists counted for nothing to the team giving him up.
 */
import type { ModelRow } from './board-model';
import type { League } from './data';
import { categoryWeights, type LeagueSetup } from './fantasy-league';
import { leagueState, playerWorth, type StateRow, type Worth, type WorthRow } from './league-model';
import { type LeagueState, leagueStandings, type Standings, teamNeeds, type TeamNeeds, type TradeImpact, tradeImpact } from './trade-impact';
import { type LeagueValuation, leagueValues, partnerSettings, type ValueSettings } from './valuation';

type TradeRow = ModelRow & WorthRow & StateRow;

/** Every player's worth under these settings, in the shape the trade tools read, and the categories it counts. */
export function worthUnder(rows: TradeRow[], s: ValueSettings): { worth: Map<string, Worth>; cats: string[]; values: LeagueValuation } {
  const v = leagueValues(rows, s);
  const worth = playerWorth(rows, {
    points: v.points,
    cats: v.activeCats,
    catWeight: categoryWeights(s),
    catValues: v.leagueCats,
    pointValues: v.leaguePoints,
    recentCats: v.recentCats,
  });
  return { worth, cats: v.activeCats, values: v };
}

export interface PartnerSide {
  /** The league as the partner's build reads it. */
  state: LeagueState;
  standings: Standings;
  worth: Map<string, Worth>;
  /** The categories the partner's build counts: every one the league scores. */
  cats: string[];
}

/** The league under the partner's build, for the partner's side of a trade; null without the standings. */
export function partnerSide(
  rows: TradeRow[],
  input: { league: League; setup: LeagueSetup; owner: Map<string, number>; partner: number; week: boolean },
): PartnerSide | null {
  const { league, setup, owner, partner, week } = input;
  if (partner < 0) return null;
  const { worth, cats } = worthUnder(rows, partnerSettings(setup));
  const state = leagueState(rows, { league, format: setup.format, points: setup.scoring === 'points', cats, rosters: setup.rosters, il: setup.il, rosterSpots: setup.rosterSpots, owner, worth, week });
  const standings = state ? leagueStandings(state, partner) : null;
  return state && standings ? { state, standings, worth, cats } : null;
}

/**
 * The trade's impact with the partner's side under the partner's build: the manager's side, the
 * manager's roster move and the manager's totals from `mine`; the partner's chances, categories up
 * and down and roster move from `theirs`.
 */
function withPartner(mine: TradeImpact, theirs: TradeImpact): TradeImpact {
  return {
    ...mine,
    partner: theirs.partner,
    partnerUps: theirs.partnerUps,
    partnerDowns: theirs.partnerDowns,
    sides: { mine: mine.sides.mine, partner: theirs.sides.partner },
  };
}

/** The trade's impact on both sides, each under its own build. */
export function bothBuilds(state: LeagueState, standings: Standings, side: PartnerSide | null, mine: number, partner: number, give: string[], get: string[]): TradeImpact {
  const own = tradeImpact(state, standings, mine, partner, give, get);
  return side ? withPartner(own, tradeImpact(side.state, side.standings, mine, partner, give, get)) : own;
}

/** Each team's needs from the standings: the manager's under the manager's build, the partner's under theirs. */
export function bothNeeds(state: LeagueState, standings: Standings, side: PartnerSide | null, mine: number, partner: number): { mine: TeamNeeds; partner: TeamNeeds } {
  return {
    mine: teamNeeds(state, standings, mine),
    partner: side ? teamNeeds(side.state, side.standings, partner) : teamNeeds(state, standings, partner),
  };
}
