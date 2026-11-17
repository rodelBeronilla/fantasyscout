/**
 * A draft of "the league, week by week" (step 3, item 2) with an invented league, for the owner's
 * first look on the preview. Never merged: the real page reads the weeks the Yahoo import brings.
 */
import { DEFAULT_SETTINGS, normalize } from '../lib/fantasy-league';
import type { LeagueWeek } from '../lib/league-weeks';
import type { ScoreSoFar } from '../lib/matchup';
import { LeagueWeeks } from './LeagueWeeks';

const NAMES = ['Rim Runners', 'Glass Cleaners', 'Corner Threes', 'Fast Breakers', 'Paint Patrol', 'Pick and Pop', 'Bench Mob', 'Full Court Press'];

// a seeded generator, so the draft shows the same league on every load
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const around = (mid: number, spread: number) => Math.round(mid + (rand() * 2 - 1) * spread);

// each team leans somewhere, as real ones do: a big-man team, a guard team...
const LEAN = NAMES.map(() => ({ big: rand() * 2 - 1, guard: rand() * 2 - 1 }));

function score(team: number, share: number): ScoreSoFar {
  const { big, guard } = LEAN[team]!;
  const n = (mid: number, lean: number, spread: number) => Math.max(0, around(mid * share * (1 + 0.12 * lean), spread * share));
  const fga = n(450, 0.3 * big, 30);
  const fta = n(125, 0.6 * big, 20);
  return {
    totals: {
      z_points: n(640, 0.2 * guard, 60),
      z_rebounds_total: n(250, big, 25),
      z_assists: n(150, guard, 20),
      z_steals: n(40, 0.5 * guard, 8),
      z_blocks: n(26, 1.4 * big, 8),
      z_three_pointers_made: n(72, guard, 14),
      z_turnovers: n(75, 0.5 * guard, 10),
    },
    shots: {
      z_field_goal_pct: [Math.round(fga * (0.47 + 0.03 * big + (rand() - 0.5) * 0.03)), fga],
      z_free_throw_pct: [Math.round(fta * (0.78 - 0.05 * big + (rand() - 0.5) * 0.06)), fta],
    },
  };
}

const WEEKS: LeagueWeek[] = [1, 2, 3, 4, 5].map((week) => ({
  week,
  final: week < 5,
  // the week under way is about two-fifths done
  teams: NAMES.map((_, t) => score(t, week < 5 ? 1 : 0.4)),
}));

const SETUP = normalize({ teams: NAMES.length, names: NAMES, mine: 2 }, DEFAULT_SETTINGS.nba);

export default function LeagueWeeksDraft() {
  return <LeagueWeeks setup={SETUP} weeks={WEEKS} />;
}
