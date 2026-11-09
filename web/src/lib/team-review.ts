/**
 * The manager's roster review, as My Team works it out (#819): the review that names who to drop,
 * on the league's values (valuation.ts). Pickups reads the same review, so its top adds drop the
 * player My Team's Moves would.
 */
import type { League } from './data';
import { type LeagueSetup, owners } from './fantasy-league';
import type { ModelRow } from './board-model';
import { dropRule, type DropRow, reviewRoster, type RosterReview } from './roster-upgrades';
import type { LeagueValuation } from './valuation';
import { weekValue } from './week-value';

/** A board row as the review reads it. */
export interface ReviewRow extends ModelRow, DropRow {
  games_this_week?: number | null;
}

/** The league's values the review reads (valuation.ts, leagueValues). */
type TeamValues = Pick<LeagueValuation, 'points' | 'activeCats' | 'leagueCats' | 'recentCats' | 'restValue' | 'perGame'>;

export interface TeamReview {
  review: RosterReview;
  /** The manager's players who may be dropped, in the order the review would drop them. */
  drops: string[];
  /** The manager's active players (off the injured list) the board knows. */
  mine: string[];
}

/**
 * The roster review My Team's Moves shows: for the week (last-ten form over the games left) or
 * the rest of the season. Null with no team, or while a draft is under way.
 */
export function teamReview(league: League, rows: ReviewRow[], setup: LeagueSetup, v: TeamValues, week: boolean): TeamReview | null {
  if (setup.drafting) return null;
  const known = new Set(rows.map((r) => r.player_id));
  const mine = (setup.rosters[setup.mine] ?? []).filter((id) => !setup.il.includes(id) && known.has(id));
  if (mine.length === 0) return null;
  const owner = owners(setup);
  const position = new Map(rows.map((r) => [r.player_id, r.position]));
  const cats = week ? v.recentCats : v.leagueCats;
  const totals = setup.rosters.map((r) =>
    Object.fromEntries(v.activeCats.map((c) => [c, r.filter((id) => !setup.il.includes(id)).reduce((s, id) => s + (cats?.get(id)?.[c] ?? 0), 0)])),
  );
  const weekValues = new Map(week ? rows.map((r) => [r.player_id, weekValue(v.perGame(r.player_id, true), r.games_this_week)]) : []);
  const rest = week ? weekValues : v.restValue;
  const droppable = dropRule(rows, mine, { league, teams: setup.teams, rosterSpots: setup.rosterSpots }, v.restValue, week);
  const review = reviewRoster({
    league,
    position: (id) => position.get(id),
    droppable,
    mine,
    available: rows.filter((r) => !owner.has(r.player_id)).map((r) => r.player_id),
    rest,
    cats: v.points ? [] : v.activeCats,
    catValue: (id) => cats?.get(id),
    totals,
    myTeam: setup.mine,
  });
  // the review's own drops first, then every other player who may go, lowest value first
  const lowest = [...mine].filter(droppable).sort((a, b) => (rest.get(a) ?? 0) - (rest.get(b) ?? 0));
  const drops = [...new Set([...review.replace, ...lowest])];
  return { review, drops, mine };
}
