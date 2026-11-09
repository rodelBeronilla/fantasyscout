/**
 * The answers Data Health opens with (#418): is the live build inside the publish SLA, how did the
 * last build end, and which data incidents are open. The SLA is the watchdog's (ops/watchdog.py):
 * 30 hours while a league is playing (or when the season cannot be read), 72 out of season.
 */
const IN_SEASON_HOURS = 30;
const OFF_SEASON_HOURS = 72;

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

/**
 * One Build lakehouse run, as the status line words it: from the build log a published build carries
 * (ops.build_log), or from GitHub's list of the workflow's runs.
 */
export interface BuildAttempt {
  run_id: string;
  run_url: string;
  outcome: string;
  finished_at: string | null;
  /** From the build log only: GitHub's run list does not say. */
  light?: boolean;
  gate_reason?: string | null;
}

/** Conclusions that are not a build's result: a run skipped by its trigger, or cancelled by a newer one. */
const NOT_A_RESULT = new Set(['skipped', 'cancelled', 'neutral', 'action_required', 'stale']);

/**
 * The newest finished Build lakehouse run on main, from GitHub's public API, failures included (#941).
 * A failed build publishes nothing, so the published build's own log cannot report it. Null when
 * GitHub cannot be read (offline, rate limited) or names no run.
 */
export async function latestBuildRun(fetcher: typeof fetch = fetch): Promise<BuildAttempt | null> {
  try {
    const r = await fetcher(
      'https://api.github.com/repos/rodelBeronilla/fantasyscout/actions/workflows/build.yml/runs?branch=main&status=completed&per_page=10',
      { headers: { accept: 'application/vnd.github+json' } },
    );
    if (!r.ok) return null;
    const body = (await r.json()) as { workflow_runs?: unknown };
    const runs = Array.isArray(body?.workflow_runs) ? (body.workflow_runs as { id?: unknown; html_url?: unknown; conclusion?: unknown; updated_at?: unknown }[]) : [];
    const run = runs.find((x) => typeof x?.conclusion === 'string' && !NOT_A_RESULT.has(x.conclusion));
    if (!run || typeof run.id !== 'number' || typeof run.html_url !== 'string') return null;
    return {
      run_id: String(run.id),
      run_url: run.html_url,
      outcome: run.conclusion as string,
      finished_at: typeof run.updated_at === 'string' ? run.updated_at : null,
    };
  } catch {
    return null;
  }
}

const finished = (b: BuildAttempt) => (b.finished_at ? new Date(b.finished_at).getTime() : 0);

/**
 * The latest build attempt (#941): GitHub's newest finished run, with the build log's detail (light or
 * full, the gate's reason) when the log has the same run; the log's newest run when GitHub cannot be
 * read or knows nothing newer. Null when neither has a run.
 */
export function latestAttempt(github: BuildAttempt | null, logged: BuildAttempt | undefined): BuildAttempt | null {
  if (!github) return logged ?? null;
  if (!logged) return github;
  if (logged.run_id === github.run_id) return { ...github, light: logged.light, gate_reason: logged.gate_reason ?? null };
  return finished(logged) > finished(github) ? logged : github;
}

/** "passed", "failed", or GitHub's other word for how a run ended ("timed out"). */
export function outcomeWord(outcome: string): string {
  if (outcome === 'success') return 'passed';
  if (outcome === 'failure') return 'failed';
  return outcome.replace(/_/g, ' ');
}

export interface FailureSummary {
  /** Failed or missing requests from runs started in the window. */
  recent: number;
  /** Those of them the source did not have (a 404 at the source, not our failure). */
  missing: number;
  /** The rest of the list, from runs before the window. */
  older: number;
  /** "espn NBA" and its count in the window, the most first. */
  bySource: [string, number][];
}

/** The failed fetches of the last `days` days by source, for the line the table folds under (#941). */
export function summarizeFailures(
  rows: { source: string; league: string; started_at: string; kind: string }[],
  now: Date = new Date(),
  days = 7,
): FailureSummary {
  const since = now.getTime() - days * 86_400_000;
  const recent = rows.filter((r) => new Date(r.started_at).getTime() >= since);
  const counts = new Map<string, number>();
  for (const r of recent) {
    const key = `${r.source} ${r.league.toUpperCase()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return {
    recent: recent.length,
    missing: recent.filter((r) => r.kind === 'missing').length,
    older: rows.length - recent.length,
    bySource: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  };
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
