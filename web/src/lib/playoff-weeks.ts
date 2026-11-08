/**
 * The playoff-week plan (#821): which fantasy weeks the playoffs take, how many games the
 * manager's roster has in them against every other team's, and the free agent to target for them.
 * The games come from the schedule the site exports per team and week (team_weeks); the target is
 * Pickups' ranking (pickups-top.ts) with the window set to the playoff weeks: value per game times
 * games in them.
 */
import { ordinal } from './format';
import { type AddRow, type TopAdd, topAdds } from './pickups-top';
import { roundRobin, type Week } from './playoff-odds';

/** A team's games in one fantasy week, as team_weeks/<league>.json has them. */
export interface TeamWeek {
  team_id: string;
  week_start: string;
  week_end: string;
  games: number;
  /** Every game date in the week, comma-separated. */
  game_dates: string | null;
}

/** The fantasy playoffs' days, and the host's numbers for their weeks when the league came from ESPN or Yahoo. */
export interface PlayoffWindow {
  from: string;
  to: string;
  /** The host's first and last playoff weeks (ESPN's matchup periods, Yahoo's weeks); null for a league entered by hand. */
  periods: [number, number] | null;
}

const weeksOf = (rows: TeamWeek[]) => [...new Set(rows.filter((r) => r.games > 0).map((r) => `${r.week_start}|${r.week_end}`))].sort();

/**
 * The playoff weeks: the import's or the first week entered (#874) when the league fixes them,
 * else the schedule's last `weeks` Monday-to-Sunday weeks with games. Null without either.
 */
export function playoffWindow(rows: TeamWeek[], weeks: number, fixed?: PlayoffWindow | null): PlayoffWindow | null {
  if (fixed) return { from: fixed.from, to: fixed.to, periods: fixed.periods };
  const all = weeksOf(rows);
  if (!all.length || weeks < 1) return null;
  const kept = all.slice(-weeks);
  return { from: kept[0]!.split('|')[0]!, to: kept.at(-1)!.split('|')[1]!, periods: null };
}

/** Each NBA or WNBA team's games from `today` through the window's last day, inside the window. */
export function windowGames(rows: TeamWeek[], window: PlayoffWindow, today: string): Map<string, number> {
  const first = today > window.from ? today : window.from;
  const out = new Map<string, number>();
  for (const r of rows) {
    const dates = (r.game_dates ?? '').split(',').filter((d) => d && d >= first && d <= window.to);
    if (dates.length) out.set(r.team_id, (out.get(r.team_id) ?? 0) + new Set(dates).size);
  }
  return out;
}

/**
 * The regular-season weeks still to play for a league this site has no schedule for: every
 * Monday-to-Sunday week with games from this one up to the playoffs, a round robin's matchups in each.
 */
export function weeksToPlay(rows: TeamWeek[], window: PlayoffWindow, today: string, teams: number): Week[] {
  const left = weeksOf(rows).filter((w) => {
    const [, end] = w.split('|');
    return (end ?? '') >= today && (end ?? '') < window.from;
  });
  return roundRobin(teams, left.length);
}

/** Each fantasy team's games in the window: its active players' teams' games, summed. */
export function rosterGames(rosters: string[][], il: string[], games: (id: string) => number): number[] {
  return rosters.map((r) => r.filter((id) => !il.includes(id)).reduce((s, id) => s + games(id), 0));
}

/** The manager's place by those games among the teams with a roster in (1 for the most), and how many teams that is. */
export function gamesPlace(perTeam: number[], rosters: string[][], mine: number): { place: number; of: number } {
  const teams = perTeam.map((_, t) => t).filter((t) => t === mine || (rosters[t]?.length ?? 0) > 0);
  const mineGames = perTeam[mine] ?? 0;
  return { place: 1 + teams.filter((t) => t !== mine && (perTeam[t] ?? 0) > mineGames).length, of: teams.length };
}

/** A board row as the target reads it. */
export interface TargetRow {
  player_id: string;
  team_id?: string | null;
  position: string | null;
  injury_group: string | null;
  rank_total: number;
}

export interface TargetInput<R extends TargetRow> {
  rows: R[];
  /** Games each NBA or WNBA team has in the window. */
  games: Map<string, number>;
  /** Value per game under the league's scoring. */
  perGame: (id: string) => number;
  /** Who is on a fantasy roster here. */
  owned: (id: string) => boolean;
  /**
   * Whether every team's roster is in. Without them, a player inside the league's pool (teams x
   * roster spots, by board rank) is taken to be rostered somewhere.
   */
  allRosters: boolean;
  pool: number;
  drops: readonly string[];
  roster: readonly string[];
  position: (id: string) => string | null | undefined;
  kept: readonly string[];
  limit?: number;
}

/**
 * The free agents to target for the playoff weeks, best first: Pickups' top adds with the window
 * set to the playoff weeks, each ranked by his value per game times his team's games in them.
 */
export function playoffTargets<R extends TargetRow>(input: TargetInput<R>): TopAdd<AddRow & { source: R }>[] {
  const rows: (AddRow & { source: R })[] = input.rows
    .filter((r) => !input.owned(r.player_id) && (input.allRosters || r.rank_total > input.pool))
    .map((r) => {
      const g = input.games.get(r.team_id ?? '') ?? 0;
      return {
        player_id: r.player_id,
        position: r.position,
        injury_group: r.injury_group,
        games_window: g,
        games_picked: 0,
        window_value: g ? input.perGame(r.player_id) * g : null,
        fit: null,
        minutes_trend: null,
        source: r,
      };
    });
  return topAdds({
    rows,
    available: () => true,
    needs: [],
    kept: input.kept,
    openDays: 0,
    drops: input.drops,
    roster: input.roster,
    position: input.position,
    limit: input.limit,
  });
}

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortDate = (iso: string) => DAY.format(new Date(`${iso}T12:00:00Z`));

/** "weeks 22 to 24", "week 24", or "the playoff weeks (Mar 22 to Apr 11)" for a league entered by hand. */
export function windowText(w: PlayoffWindow): string {
  if (w.periods) return w.periods[0] === w.periods[1] ? `week ${w.periods[0]}` : `weeks ${w.periods[0]} to ${w.periods[1]}`;
  return `the playoff weeks (${shortDate(w.from)} to ${shortDate(w.to)})`;
}

/** "62%", with "under 1%" and "over 99%" for the odds that are not quite certain. */
export function oddsText(p: number): string {
  if (p > 0 && p < 0.005) return 'under 1%'; // display: rounds to 0%
  if (p < 1 && p > 0.995) return 'over 99%'; // display: rounds to 100%
  return `${Math.round(p * 100)}%`; // def: a percentage
}

/** The lead before the target: "62% to make it; 37 games in weeks 22 to 24, 4th of 12". */
export function playoffLead(odds: number | null, games: number, place: { place: number; of: number }, window: PlayoffWindow): string {
  const plan = `${games} ${games === 1 ? 'game' : 'games'} in ${windowText(window)}, ${ordinal(place.place)} of ${place.of}`;
  return odds === null ? plan : `${oddsText(odds)} to make it; ${plan}`;
}
