/**
 * The league's real standings (#822): each team's won-lost record and place, as ESPN keeps them,
 * read with every sync of an ESPN league. My Team leads with the manager's place and how far back
 * of the team above and of first they are; the projected power table sits one click down.
 */
import { ordinal } from './format';

/** A team's record so far: in a category league ESPN counts categories, in points matchups. */
export interface TeamRecord {
  wins: number;
  losses: number;
  ties: number;
  /** ESPN's place for the team in the standings (its playoff seed); null when ESPN gives none. */
  seed: number | null;
}

export interface Standing {
  team: number;
  /** 1 for first, by ESPN's seed where it gives one, else by winning share. */
  place: number;
  record: TeamRecord;
  /** Games back of first: half the gap in wins plus half the gap in losses. */
  back: number;
}

const count = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);

/** A team's record from ESPN's team object (views mTeam and mStandings); null without one. */
export function espnRecord(team: unknown): TeamRecord | null {
  const t = team as { record?: { overall?: { wins?: unknown; losses?: unknown; ties?: unknown } }; playoffSeed?: unknown } | null;
  const overall = t?.record?.overall;
  if (!overall || typeof overall !== 'object') return null;
  const seed = typeof t.playoffSeed === 'number' && Number.isInteger(t.playoffSeed) && t.playoffSeed > 0 ? t.playoffSeed : null;
  return { wins: count(overall.wins), losses: count(overall.losses), ties: count(overall.ties), seed };
}

/** Games one record is behind another: a tie counts half a win and half a loss on both sides. */
export function gamesBack(behind: TeamRecord, ahead: TeamRecord): number {
  return (ahead.wins - behind.wins + (behind.losses - ahead.losses)) / 2; // def: a game back is a win and a loss
}

const share = (r: TeamRecord) => {
  const games = r.wins + r.losses + r.ties;
  return games ? (r.wins + r.ties / 2) / games : 0; // def: a tie is half a win
};

/**
 * The standings from the records, by team index: ESPN's order when every team has a seed and no
 * two share one, else by winning share, then wins. Null until a game is in the records.
 */
export function standingsOf(records: (TeamRecord | null | undefined)[] | undefined): Standing[] | null {
  const teams = (records ?? []).flatMap((r, team) => (r ? [{ team, record: r }] : []));
  if (teams.length < 2 || !teams.some((t) => t.record.wins + t.record.losses + t.record.ties > 0)) return null; // def: standings need two teams
  const seeds = teams.map((t) => t.record.seed);
  const seeded = seeds.every((s) => s !== null) && new Set(seeds).size === seeds.length;
  const order = [...teams].sort((a, b) =>
    seeded ? (a.record.seed ?? 0) - (b.record.seed ?? 0) : share(b.record) - share(a.record) || b.record.wins - a.record.wins || a.team - b.team,
  );
  const first = order[0]!.record;
  return order.map((t, i) => ({ team: t.team, place: i + 1, record: t.record, back: gamesBack(t.record, first) }));
}

/** "12-8" or "12-8-1". */
export function recordText(r: TeamRecord): string {
  return r.ties ? `${r.wins}-${r.losses}-${r.ties}` : `${r.wins}-${r.losses}`;
}

/** "2 games", "1 game", "half a game", "1.5 games". */
export function gamesText(n: number): string {
  const g = Math.abs(n);
  if (g === 0.5) return 'half a game'; // def: half a game
  return `${Number.isInteger(g) ? g : g.toFixed(1)} ${g === 1 ? 'game' : 'games'}`;
}

/**
 * The line that leads My Team: "3rd, 2 games back of 2nd and 5 games back of 1st", "2nd, 1 game back of
 * 1st", "1st, 2 games ahead of 2nd"; level where the gap is nothing. Null when the manager's team
 * is not in the standings.
 */
export function standingLine(table: Standing[], mine: number): string | null {
  const at = table.findIndex((s) => s.team === mine);
  if (at < 0) return null;
  const me = table[at]!;
  const place = ordinal(me.place);
  if (at === 0) {
    const next = table[1];
    if (!next) return place;
    const lead = gamesBack(next.record, me.record);
    return lead > 0 ? `${place}, ${gamesText(lead)} ahead of ${ordinal(next.place)}` : `${place}, level with ${ordinal(next.place)}`;
  }
  const above = table[at - 1]!;
  const gap = gamesBack(me.record, above.record);
  const toAbove = gap > 0 ? `${gamesText(gap)} back of ${ordinal(above.place)}` : `level with ${ordinal(above.place)}`;
  if (at === 1) return `${place}, ${toAbove}`;
  const toFirst = me.back > 0 ? `${gamesText(me.back)} back of 1st` : 'level with 1st';
  return `${place}, ${toAbove} and ${toFirst}`;
}
