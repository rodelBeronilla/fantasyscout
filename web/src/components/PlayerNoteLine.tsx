import { noteFor, type NotedRow, type PlayerNotes } from '../lib/player-notes';
import { easternDate } from '../lib/today';

/**
 * A flagged player's one-line note (#823), under his name: the line, marked as AI-written, with
 * where each of its numbers and quotations comes from on hover. Nothing when there is no line.
 */
export function PlayerNoteLine({ notes, row, today = easternDate() }: { notes: PlayerNotes | null | undefined; row: NotedRow; today?: string }) {
  const note = noteFor(notes, row, today);
  if (!note) return null;
  const traced = note.sources.map((s) => `${s.value}: ${s.what} (${s.row_ref})`).join('\n');
  return (
    <span className="block max-w-[22rem] basis-full text-xs whitespace-normal text-muted" data-testid="player-note">
      {note.line}{' '}
      <span
        className="rounded border border-line px-1 text-[10px] whitespace-nowrap"
        title={`${notes?.label ?? 'AI-written'}${notes?.model ? ` by ${notes.model}` : ''}. Every number and quotation is checked against its source:\n${traced}`}
        data-testid="player-note-label"
      >
        AI note
      </span>
    </span>
  );
}
