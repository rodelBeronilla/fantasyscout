/**
 * Playoff odds (#821): the standings model (standings.ts) played forward over the regular season's
 * matchups still to come, many seasons over. Each week each category of each matchup goes to one
 * side with the model's chance of winning it, as the matchup chance assumes; the records start from
 * ESPN's at the last sync, or level for a league entered by hand, and the top teams by winning share
 * make the playoffs. The draws are seeded, so the page shows the same odds on every visit and the
 * tests can pin them. A points league plays each week out on fantasy points instead (#877).
 */
import type { League } from './data';
import type { Format } from './fantasy-league';
import type { TeamRecord } from './records';
import { normalCdf, rivals, standingsModel, teamTotals } from './standings';
import { PARAMS } from '../generated/parameters';

/** How a matchup goes into the records: each category a win or a loss, or one result a week. */
export type Tally = 'categories' | 'matchups';

/** A week's matchups: the two teams of each, by index. */
export type Week = [number, number][];

/** The seed every simulation starts from: any fixed number does. */
const SEED = 821; // def: a fixed seed, the issue's number

/** Seasons played out for the odds. */
const SIMULATIONS: number = PARAMS['playoffs.simulations'];

/** A small seeded generator (mulberry32): the same seed draws the same seasons. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0; // def: mulberry32's increment
    let t = Math.imul(a ^ (a >>> 15), 1 | a); // def: mulberry32's mix
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; // def: mulberry32's mix
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; // def: mulberry32's mix, over 2^32
  };
}

/**
 * Every team plays every other once before any pair meets again (the circle method), for a league
 * whose schedule this site does not have. An odd league gives one team a bye each week.
 */
export function roundRobin(teams: number, weeks: number): Week[] {
  const n = teams % 2 === 0 ? teams : teams + 1; // def: an odd league adds a bye
  if (n < 2) return []; // def: a matchup needs two teams
  const out: Week[] = [];
  for (let w = 0; w < weeks; w += 1) {
    const turn = w % (n - 1);
    const at = (slot: number) => (slot === n - 1 ? n - 1 : (slot + turn) % (n - 1));
    const week: Week = [];
    for (let slot = 0; slot < n / 2; slot += 1) { // def: half the slots face the other half
      const a = at(slot);
      const b = at(n - 1 - slot);
      if (a < teams && b < teams) week.push([a, b]);
    }
    out.push(week);
  }
  return out;
}

export interface OddsInput {
  /** Each team's category totals, by index. */
  totals: Record<string, number>[];
  /** The standard deviation of a week's gap between two teams, per category. */
  spread: Record<string, number>;
  cats: string[];
  /** Each team's record so far; a missing one starts level. */
  records: (TeamRecord | null | undefined)[];
  /** The regular season's weeks still to play. */
  weeks: Week[];
  tally: Tally;
  /** Teams that make the playoffs. */
  spots: number;
  sims?: number;
  seed?: number;
}

export interface Odds {
  /** Each team's chance of making the playoffs, by index. */
  odds: number[];
  /** Each team's average wins and losses at the end of the regular season, ties counting half to each. */
  wins: number[];
  losses: number[];
}

const share = (w: number, l: number, t: number) => {
  const games = w + l + t;
  return games ? (w + t / 2) / games : 1 / 2; // def: a tie is half a win; no games is level
};

/** The playoff odds from the totals, the records so far and the weeks left. */
export function simulateOdds(input: OddsInput): Odds {
  const teams = input.totals.length;
  const sims = Math.max(1, input.sims ?? SIMULATIONS);
  const random = seededRandom(input.seed ?? SEED);
  const n = input.cats.length;
  // each pair's chance of taking each category in a week, the first team's side
  const chance = input.totals.map((a) =>
    input.totals.map((b) => input.cats.map((c) => normalCdf(((a[c] ?? 0) - (b[c] ?? 0)) / (input.spread[c] ?? 1)))),
  );
  const start = Array.from({ length: teams }, (_, t) => input.records[t] ?? { wins: 0, losses: 0, ties: 0 });
  const made = new Array<number>(teams).fill(0);
  const winSum = new Array<number>(teams).fill(0);
  const lossSum = new Array<number>(teams).fill(0);
  for (let s = 0; s < sims; s += 1) {
    const w = start.map((r) => r.wins);
    const l = start.map((r) => r.losses);
    const t = start.map((r) => r.ties);
    for (const week of input.weeks) {
      for (const [a, b] of week) {
        const p = chance[a]?.[b] ?? [];
        let k = 0;
        for (let c = 0; c < n; c += 1) if (random() < (p[c] ?? 1 / 2)) k += 1; // def: no model is a coin flip
        if (input.tally === 'categories') {
          w[a]! += k;
          l[a]! += n - k;
          w[b]! += n - k;
          l[b]! += k;
        } else if (2 * k === n) { // def: half the categories is a tie
          t[a]! += 1;
          t[b]! += 1;
        } else {
          const winner = 2 * k > n ? a : b; // def: more than half the categories wins
          w[winner]! += 1;
          l[winner === a ? b : a]! += 1;
        }
      }
    }
    // the table by winning share, then wins; a level tie falls at random
    const jitter = Array.from({ length: teams }, () => random());
    const order = Array.from({ length: teams }, (_, i) => i).sort(
      (x, y) => share(w[y]!, l[y]!, t[y]!) - share(w[x]!, l[x]!, t[x]!) || w[y]! - w[x]! || jitter[x]! - jitter[y]!,
    );
    order.slice(0, input.spots).forEach((team) => (made[team]! += 1));
    for (let i = 0; i < teams; i += 1) {
      winSum[i]! += w[i]! + t[i]! / 2; // def: a tie is half a win
      lossSum[i]! += l[i]! + t[i]! / 2; // def: and half a loss
    }
  }
  return { odds: made.map((m) => m / sims), wins: winSum.map((x) => x / sims), losses: lossSum.map((x) => x / sims) };
}

/** What the odds read from the league kept here. */
export interface OddsLeague {
  rosters: string[][];
  il: string[];
  rosterSpots: number;
  format: Format;
  playoffs: { teams: number };
}

/**
 * The league's playoff odds under the standings model (#821): every team's category totals, each
 * active player counted by the share of the games left he is expected to play, and the spread of a
 * week's gap. Null outside a head-to-head category league, or until every team has half a roster
 * in (a team left empty would read as a sure loss to everyone).
 */
export function playoffOdds(
  league: League,
  setup: OddsLeague,
  cats: string[],
  catValue: (id: string) => Record<string, number> | undefined,
  availability: (id: string) => number,
  schedule: { weeks: Week[]; records: (TeamRecord | null | undefined)[]; tally: Tally },
  sims?: number,
): Odds | null {
  if (setup.format !== 'h2h' || !cats.length) return null;
  const teams = setup.rosters.length;
  if (rivals(setup.rosters, -1, setup.rosterSpots).length !== teams) return null;
  const active = setup.rosters.map((r) => r.filter((id) => !setup.il.includes(id)));
  const totals = active.map((r) => teamTotals(r, cats, catValue, availability));
  const players = active.reduce((s, r) => s + r.reduce((n, id) => n + availability(id), 0), 0) / teams;
  const model = standingsModel(league, cats, players, 'h2h');
  return simulateOdds({
    totals,
    spread: model.spread,
    cats,
    records: schedule.records,
    weeks: schedule.weeks,
    tally: schedule.tally,
    spots: Math.min(setup.playoffs.teams, teams),
    sims,
  });
}

/** The one "category" a points league's week is decided on. */
const POINTS = 'fpts';

/**
 * A points league's playoff odds (#877): each team's projected fantasy points per game summed over
 * its active players, each counted by the share of games he is expected to play. A week's margin
 * between two teams is drawn normal around the gap between them, with a spread of
 * `playoffs.points_spread_share` of the league's average team; one result a week. That spread is a
 * prior nobody has measured yet (#891). Every team plays the same games a week here, so the games
 * a week scale both the gap and the spread alike and drop out. Null outside a head-to-head league,
 * until every team has half a roster in, or when no player has a projection.
 */
export function pointsPlayoffOdds(
  setup: OddsLeague,
  fpts: (id: string) => number,
  availability: (id: string) => number,
  schedule: { weeks: Week[]; records: (TeamRecord | null | undefined)[] },
  sims?: number,
): Odds | null {
  if (setup.format !== 'h2h') return null;
  const teams = setup.rosters.length;
  if (rivals(setup.rosters, -1, setup.rosterSpots).length !== teams) return null;
  const totals = setup.rosters.map((r) => ({
    [POINTS]: r.filter((id) => !setup.il.includes(id)).reduce((s, id) => s + fpts(id) * availability(id), 0),
  }));
  const average = totals.reduce((s, t) => s + (t[POINTS] ?? 0), 0) / teams;
  if (!(average > 0)) return null;
  return simulateOdds({
    totals,
    spread: { [POINTS]: PARAMS['playoffs.points_spread_share'] * average },
    cats: [POINTS],
    records: schedule.records,
    weeks: schedule.weeks,
    tally: 'matchups',
    spots: Math.min(setup.playoffs.teams, teams),
    sims,
  });
}
