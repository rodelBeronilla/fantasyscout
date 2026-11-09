/**
 * From the week's matchup to the stream that flips a category (#818): the categories close or
 * being lost, the best free agent for them on the open days (Pickups' own selection, #819), the
 * player to drop for him, and the categories the swap turns into wins. Pure, for My Team and the
 * tests.
 */
import { byCloseness, keptRows, matchup, type WeekMatchup, type WeekTotals, weekTotals } from './matchup';
import { topAdds, type AddRow } from './pickups-top';

/**
 * The kept categories close or being lost, the closest first: the need chips Pickups opens with.
 * A punted category is never a target.
 */
export function streamTargets(m: WeekMatchup): string[] {
  return byCloseness(keptRows(m).filter((r) => r.result !== 'win')).map((r) => r.cat);
}

/**
 * The categories a swap turns into wins: the manager's totals with the add's games on the open
 * days in and the drop's started games out, against the same opponent.
 */
export function flippedBy(
  m: WeekMatchup,
  cats: readonly string[],
  add: { row: Record<string, unknown>; games: number },
  drop: { row: Record<string, unknown>; games: number } | null,
): string[] {
  const all = m.cats.map((r) => r.cat);
  const plus = weekTotals([add.row], all, undefined, () => add.games);
  const minus = drop ? weekTotals([drop.row], all, undefined, () => drop.games) : null;
  const shots = { ...m.mine.shots };
  const next: Record<string, number> = {};
  for (const c of all) {
    const had = m.mine.shots?.[c];
    const gained = plus.shots?.[c];
    if (had && gained) {
      const lost = minus?.shots?.[c] ?? [0, 0];
      const made = had[0] + gained[0] - lost[0];
      const attempted = had[1] + gained[1] - lost[1];
      shots[c] = [made, attempted];
      next[c] = attempted > 0 ? made / attempted : 0;
    } else next[c] = (m.mine.cats[c] ?? 0) + (plus.cats[c] ?? 0) - (minus?.cats[c] ?? 0);
  }
  const mine: WeekTotals = { ...m.mine, cats: next, shots };
  const after = matchup(m.league, all, mine, m.theirs);
  const before = new Map(m.cats.map((r) => [r.cat, r.result]));
  return after.cats.filter((r) => cats.includes(r.cat) && r.result === 'win' && before.get(r.cat) !== 'win').map((r) => r.cat);
}

/** A board row as the stream reads it: its last-ten category values (recent_z_*) and projected line. */
export interface StreamRow {
  player_id: string;
  position: string | null;
  injury_group?: string | null;
  [key: string]: unknown;
}

export interface StreamInput<R extends StreamRow> {
  match: WeekMatchup;
  rows: R[];
  available: (id: string) => boolean;
  /** A player's team games left this week, and on the manager's open days. */
  games: (row: R) => { window: number; open: number };
  /** Days left this week with a lineup slot open. */
  openDays: number;
  /** The kept categories, for the reasons. */
  kept: readonly string[];
  /** The roster review's drops, in order, and the active roster for the position check. */
  drops: readonly string[];
  roster: readonly string[];
  position: (id: string) => string | null | undefined;
  /** The games the lineup plan starts a player for, the rest of the week. */
  starts: (id: string) => number;
}

export interface StreamMove {
  add: string;
  drop: string | null;
  /** Games the add can fill on the open days. */
  games: number;
  /** The categories the swap turns into wins, and those the add helps most. */
  flips: string[];
  helps: string[];
  /** The close and losing categories it was picked for. */
  targets: string[];
}

/** The top add for the matchup's close and losing categories, with its drop and what it flips; null with none. */
export function streamMove<R extends StreamRow>(input: StreamInput<R>): StreamMove | null {
  const targets = streamTargets(input.match);
  if (!targets.length || input.openDays === 0) return null;
  const byId = new Map(input.rows.map((r) => [r.player_id, r]));
  const z = (r: R, c: string) => {
    const v = r[`recent_${c}`];
    return typeof v === 'number' && !Number.isNaN(v) ? v : null;
  };
  // Pickups' candidates, built from the board: the fit is the last ten games in the targets
  const rows: (AddRow & { source: R })[] = input.rows
    .filter((r) => input.available(r.player_id))
    .map((r) => {
      const g = input.games(r);
      const parts = targets.map((c) => z(r, c)).filter((v): v is number => v !== null);
      return {
        ...Object.fromEntries(input.kept.map((c) => [`last_10_${c}`, z(r, c)])),
        player_id: r.player_id,
        position: r.position,
        injury_group: r.injury_group ?? null,
        games_window: g.window,
        games_picked: g.open,
        fit: parts.length ? parts.reduce((s, v) => s + v, 0) : null,
        window_value: null,
        minutes_trend: null,
        source: r,
      };
    });
  const [top] = topAdds({
    rows,
    available: () => true,
    needs: targets,
    kept: input.kept,
    openDays: input.openDays,
    drops: input.drops,
    roster: input.roster,
    position: input.position,
    limit: 1,
  });
  if (!top) return null;
  const dropRow = top.drop ? byId.get(top.drop) : undefined;
  const flips = flippedBy(
    input.match,
    targets,
    { row: top.row.source, games: top.row.games_picked },
    dropRow && top.drop ? { row: dropRow, games: input.starts(top.drop) } : null,
  );
  return { add: top.row.player_id, drop: top.drop, games: top.row.games_picked, flips, helps: top.helps, targets };
}
