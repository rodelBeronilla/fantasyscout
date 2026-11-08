/**
 * The one-line notes on flagged players (#823): written by the local model each day from the
 * build's numbers and the recent news, and published by the player-notes workflow to
 * notes/players/<league>.json only when every number and quotation in a line is found in its
 * inputs. A page shows a line beside a player it flags, and nothing when there is no file, the
 * file is old, or the player's listing has changed since the line was written.
 */
import { useEffect, useState } from 'react';

import { dataHref, type League } from './data';

/** One fact a line states: the number or quotation, what it is, and the row it comes from. */
interface NoteSource {
  what: string;
  value: string;
  row_ref: string;
}

export interface PlayerNote {
  line: string;
  sources: NoteSource[];
  /** The player's injury listing and news flag when the line was written. */
  injury_status: string | null;
  news_flag: string | null;
}

export interface PlayerNotes {
  league: League;
  label: string;
  model: string | null;
  /** The day the lines were written for (Eastern). */
  as_of: string;
  notes: Record<string, PlayerNote>;
}

/** How many days a file's lines stand: the workflow writes them daily, so a day's grace. */
const STANDS_DAYS = 1; // def: a daily file and a day's grace
const DAY_MS = 86_400_000; // def: a day in ms

/** A board row as the check reads it. */
export interface NotedRow {
  player_id: string;
  injury_status?: string | null;
  news_flag?: string | null;
}

/**
 * The line to show for a player: from a file written for today or the day before, and only while
 * his injury listing and news flag are the ones it was written on. Null otherwise.
 */
export function noteFor(file: PlayerNotes | null | undefined, row: NotedRow, today: string): PlayerNote | null {
  if (!file?.notes || typeof file.as_of !== 'string') return null;
  const age = (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${file.as_of}T12:00:00Z`)) / DAY_MS;
  if (!(age >= 0 && age <= STANDS_DAYS)) return null;
  const note = file.notes[row.player_id];
  if (!note || typeof note.line !== 'string') return null;
  if ((note.injury_status ?? null) !== (row.injury_status ?? null) || (note.news_flag ?? null) !== (row.news_flag ?? null)) return null;
  return note;
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
