/**
 * The league, week by week (#1049): every week's matchup totals as the Yahoo import read them.
 */
import type { ScoreSoFar } from './matchup';

/** One fantasy week as the import read it: each team's score by index, null where Yahoo gave none. */
export interface LeagueWeek {
  week: number;
  /** Each team's totals, by team index. */
  teams: (ScoreSoFar | null)[];
  /** The week is over: its totals are final, unless a stat correction moves them. */
  final: boolean;
}
