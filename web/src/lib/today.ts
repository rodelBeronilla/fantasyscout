/**
 * The manager's game day (#464): of the active players (the IL left out), who plays today, who
 * plays but is listed on the injury report, and whose team has no game. "Today" is the Eastern
 * date, the day the league schedules and the 5 pm reports use, whatever the viewer's clock says.
 */
import { bestLineup, type Slot } from './lineup';

export interface TodayGame {
  game_date: string;
  game_datetime_utc?: string | null;
  home_team_id: string;
  away_team_id: string;
  home_team_tricode: string;
  away_team_tricode: string;
}

/**
 * The games still to tip off at `now`: one clock for the page. A game with no tip-off time stays
 * in, since only the clock can say it has started. Lineups lock at tip-off, so a game under way or
 * final is no longer a start to make or a slot to stream into.
 */
export function gamesToCome<G extends TodayGame>(games: G[], now: number): G[] {
  return games.filter((g) => {
    const tip = g.game_datetime_utc ? Date.parse(g.game_datetime_utc) : Number.NaN;
    return Number.isNaN(tip) || tip > now;
  });
}

export interface TodayPlayer {
  player_id: string;
  team_id?: string | null;
  injury_group?: string | null;
  /** The role on the team's lineup (NBA): starter, bench or inactive, for the game day `lineup_date`. */
  lineup_role?: string | null;
  lineup_date?: string | null;
}

/**
 * Listed inactive on his team's lineup for the day (#878): not in uniform, whether or not the injury
 * report names him (a G League assignment, a coach's decision, a late scratch). He does not play.
 */
function inactiveOn(player: TodayPlayer, date: string): boolean {
  return player.lineup_role === 'inactive' && player.lineup_date === date;
}

/** Not playing on the day: ruled out or doubtful on the report, or inactive on the team's lineup. */
export function sitsOut(player: TodayPlayer, date: string): boolean {
  return player.injury_group === 'out' || player.injury_group === 'doubtful' || inactiveOn(player, date);
}

export interface TodaySlot<P> {
  player: P;
  /** The opponent's tricode, with "v" at home and "@" away; null without a game. */
  opponent: string | null;
  home: boolean;
  /** Tip-off in UTC, when the schedule has it. */
  tipoff: string | null;
  /** Listed inactive on the team's lineup for the day (#878): he does not play, whatever the report says. */
  inactive: boolean;
}

/** On the report and not expected to play normally: the group a manager checks before lineups lock. */
const LISTED = new Set(['out', 'doubtful', 'questionable', 'day_to_day']);

const EASTERN_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

/** Today's date in Eastern time, as YYYY-MM-DD. */
export function easternDate(now: Date = new Date()): string {
  return EASTERN_DATE.format(now);
}

export function todayGroups<P extends TodayPlayer>(
  players: P[],
  games: TodayGame[],
  date: string,
): { plays: TodaySlot<P>[]; listed: TodaySlot<P>[]; idle: TodaySlot<P>[]; leagueGames: number } {
  const byTeam = new Map<string, { opponent: string; home: boolean; tipoff: string | null }>();
  let leagueGames = 0;
  for (const g of games) {
    if (g.game_date !== date) continue;
    leagueGames += 1;
    const tipoff = g.game_datetime_utc ?? null;
    byTeam.set(g.home_team_id, { opponent: g.away_team_tricode, home: true, tipoff });
    byTeam.set(g.away_team_id, { opponent: g.home_team_tricode, home: false, tipoff });
  }
  const plays: TodaySlot<P>[] = [];
  const listed: TodaySlot<P>[] = [];
  const idle: TodaySlot<P>[] = [];
  for (const player of players) {
    const game = player.team_id ? byTeam.get(player.team_id) : undefined;
    const inactive = inactiveOn(player, date);
    if (!game) idle.push({ player, opponent: null, home: false, tipoff: null, inactive });
    else if (LISTED.has(player.injury_group ?? '') || inactive) listed.push({ player, ...game, inactive });
    else plays.push({ player, ...game, inactive });
  }
  const byTip = (a: TodaySlot<P>, b: TodaySlot<P>) => (a.tipoff ?? '').localeCompare(b.tipoff ?? '');
  plays.sort(byTip);
  listed.sort(byTip);
  return { plays, listed, idle, leagueGames };
}

/** Listed, but likely to play: started if the slots want them, with a check before tip-off. */
const MAY_PLAY = new Set(['questionable', 'day_to_day']);
/** Confirmed lineups come out about half an hour before tip-off: the time to look again. */
const CHECK_BEFORE_TIP_MS = 30 * 60 * 1000; // def: half an hour, in milliseconds

interface VerdictRow {
  id: string;
  /** Tip-off in UTC, when the schedule has it. */
  tipoff: string | null;
  /** When to look again before the game (half an hour before tip-off), for a listed starter. */
  checkBy: string | null;
}

export interface TodayVerdict {
  /** The best lineup the slots hold from today's players: a listed starter carries a check time. */
  start: (VerdictRow & { slot: Slot })[];
  /** Players with a game and no slot left. */
  bench: VerdictRow[];
  /** Doubtful: rarely plays; started only once the report clears him. */
  check: VerdictRow[];
  /**
   * Ruled out on the report, or inactive on the team's lineup (#878); `inactive` marks a player out
   * by the lineup alone, whose reason the Out row gives.
   */
  out: (VerdictRow & { inactive: boolean })[];
  /** Slots nobody fills today: room to stream. */
  open: Slot[];
}

/**
 * Start and sit for today (#816): the most valuable lineup the league's slots hold from the active
 * players with a game, never an out or doubtful player nor one his team lists inactive (#878), so the
 * slot goes to the next player. A questionable or day-to-day starter keeps
 * his slot but says to check the report half an hour before tip-off; doubtful players are left to
 * check rather than started. Pure, so the Today card and the tests share it.
 */
export function todayVerdict<P extends TodayPlayer>(
  groups: { plays: TodaySlot<P>[]; listed: TodaySlot<P>[] },
  slots: Slot[],
  value: (id: string) => number,
  position: (id: string) => string | null | undefined,
): TodayVerdict {
  const row = (s: TodaySlot<P>): VerdictRow => {
    const listed = MAY_PLAY.has(s.player.injury_group ?? '');
    const checkBy = listed && s.tipoff ? new Date(Date.parse(s.tipoff) - CHECK_BEFORE_TIP_MS).toISOString() : null;
    return { id: s.player.player_id, tipoff: s.tipoff, checkBy };
  };
  const playing = groups.listed.filter((s) => !s.inactive);
  const available = [...groups.plays, ...playing.filter((s) => MAY_PLAY.has(s.player.injury_group ?? ''))];
  const byId = new Map(available.map((s) => [s.player.player_id, s]));
  const plan = bestLineup(
    available.map((s) => ({ id: s.player.player_id, position: position(s.player.player_id), value: value(s.player.player_id) })),
    slots,
  );
  const start = [...plan.started].map(([id, slot]) => ({ ...row(byId.get(id)!), slot }));
  start.sort((a, b) => (a.tipoff ?? '').localeCompare(b.tipoff ?? ''));
  return {
    start,
    bench: plan.benched.map((id) => row(byId.get(id)!)),
    check: playing.filter((s) => s.player.injury_group === 'doubtful').map(row),
    out: groups.listed
      .filter((s) => s.inactive || s.player.injury_group === 'out')
      .map((s) => ({ ...row(s), checkBy: null, inactive: s.player.injury_group !== 'out' })),
    open: plan.open,
  };
}
