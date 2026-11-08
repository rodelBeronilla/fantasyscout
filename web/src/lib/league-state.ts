/**
 * A league's live state, whichever way it came in (#874): an ESPN import, the Yahoo bookmark, or
 * the League page by hand. My Team's standings and playoff odds start from the records the
 * import brought, else from those entered by hand; the playoff weeks are the import's, else the
 * first week entered, else the schedule's last.
 */
import type { LeagueSetup, Tally } from './fantasy-league';
import type { TeamRecord } from './records';

/** Where the records came from. */
export type RecordsFrom = 'espn' | 'yahoo' | 'entered';

export interface LeagueRecords {
  records: (TeamRecord | null)[];
  tally: Tally;
  from: RecordsFrom;
}

/** The records the standings and the odds start from; null when no team has one. */
export function leagueRecords(setup: LeagueSetup): LeagueRecords | null {
  const source = setup.source;
  if (source?.records?.some(Boolean)) return { records: source.records, tally: source.tally ?? 'categories', from: source.host };
  if (setup.standings.records.some(Boolean)) return { ...setup.standings, from: 'entered' };
  return null;
}

/** "from ESPN at the last sync", "from Yahoo at the last import", "as entered on the League page". */
export function recordsFromText(from: RecordsFrom): string {
  if (from === 'espn') return 'from ESPN at the last sync';
  if (from === 'yahoo') return 'from Yahoo at the last import';
  return 'as entered on the League page';
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); // def: a day in ms

/**
 * The playoff weeks the league fixes: the import's (ESPN's or Yahoo's, with the host's week
 * numbers), else from the first week entered by hand over the weeks they take. Null leaves them to
 * the schedule's last weeks.
 */
export function fixedPlayoffs(setup: LeagueSetup): { from: string; to: string; periods: [number, number] | null } | null {
  const imported = setup.source?.playoffWeeks;
  if (imported) return imported;
  const start = setup.playoffs.start;
  return start ? { from: start, to: addDays(start, setup.playoffs.weeks * 7 - 1), periods: null } : null; // def: a week is seven days
}
