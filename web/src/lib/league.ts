/**
 * The league toggle in the header: WNBA by default, remembered per browser, and overridable
 * per link with `?league=nba` so a page can be shared for either league.
 */
import type { League } from './data';

const KEY = 'fantasyscout.league';

export function isLeague(value: unknown): value is League {
  return value === 'wnba' || value === 'nba';
}

export function currentLeague(): League {
  if (typeof window === 'undefined') return 'wnba';
  const fromUrl = new URL(window.location.href).searchParams.get('league');
  if (isLeague(fromUrl)) return fromUrl;
  try {
    const stored = window.localStorage.getItem(KEY);
    if (isLeague(stored)) return stored;
  } catch {
    // storage may be unavailable; the default stands
  }
  return 'wnba';
}

export function rememberLeague(league: League): void {
  try {
    window.localStorage.setItem(KEY, league);
  } catch {
    // ignore
  }
}

/** The same page for the other league, keeping every other query parameter. */
export function leagueHref(league: League): string {
  const url = new URL(window.location.href);
  url.searchParams.set('league', league);
  return url.pathname + url.search + url.hash;
}

export const LEAGUE_LABEL: Record<League, string> = { wnba: 'WNBA', nba: 'NBA' };
