/**
 * The manager's values and roster review, as My Team works them out (#819): the league's
 * category or point values, each player's rest-of-season value, and the review that names who to
 * drop. Pickups reads the same review, so its top adds drop the player My Team's Moves would.
 */
import { CATEGORIES } from './format';
import { type LeagueSetup, owners } from './fantasy-league';
import { categoryValues, marketPriorShift, pointValues } from './league-value';
import { type ModelRow, restValues } from './board-model';
import { dropRule, type DropRow, reviewRoster, type RosterReview } from './roster-upgrades';
import { recentForm, weekValue } from './week-value';

/** A board row as the review reads it. */
export interface ReviewRow extends ModelRow, DropRow {
  games_this_week?: number | null;
}

type ValueSettings = Pick<LeagueSetup, 'scoring' | 'punts' | 'weights' | 'teams' | 'rosterSpots'>;

export interface TeamValues {
  points: boolean;
  /** The categories the league counts: punts out, and turnovers in an 8-category league. */
  activeCats: string[];
  leagueCats: Map<string, Record<string, number>> | null;
  leaguePoints: Map<string, { fpts: number; value: number }> | null;
  /** Last-ten form's category values, for the week unit (#466). */
  recentCats: Map<string, Record<string, number>> | null;
  restValue: Map<string, number>;
  /** Value per game under the league's scoring; recent reads the last ten. */
  perGame: (id: string, recent?: boolean) => number;
}

export function teamValues(rows: ReviewRow[], s: ValueSettings): TeamValues {
  const points = s.scoring === 'points';
  const punted = s.scoring === 'cats8' ? [...s.punts, 'z_turnovers'] : s.punts;
  const activeCats = CATEGORIES.filter((c) => !punted.includes(c));
  const pool = s.teams * s.rosterSpots;
  const leagueCats = points ? null : categoryValues(rows, activeCats, pool, s.teams);
  const leaguePoints = points ? pointValues(rows, s.weights, pool, s.teams) : null;
  const recentCats = points ? null : categoryValues(recentForm(rows, activeCats), activeCats, pool, s.teams, rows);
  const restValue = restValues(rows, { points, leaguePoints, leagueCats, activeCats });
  // the projection's value carries the market prior's shift (#848); last-ten form does not
  const prior = new Map(points ? [] : rows.map((r) => [r.player_id, marketPriorShift(r)]));
  const perGame = (id: string, recent = false) =>
    points
      ? (leaguePoints?.get(id)?.value ?? 0)
      : activeCats.reduce((sum, c) => sum + ((recent ? recentCats : leagueCats)?.get(id)?.[c] ?? 0), 0) + (recent ? 0 : (prior.get(id) ?? 0));
  return { points, activeCats, leagueCats, leaguePoints, recentCats, restValue, perGame };
}

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
export function teamReview(rows: ReviewRow[], setup: LeagueSetup, v: TeamValues, week: boolean): TeamReview | null {
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
  const droppable = dropRule(rows, mine, setup, v.restValue, week);
  const review = reviewRoster({
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
