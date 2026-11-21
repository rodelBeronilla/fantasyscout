/**
 * The owner's log, for last week graded (#1058): the week's chances recorded once a fantasy week
 * in this browser, and the log read back to grade them. Both run only once the Worker has said
 * this browser holds the owner's cookie (owner-log.ts); anyone else's browser asks nothing.
 */
import { useEffect, useState } from 'react';

import type { League } from './data';
import { getLatest } from './data';
import { type WeekChances, weekChancesCall } from './graded';
import { logCall, OWNER_LOG_DOWNLOAD, ownerLogOn } from './owner-log';
import { readRaw, storageKey, writeRaw } from './storage';

/** Where this browser keeps the Monday of the last week whose chances it logged, per league. */
export const chancesKey = (league: League): string => storageKey('week-chances', league);

// the weeks logged or being logged on this page view: storage may be blocked
const done = new Set<string>();

/**
 * Logs the week's chances once a week in this browser: false when this week's are logged
 * already, or the log refused them (they are tried again on the next visit).
 */
export async function logWeekChances(c: Omit<WeekChances, 'date' | 'at'>, date: string): Promise<boolean> {
  const key = chancesKey(c.league);
  const mark = `${key}:${c.monday}`;
  if (done.has(mark) || readRaw(key) === c.monday) return false;
  done.add(mark);
  const latest = await getLatest().catch(() => null);
  const ok = await logCall({ ...weekChancesCall(c), date, build: latest?.build_id ?? 'unknown' });
  // refused: tried again on the next visit, not on every render of this one
  if (ok) writeRaw(key, c.monday);
  return ok;
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

/** Whether this browser is the signed-in owner's, for a component: false, with no request, in any other browser. */
export function useOwnerLogOn(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    void ownerLogOn().then((yes) => live && setOn(yes));
    return () => {
      live = false;
    };
  }, []);
  return on;
}
