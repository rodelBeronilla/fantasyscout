/**
 * The Pickups page's address (#818): the window, the open days and the need categories travel in
 * the URL, so My Team's matchup and Today card open Pickups with the chips already set.
 * `?window=week&open=2026-11-12,2026-11-13&need=z_steals,z_blocks`.
 */
import type { League } from './data';
import { CATEGORIES } from './format';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The need categories a `need` parameter names: known categories only, each once, in its order. */
export function needsFromParam(raw: string | null | undefined): string[] {
  const named = (raw ?? '').split(',').map((c) => c.trim());
  return [...new Set(named.filter((c) => CATEGORIES.includes(c)))];
}

/** The open days an `open` parameter names: ISO days only. */
export function daysFromParam(raw: string | null | undefined): string[] {
  return (raw ?? '').split(',').filter((d) => ISO_DAY.test(d));
}

/** The Pickups path for a league, with the window, open days and needs when given (before the site prefix). */
export function pickupsPath(league: League, opts: { week?: boolean; open?: readonly string[]; need?: readonly string[] } = {}): string {
  const q = new URLSearchParams({ league });
  if (opts.week) q.set('window', 'week');
  if (opts.open?.length) q.set('open', opts.open.join(','));
  if (opts.need?.length) q.set('need', opts.need.join(','));
  // commas read better than %2C in a link a manager may share
  return `/streamers/?${q.toString().replaceAll('%2C', ',')}`;
}

/** The current address with the need categories set (or dropped when none), for the page to replace in place. */
export function withNeeds(url: string, needs: readonly string[]): string {
  const u = new URL(url);
  if (needs.length) u.searchParams.set('need', needs.join(','));
  else u.searchParams.delete('need');
  return u.toString().replaceAll('%2C', ',');
}
