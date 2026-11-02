import { describe, expect, it } from 'vitest';

import { freshness, openIncidents, runbookHref } from './health-status';

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
