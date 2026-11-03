/** Shared player helpers for the board and streamers. */

export type PositionLetter = 'G' | 'F' | 'C';
export const POSITION_LETTERS: readonly PositionLetter[] = ['G', 'F', 'C'];

/** "G-F" is eligible at G and at F; a missing position is eligible nowhere. */
export function eligibleAt(position: string | null | undefined, letters: ReadonlySet<PositionLetter>): boolean {
  if (letters.size === 0) return true;
  if (!position) return false;
  return position
    .toUpperCase()
    .split(/[-/ ]/)
    .some((p) => letters.has(p as PositionLetter));
}

/** The position letters a roster covers: a letter is covered when someone on it is eligible there. */
function coveredLetters(ids: readonly string[], position: (id: string) => string | null | undefined): Set<PositionLetter> {
  return new Set(POSITION_LETTERS.filter((l) => ids.some((id) => eligibleAt(position(id), new Set([l])))));
}

/**
 * True when a roster after a move still has someone at every position letter it had someone at
 * before (#489): a swap must not leave a guard, forward or center slot that nobody can fill. A
 * letter the roster never covered is not required.
 */
export function keepsPositions(
  before: readonly string[],
  after: readonly string[],
  position: (id: string) => string | null | undefined,
): boolean {
  const had = coveredLetters(before, position);
  const has = coveredLetters(after, position);
  return [...had].every((l) => has.has(l));
}

export function toggle<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export type SortDir = 'asc' | 'desc';

/** Sort rows by a numeric or text accessor, nulls last whatever the direction. */
export function sortRows<T>(rows: T[], get: (row: T) => number | string | null | undefined, dir: SortDir): T[] {
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    const xMissing = x === null || x === undefined || (typeof x === 'number' && Number.isNaN(x));
    const yMissing = y === null || y === undefined || (typeof y === 'number' && Number.isNaN(y));
    if (xMissing && yMissing) return 0;
    if (xMissing) return 1;
    if (yMissing) return -1;
    const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return dir === 'asc' ? cmp : -cmp;
  });
}
