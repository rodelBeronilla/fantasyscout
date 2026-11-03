/** What a transaction says, as far as a rotation goes (gold fct_transaction). */
export interface RotationMove {
  player_id: string | null;
  move_type: string;
  description: string;
}

/**
 * Whether a move can change a rotation (#722): a trade, a standard signing, or a player who was
 * playing real minutes waived or suspended. Two-way and ten-day deals, extensions, re-signings and G
 * League shuffles stay on the player pages.
 */
export function movesRotation(m: RotationMove, minutes: (id: string) => number | null): boolean {
  if (m.move_type === 'trade') return true;
  // an extension or a re-signing keeps a player where they were: no minutes move
  if (m.move_type === 'signing') return !/two-way|10-day|ten-day|exhibit|extension|re-signed/i.test(m.description);
  if (m.move_type === 'waive' || m.move_type === 'suspension') return (m.player_id ? (minutes(m.player_id) ?? 0) : 0) >= 15;
  return false;
}
