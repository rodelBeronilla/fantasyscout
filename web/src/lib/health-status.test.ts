import { describe, expect, it } from 'vitest';

import { freshness, latestAttempt, latestBuildRun, openIncidents, outcomeWord, runbookHref, summarizeFailures } from './health-status';

const now = new Date('2026-11-02T12:00:00Z');

describe('the Data Health status', () => {
  it('judges the build against the watchdog\'s limits', () => {
    const playing = [{ league: 'nba', in_season: true }, { league: 'wnba', in_season: false }];
    expect(freshness('2026-11-02T02:00:00Z', playing, now)).toMatchObject({ hours: 10, limit: 30, season: 'in season (NBA)', late: false });
    expect(freshness('2026-10-31T20:00:00Z', playing, now).late).toBe(true); // 40 h in season
    const quiet = [{ league: 'nba', in_season: false }];
    expect(freshness('2026-10-31T20:00:00Z', quiet, now)).toMatchObject({ limit: 72, season: 'off season', late: false });
    // no feeds: the season is unknown and the in-season limit applies, as in the watchdog
    expect(freshness('2026-10-31T20:00:00Z', undefined, now)).toMatchObject({ limit: 30, season: 'season unknown', late: true });
  });

  it('links a runbook section by its GitHub anchor', () => {
    expect(runbookHref('Publish SLA and the watchdog')).toMatch(/runbook\.md#publish-sla-and-the-watchdog$/);
    expect(runbookHref("The owner's sign-in (private tables)")).toMatch(/#the-owners-sign-in-private-tables$/);
  });

  it('lists the open incidents and says nothing when GitHub does not answer', async () => {
    const ok = (async () =>
      new Response(
        JSON.stringify([
          { number: 9, title: 'Build failure: dbt on Databricks', html_url: 'https://github.com/x/9', created_at: '2026-11-02T03:00:00Z' },
          { number: 10, title: 'a pull request', html_url: 'u', created_at: 'c', pull_request: {} },
        ]),
        { status: 200 },
      )) as unknown as typeof fetch;
    expect(await openIncidents(ok)).toEqual([
      { number: 9, title: 'Build failure: dbt on Databricks', html_url: 'https://github.com/x/9', created_at: '2026-11-02T03:00:00Z' },
    ]);
    const limited = (async () => new Response('rate limited', { status: 403 })) as unknown as typeof fetch;
    expect(await openIncidents(limited)).toBeNull();
  });
});

const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const run = (id: number, conclusion: string, updated_at: string) => ({ id, conclusion, updated_at, html_url: `https://github.com/x/actions/runs/${id}` });

describe('the latest build attempt (#941)', () => {
  it("reads GitHub's newest finished run, failures included, past the skipped and cancelled ones", async () => {
    const runs = answer({ workflow_runs: [run(5, 'skipped', '2026-11-09T04:00:00Z'), run(4, 'cancelled', '2026-11-09T03:30:00Z'), run(3, 'failure', '2026-11-09T03:08:51Z')] });
    expect(await latestBuildRun(runs)).toEqual({ run_id: '3', run_url: 'https://github.com/x/actions/runs/3', outcome: 'failure', finished_at: '2026-11-09T03:08:51Z' });
  });

  it('has none when GitHub does not answer, or answers something else', async () => {
    expect(await latestBuildRun(answer('rate limited', 403))).toBeNull();
    expect(await latestBuildRun(answer([]))).toBeNull(); // a list, as the incidents endpoint gives
    expect(await latestBuildRun(answer({ workflow_runs: [run(1, 'skipped', '2026-11-09T00:00:00Z')] }))).toBeNull();
    const offline = (async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    expect(await latestBuildRun(offline)).toBeNull();
  });

  const logged = { run_id: '2', run_url: 'https://github.com/x/actions/runs/2', outcome: 'success', finished_at: '2026-11-08T23:55:00Z', light: true, gate_reason: 'passed' };
  const failed = { run_id: '3', run_url: 'https://github.com/x/actions/runs/3', outcome: 'failure', finished_at: '2026-11-09T03:08:51Z' };

  it("is GitHub's run when it is newer than the published build's log, so a failure shows", () => {
    expect(latestAttempt(failed, logged)).toEqual(failed);
  });

  it("takes the log's detail when both name the same run, and the log's run when GitHub is older or unread", () => {
    expect(latestAttempt({ ...failed, run_id: '2', outcome: 'success' }, logged)).toMatchObject({ run_id: '2', light: true, gate_reason: 'passed' });
    expect(latestAttempt({ ...failed, run_id: '1', finished_at: '2026-11-08T01:00:00Z' }, logged)).toEqual(logged);
    expect(latestAttempt(null, logged)).toEqual(logged);
    expect(latestAttempt(failed, undefined)).toEqual(failed);
    expect(latestAttempt(null, undefined)).toBeNull();
  });

  it('words how a run ended', () => {
    expect(outcomeWord('success')).toBe('passed');
    expect(outcomeWord('failure')).toBe('failed');
    expect(outcomeWord('timed_out')).toBe('timed out');
  });
});

describe('the failed fetches line (#941)', () => {
  const at = (source: string, league: string, started_at: string, kind = 'failed') => ({ source, league, started_at, kind });

  it('counts the last 7 days by source, the most first, and says how many are older', () => {
    const rows = [
      at('espn', 'nba', '2026-11-02T09:00:00Z', 'missing'),
      at('stats', 'wnba', '2026-11-01T09:00:00Z'),
      at('espn', 'nba', '2026-10-30T09:00:00Z'),
      at('espn', 'nba', '2026-10-27T09:00:00Z'), // 6.1 days back
      at('league', 'nba', '2026-10-20T09:00:00Z', 'missing'), // older than the week
    ];
    expect(summarizeFailures(rows, now)).toEqual({
      recent: 4,
      missing: 1,
      older: 1,
      bySource: [
        ['espn NBA', 3],
        ['stats WNBA', 1],
      ],
    });
  });

  it('has none in the week when every row is older', () => {
    expect(summarizeFailures([at('espn', 'nba', '2026-10-01T00:00:00Z')], now)).toEqual({ recent: 0, missing: 0, older: 1, bySource: [] });
  });
});
