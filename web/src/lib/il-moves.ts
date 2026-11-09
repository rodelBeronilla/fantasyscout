/**
 * Injured-list moves for the manager's team: who should go on the IL (listed out for long enough
 * that the roster spot is worth more than the player) and who should come off it (no longer
 * listed). The threshold is in games the board expects the player to miss, from the calibrated
 * availability (ADR 0010), so it follows the league's own listings rather than the status word.
 */
import { PARAMS } from '../generated/parameters';

export interface IlCandidate {
  player_id: string;
  injury_group: string | null;
  injury_status: string | null;
  expected_games_missed: number | null;
}

export interface IlMoves {
  /** Active players the board expects to miss at least `minGames` more games. */
  toIl: string[];
  /** Players on the IL who are no longer listed as out or doubtful. */
  back: string[];
}

export const IL_MIN_GAMES: number = PARAMS['il.min_games'];

const LISTED_OUT = new Set(['out', 'doubtful']);

/**
 * The IL moves from the injury report alone, no estimate (#927): a player the report lists out goes
 * on the IL, since the spot he frees costs nothing while he cannot play, and one on the IL comes
 * off once the report no longer lists him out or doubtful. My Team uses this until the games-missed
 * estimate and its threshold are judged (#763).
 */
export function ilMovesByListing(rows: IlCandidate[], mine: string[], il: string[]): IlMoves {
  const byId = new Map(rows.map((r) => [r.player_id, r]));
  const onIl = new Set(il);
  const toIl = mine.filter((id) => !onIl.has(id) && byId.get(id)?.injury_group === 'out');
  const back = mine.filter((id) => {
    const row = byId.get(id);
    return onIl.has(id) && !!row && !LISTED_OUT.has(row.injury_group ?? '');
  });
  return { toIl, back };
}

export function ilMoves(rows: IlCandidate[], mine: string[], il: string[], minGames = IL_MIN_GAMES): IlMoves {
  const byId = new Map(rows.map((r) => [r.player_id, r]));
  const onIl = new Set(il);
  const toIl = mine
    .filter((id) => !onIl.has(id))
    .filter((id) => (byId.get(id)?.expected_games_missed ?? 0) >= minGames)
    .sort((a, b) => (byId.get(b)?.expected_games_missed ?? 0) - (byId.get(a)?.expected_games_missed ?? 0));
  const back = mine
    .filter((id) => onIl.has(id))
    .filter((id) => {
      const row = byId.get(id);
      return !!row && !LISTED_OUT.has(row.injury_group ?? '') && (row.expected_games_missed ?? 0) < minGames;
    });
  return { toIl, back };
}
