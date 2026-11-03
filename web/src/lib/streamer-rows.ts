/**
 * Streamers rows as the page reads them. A data build made before #482 names the player's board
 * rank `board_rank`; the column is `rank_total` now, as on the board. The site reads whichever
 * build is current (a rollback can serve an older one), so an old row is read under the new name.
 */
export function withRankTotal<T extends { rank_total: number | null }>(rows: T[]): T[] {
  return rows.map((r) => {
    if (r.rank_total !== undefined) return r;
    const old = (r as { board_rank?: number | null }).board_rank;
    return { ...r, rank_total: old ?? null };
  });
}
