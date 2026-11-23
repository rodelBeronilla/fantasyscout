/**
 * The owner's log, for last week graded (#1058): the week's chances logged with the preview's
 * calls, and the log read back to grade them. Both run only with the owner's preview on, which
 * the Worker must confirm (owner-preview.ts); anyone else's browser asks nothing.
 */
import { type WeekChances, weekChanceCalls } from './graded';
import { OWNER_LOG_DOWNLOAD } from './owner-log';
import { logBeforeShowing } from './owner-preview';

/**
 * Logs the week's chances the matchup card shows, one entry a category, in the page's batch with
 * the preview's calls: the log keeps each once by its key, so a second view adds nothing and a
 * chance that moves adds its new value. `cancel` withdraws them while not yet sent, when the card
 * comes to show other chances (its data still arriving).
 */
export function logWeekChances(c: Pick<WeekChances, 'league' | 'monday' | 'opponent' | 'week' | 'chances' | 'soFar'>, league: string): () => void {
  return logBeforeShowing(weekChanceCalls(c), league).cancel;
}

/** The owner's whole log, JSON Lines, read through the Worker; null when it could not be read. */
export async function readOwnerLog(): Promise<string | null> {
  try {
    const r = await fetch(OWNER_LOG_DOWNLOAD, { credentials: 'same-origin' });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}
