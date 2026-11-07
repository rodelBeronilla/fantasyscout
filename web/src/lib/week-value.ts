/**
 * The fantasy-week unit (#466). The board and the Trade page value a player for the rest of the
 * season: projected value above replacement over the games the player is expected to play. A
 * head-to-head manager also needs this week: notebook 02 (ADR 0011) found recent production over
 * the games left in the week the best weekly predictor the lakehouse has, so the week unit is each
 * category's last-ten value, on the projection's scale and above the league's replacement level
 * (measured on the projection, ADR 0019), over the games left this fantasy week (Monday to Sunday).
 */
type Row = Record<string, unknown>;

export type ValueUnit = 'rest' | 'week';

/** How each unit is named next to a value. */
export const UNIT_LABEL: Record<ValueUnit, string> = { rest: 'rest of season', week: 'this week' };

/**
 * A copy of each row with the last-ten value standing in for the projected one, category by
 * category, so the league's category values can be measured on recent form. The last ten are a
 * player's latest regular-season games this season, as few as one; a player with none keeps the
 * projection.
 */
export function recentForm(rows: Row[], categories: string[]): Row[] {
  return rows.map((r) => {
    const out: Row = { ...r };
    for (const c of categories) {
      const recent = r[`recent_${c}`];
      if (typeof recent === 'number' && !Number.isNaN(recent)) out[c] = recent;
    }
    return out;
  });
}

/**
 * Value for the week: per-game value above replacement over the games left. Only value above
 * replacement counts games, as the rest-of-season figure does: a player not worth rostering is
 * worth the same whether or not the team plays.
 */
export function weekValue(perGame: number, games: number | null | undefined): number {
  return perGame > 0 ? perGame * (games ?? 0) : perGame;
}

/** Whether any player has a game left this fantasy week; out of season the unit means nothing and is not offered. */
export function hasWeekGames(rows: Row[]): boolean {
  return rows.some((r) => {
    const g = r['games_this_week'];
    return typeof g === 'number' && g > 0;
  });
}
