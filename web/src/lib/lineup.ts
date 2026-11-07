/**
 * The weekly lineup planner (#735). A head-to-head week is won on the games a team starts, not
 * the games its players play: on a busy night a full lineup benches someone, and on a quiet one
 * slots sit empty. Each day's lineup is the most valuable set of players the slots can hold.
 *
 * Sets of players that fit the slots form a transversal matroid, so adding players best first,
 * each through an augmenting path when the slots look full, finds the maximum-value lineup: a
 * G-F already in G moves to F to make room for a better pure guard rather than bench them.
 */
import { eligibleAt, type PositionLetter } from './players';

export type Slot = PositionLetter | 'UTIL';

/** How many starting slots of each kind a lineup has. */
export interface Slots {
  G: number;
  F: number;
  C: number;
  UTIL: number;
}

export const SLOT_KEYS: readonly Slot[] = ['G', 'F', 'C', 'UTIL'];

export const SLOT_LABEL: Record<Slot, string> = { G: 'G', F: 'F', C: 'C', UTIL: 'Util' };

/** Whole counts from 0 to 6 per kind; a missing or bad value takes the fallback's. */
export function normalizeSlots(raw: Partial<Slots> | undefined, fallback: Slots): Slots {
  const one = (k: Slot) => {
    const v = raw?.[k];
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(6, Math.max(0, Math.round(v))) : fallback[k]; // def: a lineup's input bound
  };
  return { G: one('G'), F: one('F'), C: one('C'), UTIL: one('UTIL') };
}

/** The lineup's slots one by one, the narrow ones first. */
export function slotList(slots: Slots): Slot[] {
  return SLOT_KEYS.flatMap((k) => Array.from({ length: slots[k] }, () => k));
}

const fitsSlot = (slot: Slot, position: string | null | undefined): boolean => slot === 'UTIL' || eligibleAt(position, new Set([slot]));

export interface LineupPlayer {
  id: string;
  position: string | null | undefined;
  /** What a game of theirs is worth: the order players are started in. */
  value: number;
}

export interface DayLineup {
  /** Each starter's slot. */
  started: Map<string, Slot>;
  /** Players with a game who have no slot left, best first. */
  benched: string[];
  /** The slots nobody fills. */
  open: Slot[];
}

/** The most valuable lineup the slots can hold from the players with a game. */
export function bestLineup(players: LineupPlayer[], slots: Slot[]): DayLineup {
  const holder: (string | null)[] = slots.map(() => null);
  const byId = new Map(players.map((p) => [p.id, p]));
  // Kuhn's augmenting path: a slot the player fits, empty or freed by moving its holder elsewhere
  const place = (id: string, seen: boolean[]): boolean => {
    const p = byId.get(id)!;
    for (let s = 0; s < slots.length; s += 1) {
      if (seen[s] || !fitsSlot(slots[s]!, p.position)) continue;
      seen[s] = true;
      const current = holder[s];
      if (current === null || current === undefined || place(current, seen)) {
        holder[s] = id;
        return true;
      }
    }
    return false;
  };
  const benched: string[] = [];
  for (const p of [...players].sort((a, b) => b.value - a.value)) {
    if (!place(p.id, slots.map(() => false))) benched.push(p.id);
  }
  const started = new Map<string, Slot>();
  holder.forEach((id, s) => id && started.set(id, slots[s]!));
  return { started, benched, open: slots.filter((_, s) => holder[s] === null) };
}

interface DayPlan extends DayLineup {
  date: string;
}

export interface WeekPlan {
  days: DayPlan[];
  /** Games the lineup starts over the days. */
  started: number;
  /** Games played by someone on the bench because the lineup was full. */
  lost: number;
  /** Slot-days nobody fills: the room to stream. */
  openSlots: number;
  /** Games the roster plays, started or not. */
  games: number;
}

/** The lineup day by day over the days given, and the week's totals. */
export function weekPlan(players: LineupPlayer[], dates: string[], plays: (id: string, date: string) => boolean, slots: Slot[]): WeekPlan {
  const days = dates.map((date) => ({ date, ...bestLineup(players.filter((p) => plays(p.id, date)), slots) }));
  const started = days.reduce((s, d) => s + d.started.size, 0);
  const lost = days.reduce((s, d) => s + d.benched.length, 0);
  return { days, started, lost, openSlots: days.reduce((s, d) => s + d.open.length, 0), games: started + lost };
}

/** The fantasy week's days from `today` to its Sunday (Monday-to-Sunday weeks), as ISO dates. */
export function daysLeftInWeek(today: string): string[] {
  const d = new Date(`${today}T12:00:00Z`);
  const left = (7 - d.getUTCDay()) % 7; // def: a week; Sunday is 0, with no days after it
  return Array.from({ length: left + 1 }, (_, i) => new Date(d.getTime() + i * 86_400_000).toISOString().slice(0, 10)); // def: a day in ms
}
