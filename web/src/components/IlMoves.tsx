import type { ReactNode } from 'react';

import { fmt } from '../lib/format';
import { IL_MIN_GAMES, type IlMoves as Moves } from '../lib/il-moves';
import { SHOWS } from '../lib/visibility';
import { Unvalidated } from './ui';

const button = 'rounded border border-line px-2 py-0.5 text-xs hover:bg-bg';

/**
 * The roster's IL moves: who goes on the IL, each with who takes their minutes and the pickup for
 * the spot it opens (#820), and who comes back off it.
 */
export function IlMoves({
  moves,
  link,
  missed,
  back,
  minutes,
  onToggle,
}: {
  moves: Moves;
  link: (id: string) => ReactNode;
  /** Games the board expects the player to miss. */
  missed: (id: string) => number;
  /** When the player is expected back, if the report says. */
  back: (id: string) => string | null | undefined;
  /** Who takes the player's minutes, with the pickup paired with the IL move; null when unknown. */
  minutes: (id: string) => ReactNode;
  onToggle: (id: string) => void;
}) {
  if (!moves.toIl.length && !moves.back.length) return null;
  const lines = new Map(moves.toIl.map((id) => [id, minutes(id)]));
  const anyMinutes = [...lines.values()].some((x) => x !== null);
  return (
    <div className="mt-1 grid gap-1 text-sm">
      {moves.toIl.length > 0 && (
        <div data-testid="il-candidates">
          <span className="text-muted">
            {SHOWS.injuryEstimate ? `To the IL (expected to miss ${IL_MIN_GAMES}+ games): ` : 'To the IL (listed out on the injury report): '}
          </span>
          {anyMinutes && <Unvalidated issue={763} what="Who takes an out player's minutes" />}
          <ul className="mt-1 grid gap-1">
            {moves.toIl.map((id) => (
              <li key={id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5" data-player={id}>
                {link(id)}
                <span className="text-xs text-muted">
                  {SHOWS.injuryEstimate ? `${fmt(missed(id), 1)} games${back(id) ? `, back ${back(id)}` : ''}` : back(id) ? `back ${back(id)}, per the report` : ''}
                </span>
                <button type="button" className={button} onClick={() => onToggle(id)} data-testid="il-move">
                  Move to IL
                </button>
                {lines.get(id)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {moves.back.length > 0 && (
        <p data-testid="il-back">
          <span className="text-muted">Back from the IL (no longer listed): </span>
          {moves.back.map((id) => (
            <span key={id} className="mr-3 inline-flex items-center gap-1">
              {link(id)}
              <button type="button" className={button} onClick={() => onToggle(id)} data-testid="il-move">
                Activate
              </button>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
