/**
 * Import a public ESPN fantasy basketball league (#745). ESPN's league API answers a browser on
 * this site directly, so nothing passes through the Worker. A private league needs its owner's
 * ESPN cookies (espn_s2, SWID), which a browser will not send to another site: those leagues are
 * refused, and the page says how to make one viewable.
 *
 * The ids are ESPN's (the same constants the espn-api library uses): lineup slots 0 PG, 1 SG, 2 SF,
 * 3 PF, 4 C, 5 G, 6 F, 7 SG/SF, 8 G/F, 9 PF/C, 10 F/C, 11 UTIL, 12 bench, 13 IR; stats 0 PTS,
 * 1 BLK, 2 STL, 3 AST, 6 REB, 11 TO, 13 FGM, 14 FGA, 15 FTM, 16 FTA, 17 3PM, 19 FG%, 20 FT%.
 */
import type { Format, PointWeights, Scoring } from './fantasy-league';
import type { Slots } from './lineup';

const API = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba';

/** ESPN numbers a season by the year it ends: 2026-27 is 2027; a WNBA-style single year stays. */
export function espnLeagueUrl(leagueId: string, season: string): string {
  const year = season.includes('-') ? String(Number(season.slice(0, 4)) + 1) : season;
  // mMatchupScore adds the schedule, for this week's opponent (#815)
  return `${API}/seasons/${year}/segments/0/leagues/${encodeURIComponent(leagueId)}?view=mTeam&view=mRoster&view=mSettings&view=mMatchupScore`;
}

const G_SLOTS = new Set([0, 1, 5]);
const F_SLOTS = new Set([2, 3, 6]);
const BENCH = 12;
const IR = 13;
/** Stat ids that make an 8-category league (no turnovers) or a 9-category one. */
const TURNOVERS = 11;
const POINT_STATS: Record<number, keyof PointWeights> = {
  0: 'points',
  6: 'rebounds',
  3: 'assists',
  2: 'steals',
  1: 'blocks',
  11: 'turnovers',
  17: 'threes',
  13: 'fgm',
  14: 'fga',
  15: 'ftm',
  16: 'fta',
};

export interface ImportedLeague {
  name: string;
  settings: { teams: number; rosterSpots: number; scoring: Scoring; format: Format; weights: Partial<PointWeights> | null; lineup: Slots };
  /** Each team with ESPN's id for it (null when ESPN gave none). */
  teams: { id: number | null; name: string; players: string[] }[];
  /** This week's pairings: each team's ESPN id to its opponent's, from the schedule (#815). */
  opponents: Map<number, number>;
}

interface EspnLeague {
  settings?: {
    name?: string;
    size?: number;
    rosterSettings?: { lineupSlotCounts?: Record<string, number> };
    scoringSettings?: { scoringType?: string; scoringItems?: { statId: number; points?: number }[] };
    /** Each matchup period's scoring periods (days). */
    scheduleSettings?: { matchupPeriods?: Record<string, number[]> };
  };
  status?: { currentMatchupPeriod?: number };
  /** Today's scoring period (day of the season). */
  scoringPeriodId?: number;
  schedule?: { matchupPeriodId?: number; home?: { teamId?: number }; away?: { teamId?: number } }[];
  teams?: {
    id?: number;
    name?: string;
    location?: string;
    nickname?: string;
    roster?: { entries?: { playerPoolEntry?: { player?: { fullName?: string } } }[] };
  }[];
}

/** The League page's view of an ESPN league's JSON. Throws on anything that is not a league. */
export function fromEspnLeague(json: unknown): ImportedLeague {
  const data = json as EspnLeague;
  if (!data?.settings || !Array.isArray(data.teams)) throw new Error('That is not an ESPN league: check the league ID and the season.');
  const counts = Object.entries(data.settings.rosterSettings?.lineupSlotCounts ?? {}).map(([slot, n]) => [Number(slot), Number(n) || 0] as const);
  const lineup: Slots = { G: 0, F: 0, C: 0, UTIL: 0 };
  let rosterSpots = 0;
  for (const [slot, n] of counts) {
    if (slot === IR || n <= 0) continue;
    rosterSpots += n;
    if (slot === BENCH) continue;
    if (G_SLOTS.has(slot)) lineup.G += n;
    else if (F_SLOTS.has(slot)) lineup.F += n;
    else if (slot === 4) lineup.C += n;
    // the two-position slots (SG/SF, G/F, PF/C, F/C) and Util take more than one position: Util
    else lineup.UTIL += n;
  }
  const type = data.settings.scoringSettings?.scoringType ?? '';
  const items = data.settings.scoringSettings?.scoringItems ?? [];
  const points = type.includes('POINTS');
  const weights: Partial<PointWeights> | null = points
    ? Object.fromEntries(items.filter((i) => i.statId in POINT_STATS).map((i) => [POINT_STATS[i.statId]!, i.points ?? 0]))
    : null;
  const scoring: Scoring = points ? 'points' : items.some((i) => i.statId === TURNOVERS) ? 'cats9' : 'cats8';
  const teams = data.teams.map((t) => ({
    id: typeof t.id === 'number' ? t.id : null,
    name: (t.name ?? `${t.location ?? ''} ${t.nickname ?? ''}`).trim() || 'Team',
    players: (t.roster?.entries ?? []).map((e) => e.playerPoolEntry?.player?.fullName).filter((n): n is string => !!n),
  }));
  return {
    name: data.settings.name ?? 'ESPN league',
    settings: { teams: data.settings.size ?? teams.length, rosterSpots, scoring, format: type === 'ROTO' ? 'roto' : 'h2h', weights, lineup },
    teams,
    opponents: weekOpponents(data),
  };
}

/**
 * The matchup period that holds today: ESPN's current one, or else the period whose days include
 * today's scoring period. Null when the league says neither.
 */
function currentPeriod(data: EspnLeague): number | null {
  const current = data.status?.currentMatchupPeriod;
  if (typeof current === 'number' && current > 0) return current;
  const today = data.scoringPeriodId;
  if (typeof today !== 'number') return null;
  const found = Object.entries(data.settings?.scheduleSettings?.matchupPeriods ?? {}).find(([, days]) => Array.isArray(days) && days.includes(today));
  return found ? Number(found[0]) : null;
}

/** Each team's opponent in this week's matchup, both ways, by ESPN team id; a team on a bye has none. */
function weekOpponents(data: EspnLeague): Map<number, number> {
  const out = new Map<number, number>();
  const period = currentPeriod(data);
  if (period === null) return out;
  for (const m of data.schedule ?? []) {
    const home = m.home?.teamId;
    const away = m.away?.teamId;
    if (m.matchupPeriodId !== period || typeof home !== 'number' || typeof away !== 'number') continue;
    out.set(home, away);
    out.set(away, home);
  }
  return out;
}

/** A league ID, or the ID in a pasted ESPN league address (…?leagueId=123456). */
export function espnLeagueId(text: string): string | null {
  const t = text.trim();
  const fromUrl = /[?&]leagueId=(\d+)/i.exec(t)?.[1];
  if (fromUrl) return fromUrl;
  return /^\d{3,12}$/.test(t) ? t : null;
}
