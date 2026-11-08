/**
 * The Trade page's players: what each side of a trade adds up to, the manager's team before and
 * after, and more of each player than his value (#694): his form, what he is good and bad at, and
 * when that makes the timing good or bad.
 */
import { num } from './board-model';
import { fmt } from './format';
import type { Worth } from './league-model';
import type { BoardColumn, ExportedRow } from '../generated/columns';

interface PlayerRowFields {
  player_id: string;
  full_name: string | null;
  position: string | null;
  team_abbreviation: string | null;
  games_share: number | null;
  ros_factor: number | null;
  availability_multiplier?: number | null;
  season_complete: boolean;
  games_remaining: number | null;
  injury_status: string | null;
  injury_group: string | null;
  injury_type?: string | null;
  games_this_week?: number | null;
  expected_return?: string | null;
  injury_note?: string | null;
  injury_news?: string | null;
  injury_since?: string | null;
  injury_source?: string | null;
  official_game_date?: string | null;
  official_report_at?: string | null;
  [key: string]: unknown;
}
// Only columns the export ships (export/layout.py): a field it does not ship fails the type check (#479).
export type TradePlayer = ExportedRow<BoardColumn, PlayerRowFields>;

/** The worth of a player the board does not value: nothing on any count. */
export const NO_WORTH: Worth = { perGame: 0, season: 0, rest: 0, week: 0, cats: {}, fpts: null };

/** One side of a trade, added up. */
export interface TradeSide {
  players: TradePlayer[];
  perGame: number;
  season: number;
  rest: number;
  week: number;
  /** The figure the side is judged on: the rest of the season, or this fantasy week. */
  value: number;
  /** Games left this fantasy week. */
  games: number;
  /** Each kept category, with its sign. */
  cats: Record<string, number>;
  /** The players worth less than a free agent, who count as zero. */
  belowReplacement: TradePlayer[];
}

/** What the players on one side of a trade add up to, judged on this week (`week`) or the rest of the season. */
export function tradeSide(ids: string[], byId: Map<string, TradePlayer>, worth: Map<string, Worth>, cats: string[], week: boolean): TradeSide {
  const pick = (w: Worth) => (week ? w.week : w.rest);
  // A player below replacement is worth zero in a trade, not less: either side could drop him for
  // a free agent. Counting his negative value would make giving him away look like a gain, and a
  // package padded with him look closer to even than it is.
  const floor = (v: number) => Math.max(0, v);
  const players = ids.map((id) => byId.get(id)).filter((p): p is TradePlayer => !!p);
  const sum = (f: (w: Worth) => number) => players.reduce((s, p) => s + floor(f(worth.get(p.player_id) ?? NO_WORTH)), 0);
  const catSum = (f: (w: Worth) => number) => players.reduce((s, p) => s + f(worth.get(p.player_id) ?? NO_WORTH), 0);
  // the categories are what the player actually produces, so they keep their sign
  const catTotals = Object.fromEntries(cats.map((c) => [c, catSum((w) => w.cats[c] ?? 0)]));
  const belowReplacement = players.filter((p) => pick(worth.get(p.player_id) ?? NO_WORTH) < 0);
  const games = players.reduce((s, p) => s + (p.games_this_week ?? 0), 0);
  return {
    players,
    perGame: sum((w) => w.perGame),
    season: sum((w) => w.season),
    rest: sum((w) => w.rest),
    week: sum((w) => w.week),
    value: sum(pick),
    games,
    cats: catTotals,
    belowReplacement,
  };
}

/** The manager's team before and after a trade, category by category, with its rank among the league's teams. */
export interface TeamChange {
  /** Teams with a roster, ranked. */
  ranked: number;
  rows: { c: string; before: number; after: number; rankBefore: number; rankAfter: number }[];
}

/** The manager's team totals and ranks before and after the trade. Players on the injured list are owned but not playing: they stay out of a team's totals. */
export function teamChange({
  rosters,
  mine,
  partner,
  il,
  give,
  get,
  cats,
  worth,
}: {
  rosters: string[][];
  mine: number;
  partner: number;
  il: string[];
  give: string[];
  get: string[];
  cats: string[];
  worth: Map<string, Worth>;
}): TeamChange {
  const teamTotals = (roster: string[]) =>
    Object.fromEntries(cats.map((c) => [c, roster.filter((id) => !il.includes(id)).reduce((s, id) => s + (worth.get(id)?.cats[c] ?? 0), 0)]));
  const after = (t: number) => {
    const roster = rosters[t] ?? [];
    if (t === mine) return [...roster.filter((id) => !give.includes(id)), ...get];
    if (t === partner) return [...roster.filter((id) => !get.includes(id)), ...give];
    return roster;
  };
  const before = rosters.map((r) => teamTotals(r));
  const afterTotals = rosters.map((_, t) => teamTotals(after(t)));
  const rankOf = (totals: Record<string, number>[], c: string) => {
    const order = totals
      .map((tot, t) => ({ t, v: tot[c] ?? 0, size: (rosters[t] ?? []).length }))
      .filter((x) => x.size > 0 || x.t === mine)
      .sort((a, b) => b.v - a.v);
    return order.findIndex((x) => x.t === mine) + 1;
  };
  const ranked = rosters.filter((r) => r.length > 0).length;
  return {
    ranked,
    rows: cats.map((c) => ({
      c,
      before: before[mine]?.[c] ?? 0,
      after: afterTotals[mine]?.[c] ?? 0,
      rankBefore: rankOf(before, c),
      rankAfter: rankOf(afterTotals, c),
    })),
  };
}

/** Form past this, summed over the kept categories, is a hot (or cold) run. */
export const HOT = 1.5;

/** The last ten games against the projection, summed over the kept categories; null without either. */
export function formOf(p: TradePlayer, cats: string[]): number | null {
  let sum = 0;
  let seen = false;
  for (const c of cats) {
    const recent = num(p, `recent_${c}`);
    const proj = num(p, c);
    if (recent === null || proj === null) continue;
    sum += recent - proj;
    seen = true;
  }
  return seen ? sum : null;
}

/** A player's two best kept categories and his worst, from his category values. */
export function profileOf(values: Record<string, number>, cats: string[]): { best: string[]; worst: string[] } {
  const order = cats.filter((k) => typeof values[k] === 'number').sort((a, b) => (values[b] ?? 0) - (values[a] ?? 0));
  const best = order.filter((k) => (values[k] ?? 0) > 0.5).slice(0, 2);
  const worst = order.filter((k) => (values[k] ?? 0) < -0.5).slice(-1);
  return { best, worst };
}

/** When the timing of the trade is good or bad for the manager: a hot or cold run, or an injury. Form is for categories leagues only. */
export function timingNotes(giving: TradePlayer[], getting: TradePlayer[], cats: string[], points: boolean): string[] {
  return [...giving.map((p) => ['give', p] as const), ...getting.map((p) => ['get', p] as const)].flatMap(([side, p]) => {
    const name = p.full_name ?? p.player_id;
    const notes: string[] = [];
    const form = points ? null : formOf(p, cats);
    if (form !== null && form >= HOT)
      notes.push(
        side === 'give'
          ? `${name} has run ${fmt(form, 1)} above their projection over the last ten games: you sell high.`
          : `${name} has run ${fmt(form, 1)} above their projection over the last ten games: you buy at the top, and the projection expects them to cool off.`,
      );
    if (form !== null && form <= -HOT)
      notes.push(
        side === 'give'
          ? `${name} has run ${fmt(-form, 1)} below their projection over the last ten games: you sell low, and the projection expects them to recover.`
          : `${name} has run ${fmt(-form, 1)} below their projection over the last ten games: you buy low.`,
      );
    if (p.injury_group === 'out' || p.injury_group === 'doubtful')
      notes.push(
        `${name} is ${(p.injury_status ?? 'out').toLowerCase()}${p.expected_return ? ` (expected back ${p.expected_return})` : ''}: the value counts only the games they are expected to play.`,
      );
    return notes;
  });
}
