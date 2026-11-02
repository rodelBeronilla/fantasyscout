/**
 * The answers Data Health opens with (#418): is the live build inside the publish SLA, how did the
 * last build end, and which data incidents are open. The SLA is the watchdog's (ops/watchdog.py):
 * 30 hours while a league is playing (or when the season cannot be read), 72 out of season.
 */
export const IN_SEASON_HOURS = 30;
export const OFF_SEASON_HOURS = 72;

export interface Freshness {
  hours: number;
  limit: number;
  season: string;
  late: boolean;
}

export function freshness(createdAt: string, feeds: { league: string; in_season?: boolean }[] | undefined, now: Date = new Date()): Freshness {
  const hours = (now.getTime() - new Date(createdAt).getTime()) / 3_600_000;
  const playing = [...new Set((feeds ?? []).filter((f) => f.in_season === true).map((f) => f.league.toUpperCase()))].sort();
  const known = (feeds ?? []).length > 0;
  const limit = playing.length || !known ? IN_SEASON_HOURS : OFF_SEASON_HOURS;
  const season = playing.length ? `in season (${playing.join(', ')})` : known ? 'off season' : 'season unknown';
  return { hours, limit, season, late: hours > limit };
}

/** The runbook on GitHub, at a section's anchor. */
export function runbookHref(section: string): string {
  const anchor = section
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/ /g, '-');
  return `https://github.com/rodelBeronilla/fantasyscout/blob/main/docs/runbook.md#${anchor}`;
}

export interface Incident {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
}

/** The open data-incident issues, from GitHub's public API; null when it cannot be read (offline, rate limited). */
export async function openIncidents(fetcher: typeof fetch = fetch): Promise<Incident[] | null> {
  try {
    const r = await fetcher('https://api.github.com/repos/rodelBeronilla/fantasyscout/issues?labels=data-incident&state=open&per_page=20', {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!r.ok) return null;
    const body = (await r.json()) as (Incident & { pull_request?: unknown })[];
    return body.filter((i) => !i.pull_request).map(({ number, title, html_url, created_at }) => ({ number, title, html_url, created_at }));
  } catch {
    return null;
  }
}
