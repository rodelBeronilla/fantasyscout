/**
 * The one-line notes on flagged players (#823): a call and a line, written by the local model
 * from the build's numbers and the recent news, and merged by the player-notes workflow into
 * notes/players/<league>.json only when every number and quotation in a line is found in its
 * inputs. The daily run writes every flagged player's; a run after each build rewrites those whose
 * listing or flagged headline changed since (#879).
 *
 * A page shows a line beside a player it flags while what it was written on still holds (#879).
 * Each line keeps its listing, its flagged headline's day, the board numbers it cites and the side
 * of playing it takes. When one of those has changed since, the line still shows, with when it was
 * written and what changed ("may be out of date"); when the player is now on the other side of
 * playing (it was written on an Out listing and he is off the report, or on a healthy one and he
 * is out or inactive), the line is withdrawn and the page says so, and when. Lines older than a
 * day's grace are not shown. Claims never decide a line's side on their own (player_notes.py).
 */
import { useEffect, useState } from 'react';

import { PARAMS } from '../generated/parameters';
import { dataHref, type League } from './data';
import { easternClock, when } from './format';
import { easternDate, sitsOut } from './today';

/** One fact a line states: the number or quotation, what it is, and the row it comes from. */
interface NoteSource {
  what: string;
  value: string;
  row_ref: string;
}

/** The call a note makes, which the pages put first. */
export type NoteCall = 'start' | 'sit' | 'add' | 'drop' | 'hold' | 'watch';

/** The side of playing a line takes: sits (out or doubtful), plays (healthy or probable). */
type Side = 'sits' | 'plays';

export interface PlayerNote {
  line: string;
  /** The call (#879); absent in files from before it. */
  action?: NoteCall | null;
  sources: NoteSource[];
  /** When the line was written, UTC (#879); files from before it give only the file's day. */
  written_at?: string | null;
  /** The player's injury listing and news flag when the line was written. */
  injury_status: string | null;
  injury_group?: string | null;
  news_flag: string | null;
  /** The day of the flagged headline it was written on. */
  news_date?: string | null;
  /** The side of playing the line takes; null for a toss-up. */
  says?: Side | null;
}

/** How the file's last run went (#879), for Data Health. */
interface NotesRun {
  at: string | null;
  mode: 'daily' | 'changed';
  flagged: number;
  asked: number;
  model_away: boolean;
}

export interface PlayerNotes {
  league: League;
  label: string;
  model: string | null;
  /** The day of the last run (Eastern). */
  as_of: string;
  /** When the last daily run the model answered drafted the lines. */
  drafted_at?: string | null;
  run?: NotesRun;
  notes: Record<string, PlayerNote>;
}

/** Days after the day a line was written that it stands (methodology/parameters.yml). */
const STANDS_DAYS = PARAMS['notes.stand_days'];
const DAY_MS = 86_400_000; // def: a day in ms
const HOUR_MS = 3_600_000; // def: an hour in ms
/** How long since the last daily draft before Data Health says the notes were not drafted. */
const LATE_MS = PARAMS['notes.late_hours'] * HOUR_MS;

/** A row as the check reads it: the listing, the headline, the lineup and the numbers a line may cite. */
export interface NotedRow {
  player_id: string;
  injury_status?: string | null;
  injury_group?: string | null;
  news_flag?: string | null;
  news_date?: string | null;
  lineup_role?: string | null;
  lineup_date?: string | null;
  rank_total?: number | null;
  value_rest_of_season?: number | null;
  proj_minutes_pg?: number | null;
  availability_multiplier?: number | null;
  expected_games_missed?: number | null;
  games_this_week?: number | null;
  games_remaining?: number | null;
}

type Metric = 'rank_total' | 'value_rest_of_season' | 'proj_minutes_pg' | 'availability_multiplier' | 'expected_games_missed' | 'games_this_week' | 'games_remaining';

/** The board column behind each number a line may cite (ai/player_notes.py METRICS), and its name. */
const METRICS: Record<string, { column: Metric; label: string }> = {
  rank: { column: 'rank_total', label: 'board rank' },
  value_rest_of_season: { column: 'value_rest_of_season', label: 'rest-of-season value' },
  projected_minutes: { column: 'proj_minutes_pg', label: 'projected minutes' },
  availability_share: { column: 'availability_multiplier', label: 'share of games expected to play' },
  expected_games_missed: { column: 'expected_games_missed', label: 'games expected to miss' },
  games_this_week: { column: 'games_this_week', label: 'games this week' },
  games_remaining: { column: 'games_remaining', label: 'games left' },
};

/** The line, and whether what it was written on still holds: holds, changed (shown, marked) or withdrawn. */
export interface NoteView {
  note: PlayerNote;
  state: 'holds' | 'changed' | 'withdrawn';
  /** What changed since the line was written, in words. */
  changes: string[];
}

const listing = (status: string | null | undefined) => (status ? `listed ${status}` : 'off the injury report');

/** The side of playing a row puts the player on today, or null for a toss-up or an unknown listing. */
function sideNow(row: NotedRow, today: string): Side | null {
  if (row.injury_group === undefined) return null;
  if (sitsOut({ player_id: row.player_id, injury_group: row.injury_group, lineup_role: row.lineup_role, lineup_date: row.lineup_date }, today)) return 'sits';
  return !row.injury_group || row.injury_group === 'healthy' || row.injury_group === 'probable' ? 'plays' : null;
}

/** A cited number against the row's now, at the precision the line wrote it; null when it holds or cannot be read. */
function numberChange(source: NoteSource, row: NotedRow): string | null {
  const metric = METRICS[source.what];
  const now = metric ? row[metric.column] : undefined;
  if (!metric || typeof now !== 'number') return null;
  const share = source.value.endsWith('%');
  const token = source.value.replace('%', '');
  const written = Number(token);
  if (!Number.isFinite(written)) return null;
  const digits = token.includes('.') ? token.split('.')[1]!.length : 0;
  const current = (share ? now * 100 : now).toFixed(digits); // def: a share written as a percentage
  return Number(current) === written ? null : `${metric.label} now ${current}${share ? '%' : ''} (was ${source.value})`;
}

/** What changed since the line was written: the listing, the lineup, a newer headline, a cited number. */
function changesOf(note: PlayerNote, row: NotedRow, today: string): string[] {
  const out: string[] = [];
  if ((note.injury_status ?? null) !== (row.injury_status ?? null)) out.push(`${listing(row.injury_status)} (was ${listing(note.injury_status).replace('listed ', '')})`);
  const inactive = row.lineup_role === 'inactive' && row.lineup_date === today;
  if (inactive && note.says !== 'sits') out.push("inactive on his team's lineup today");
  // a newer flagged headline; one that only aged out of the three days is no news
  const newer = 'news_date' in note ? (row.news_date ?? null) !== (note.news_date ?? null) : (row.news_flag ?? null) !== (note.news_flag ?? null);
  if (row.news_flag && newer) out.push('a newer flagged headline');
  for (const s of note.sources) {
    const change = numberChange(s, row);
    if (change) out.push(change);
  }
  return out;
}

/** The Eastern day a line was written: its time, or the file's day for a file from before #879. */
function writtenDay(note: PlayerNote, file: PlayerNotes): string | null {
  if (note.written_at) {
    const d = new Date(note.written_at);
    return Number.isNaN(d.getTime()) ? null : easternDate(d);
  }
  return typeof file.as_of === 'string' ? file.as_of : null;
}

/**
 * The line to show for a player, and whether it still holds: written today or within the grace
 * days before, and withdrawn when the player is now on the other side of playing from the line.
 * Null when there is no line or it is too old.
 */
export function noteFor(file: PlayerNotes | null | undefined, row: NotedRow, today: string): NoteView | null {
  if (!file?.notes) return null;
  const note = file.notes[row.player_id];
  if (!note || typeof note.line !== 'string') return null;
  const written = writtenDay(note, file);
  if (!written) return null;
  const age = (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${written}T12:00:00Z`)) / DAY_MS;
  if (!(age >= 0 && age <= STANDS_DAYS)) return null;
  const changes = changesOf(note, row, today);
  const now = sideNow(row, today);
  if (note.says && now && note.says !== now) return { note, state: 'withdrawn', changes };
  return { note, state: changes.length ? 'changed' : 'holds', changes };
}

const EASTERN_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });

/** When a line was written, as the page says it: "13:20 ET" today, "Nov 7, 13:20 ET" before. */
export function writtenLabel(note: PlayerNote, file: PlayerNotes | null | undefined, today: string): string {
  const iso = note.written_at ?? '';
  const at = new Date(iso);
  if (!iso || Number.isNaN(at.getTime())) return file?.as_of === today ? 'today' : EASTERN_DAY.format(new Date(`${file?.as_of ?? today}T12:00:00Z`));
  const clock = `${easternClock(iso)} ET`;
  return easternDate(at) === today ? clock : `${EASTERN_DAY.format(at)}, ${clock}`;
}

/** The league's notes file, or null when there is none (or it cannot be read). */
export async function fetchPlayerNotes(league: League, get: typeof fetch = fetch): Promise<PlayerNotes | null> {
  try {
    const r = await get(dataHref(`notes/players/${league}.json`));
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
    const body = (await r.json()) as PlayerNotes;
    return body && typeof body === 'object' && body.notes && typeof body.notes === 'object' ? body : null;
  } catch {
    return null;
  }
}

/** The league's notes, read once per league; null until read and when there are none. */
export function usePlayerNotes(league: League): PlayerNotes | null {
  const [file, setFile] = useState<PlayerNotes | null>(null);
  useEffect(() => {
    let live = true;
    void fetchPlayerNotes(league).then((f) => live && setFile(f));
    return () => {
      live = false;
    };
  }, [league]);
  return file;
}

/** Data Health's line on the notes (#879): drafted on time, or not, and why. */
export function notesHealth(files: [League, PlayerNotes | null][], now: Date): { tone: 'good' | 'warn' | 'muted'; text: string } {
  const have = files.filter((f): f is [League, PlayerNotes] => !!f[1]);
  if (!have.length) return { tone: 'muted', text: 'No player notes have been published yet.' };
  const late = have.filter(([, f]) => f.run?.model_away || !f.drafted_at || now.getTime() - Date.parse(f.drafted_at) > LATE_MS);
  if (!late.length) {
    const newest = have.map(([, f]) => f.drafted_at ?? '').sort().at(-1) ?? '';
    const counts = have.map(([league, f]) => `${league.toUpperCase()} ${Object.keys(f.notes).length}`).join(', ');
    return { tone: 'good', text: `Player notes drafted ${when(newest)} (lines standing: ${counts}).` };
  }
  const parts = late.map(([league, f]) => {
    const why = f.run?.model_away ? `the local model was away at the last run, ${when(f.run.at)}` : 'no daily run has drafted them in time';
    const stand = f.drafted_at ? `; the lines drafted ${when(f.drafted_at)} stand until the day after` : '';
    return `${league.toUpperCase()}: ${why}${stand}`;
  });
  return { tone: 'warn', text: `Player notes not drafted. ${parts.join('. ')}.` };
}
