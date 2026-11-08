import type { League } from '../lib/data';
import { type NoteCall, noteFor, type NotedRow, type PlayerNotes, usePlayerNotes, writtenLabel } from '../lib/player-notes';
import { easternDate } from '../lib/today';

const CALL: Record<NoteCall, string> = { start: 'Start', sit: 'Sit', add: 'Add', drop: 'Drop', hold: 'Hold', watch: 'Watch' };

/**
 * A flagged player's note (#823, #879), under his name: the call first, then the line, marked as
 * AI-written with when it was written and where each of its numbers and quotations comes from on
 * hover. A line whose inputs changed since says what changed; one the player's listing now
 * contradicts is withdrawn, and the page says so. Nothing when there is no line.
 */
export function PlayerNoteLine({
  notes,
  row,
  today = easternDate(),
  wide = false,
}: {
  notes: PlayerNotes | null | undefined;
  row: NotedRow;
  today?: string;
  /** A page with room for a longer line (the player page, the board's note row). */
  wide?: boolean;
}) {
  const view = noteFor(notes, row, today);
  if (!view) return null;
  const { note, state, changes } = view;
  const at = writtenLabel(note, notes, today);
  const box = `block ${wide ? 'max-w-[40rem] text-sm' : 'max-w-[22rem] text-xs'} basis-full whitespace-normal text-muted`;
  if (state === 'withdrawn') {
    return (
      <span className={box} data-testid="player-note" data-state={state}>
        AI note from {at} withdrawn: {changes.join('; ') || 'his listing changed'}.
      </span>
    );
  }
  const traced = note.sources.map((s) => `${s.value}: ${s.what} (${s.row_ref})`).join('\n');
  return (
    <span className={box} data-testid="player-note" data-state={state}>
      {note.action && CALL[note.action] && (
        <strong className="mr-1 font-semibold text-fg" data-testid="player-note-call">
          {CALL[note.action]}:
        </strong>
      )}
      {note.line}{' '}
      <span
        className="rounded border border-line px-1 text-[10px] whitespace-nowrap"
        title={`${notes?.label ?? 'AI-written'}${notes?.model ? ` by ${notes.model}` : ''}, ${at}. Every number and quotation is checked against its source:\n${traced}`}
        data-testid="player-note-label"
      >
        AI note · {at}
      </span>
      {state === 'changed' && (
        <span className="ml-1 text-warn" data-testid="player-note-changed">
          May be out of date: {changes.join('; ')}.
        </span>
      )}
    </span>
  );
}

/** The player page's note (#879): its own box under the header, the call first; nothing without a line. */
export function PlayerNoteBox({ league, row }: { league: League; row: NotedRow }) {
  const notes = usePlayerNotes(league);
  if (!noteFor(notes, row, easternDate())) return null;
  return (
    <section className="rounded-lg border border-line bg-card px-3 py-2" aria-label="AI note" data-testid="player-page-note">
      <PlayerNoteLine notes={notes} row={row} wide />
    </section>
  );
}
