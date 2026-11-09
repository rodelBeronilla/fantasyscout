/**
 * Every player's value under the league's settings (#936, rule 3): the one function every page
 * values players through, so Rankings, the player page, Pickups, Trade, My Team and the League
 * page's draft list give a player the same value. It takes the league's size, scoring and the
 * punts set on the League page; a punted category counts for nothing in value.
 *
 * A trade partner has a build of their own (#938). FantasyScout stores no other team's punts and
 * infers none from a roster, so a partner is valued on every category the league scores
 * (`partnerSettings`); the Trade page says so.
 */
import { keptCategories, type LeagueSettings } from './fantasy-league';
import { CATEGORIES } from './format';
import { categoryReplacement, categoryValues, marketPriorShift, pointValues, scaleValue } from './league-value';
import { type ModelRow, restValues } from './board-model';
import { recentForm } from './week-value';

/** What a value reads of the league: its size, its scoring and the manager's punts. */
export type ValueSettings = Pick<LeagueSettings, 'scoring' | 'punts' | 'weights' | 'teams' | 'rosterSpots'>;

export interface LeagueValuation {
  points: boolean;
  /** The categories the values count: the league's, less the punts (and turnovers in an 8-category league). */
  activeCats: string[];
  /** The categories that count for nothing in value: the punts, and turnovers in an 8-category league. */
  punted: string[];
  /** Per-game category values above this league's replacement level, in a categories league. */
  leagueCats: Map<string, Record<string, number>> | null;
  /** Fantasy points a game and their value above replacement, in a points league. */
  leaguePoints: Map<string, { fpts: number; value: number }> | null;
  /** This league's replacement level per category on the published scale, for the windowed views too (ADR 0019). */
  replacement: Record<string, number> | null;
  /** Last-ten form's category values on the projection's scale, for the week unit (#466). */
  recentCats: Map<string, Record<string, number>> | null;
  /** Rest-of-season value. */
  restValue: Map<string, number>;
  /** Value per game under the league's scoring; `recent` reads the last ten, without the market prior. */
  perGame: (id: string, recent?: boolean) => number;
  /** Value over the season (games share counted, the rest of the season not). */
  seasonValue: (id: string) => number;
}

/** The categories that count for nothing in value: the punts, and turnovers in an 8-category league; none in a points league. */
export function puntedCategories(s: Pick<ValueSettings, 'scoring' | 'punts'>): string[] {
  if (s.scoring === 'points') return [];
  const kept = keptCategories(s);
  return CATEGORIES.filter((c) => !kept.includes(c));
}

/** The league's settings for a trade partner: every category the league scores, since no team's punts are stored or inferred. */
export const partnerSettings = (s: ValueSettings): ValueSettings => ({ ...s, punts: [] });

/** Every player's value under the league's settings. */
export function leagueValues<R extends ModelRow>(rows: R[], s: ValueSettings): LeagueValuation {
  const points = s.scoring === 'points';
  const activeCats = points ? [] : keptCategories(s);
  const punted = puntedCategories(s);
  const pool = s.teams * s.rosterSpots;
  const leagueCats = points ? null : categoryValues(rows, activeCats, pool, s.teams);
  const leaguePoints = points ? pointValues(rows, s.weights, pool, s.teams) : null;
  const replacement = points ? null : categoryReplacement(rows, activeCats, pool, s.teams);
  const recentCats = points ? null : categoryValues(recentForm(rows, activeCats), activeCats, pool, s.teams, rows);
  const restValue = restValues(rows, { points, leaguePoints, leagueCats, activeCats });
  // the projection's value carries the market prior's shift (#848); last-ten form does not
  const prior = new Map(points ? [] : rows.map((r) => [r.player_id, marketPriorShift(r)]));
  const perGame = (id: string, recent = false) =>
    points
      ? (leaguePoints?.get(id)?.value ?? 0)
      : activeCats.reduce((sum, c) => sum + ((recent ? recentCats : leagueCats)?.get(id)?.[c] ?? 0), 0) + (recent ? 0 : (prior.get(id) ?? 0));
  const byId = new Map(rows.map((r) => [r.player_id, r]));
  const seasonValue = (id: string) => {
    const r = byId.get(id);
    return r ? scaleValue(perGame(id), r, { restOfSeason: false }) : 0;
  };
  return { points, activeCats, punted, leagueCats, leaguePoints, replacement, recentCats, restValue, perGame, seasonValue };
}
