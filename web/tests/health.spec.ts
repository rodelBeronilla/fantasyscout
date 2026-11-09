import { expect, test } from './fixtures';

// Data Health (#941): the status line reports the latest build attempt, a failure included, which
// the published build's own log cannot (a failed build publishes nothing); and the failed fetches
// fold under a one-line summary.

const RUNS = '**/actions/workflows/build.yml/runs?**';
const ISSUES = '**/issues?labels=data-incident**';

test('the status reports the latest build attempt from GitHub, a failure after the live build included', async ({ page }) => {
  await page.route(ISSUES, (route) =>
    route.fulfill({ json: [{ number: 922, title: 'Build failure: publish gate', html_url: 'https://github.com/x/922', created_at: '2026-11-09T02:04:29Z' }] }),
  );
  await page.route(RUNS, (route) =>
    route.fulfill({
      json: {
        workflow_runs: [
          { id: 9, conclusion: 'skipped', updated_at: '2026-11-09T04:00:00Z', html_url: 'https://github.com/x/actions/runs/9' },
          { id: 8, conclusion: 'failure', updated_at: '2026-11-09T03:08:51Z', html_url: 'https://github.com/x/actions/runs/8' },
        ],
      },
    }),
  );
  await page.goto('/health/');
  const status = page.getByTestId('health-status');
  const line = status.getByTestId('status-last-build');
  await expect(line).toContainText('Last build failed: the run that finished 2026-11-09 03:08 UTC.');
  await expect(line).toContainText('The site still serves the build published');
  await expect(line.getByRole('link', { name: 'The run' })).toHaveAttribute('href', 'https://github.com/x/actions/runs/8');
  // the same story as the incidents beside it
  await expect(status.getByTestId('status-incidents')).toContainText('#922 Build failure: publish gate');
  await expect(status).toHaveClass(/border-bad/);
});

test("the status keeps the build log's detail when GitHub names the same run, and says when GitHub could not be read", async ({ page }) => {
  await page.route('**/health.json', async (route) => {
    const body = (await (await route.fetch()).json()) as Record<string, unknown>;
    body['builds'] = [{ run_id: '7', run_url: 'https://github.com/x/actions/runs/7', outcome: 'success', light: true, finished_at: '2026-11-02T03:05:00Z', gate_reason: 'passed' }];
    await route.fulfill({ json: body });
  });
  await page.route(RUNS, (route) =>
    route.fulfill({ json: { workflow_runs: [{ id: 7, conclusion: 'success', updated_at: '2026-11-02T03:05:00Z', html_url: 'https://github.com/x/actions/runs/7' }] } }),
  );
  await page.goto('/health/');
  const line = page.getByTestId('status-last-build');
  await expect(line).toContainText('Last build passed: a light build that finished 2026-11-02 03:05 UTC; passed.');
  await expect(line).not.toContainText('still serves');

  await page.route(RUNS, (route) => route.fulfill({ status: 403, body: 'rate limited' }));
  await page.reload();
  await expect(line).toContainText('Last build passed: a light build');
  await expect(line).toContainText("(from this build's log: GitHub's run list could not be read)");
});

test('the failed fetches fold under a count of the last 7 days by source, the table one tap away', async ({ page }) => {
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  await page.route('**/health.json', async (route) => {
    const file = (await (await route.fetch()).json()) as Record<string, unknown>;
    const row = (source: string, league: string, days: number, kind: string) => ({
      run_id: `r${days}`,
      source,
      league,
      season: '2026-27',
      started_at: daysAgo(days),
      kind,
      endpoint: 'summary',
      request_key: `k${days}${source}`,
      reason: 'HTTP 404',
    });
    const failures = [
      row('espn', 'nba', 1, 'missing'),
      row('espn', 'nba', 2, 'failed'),
      row('stats', 'wnba', 3, 'failed'),
      ...Array.from({ length: 40 }, (_, i) => row('league', 'nba', 10 + i, 'missing')),
    ];
    await route.fulfill({ json: { ...file, fetch_failures: failures } });
  });
  await page.goto('/health/');
  await expect(page.getByTestId('fetch-failures-summary')).toHaveText(
    "3 failed fetches in the last 7 days, by source: espn NBA 2 · stats WNBA 1 (1 missing at the source, the source's gap); 40 older in the list.",
  );
  const table = page.getByTestId('fetch-failures');
  await expect(table).toBeHidden();
  await page.getByTestId('fetch-failures-details').locator('summary').click();
  await expect(table).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(43);
});
