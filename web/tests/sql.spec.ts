import type { Page, Request } from '@playwright/test';

import { expect, test } from './fixtures';

// The SQL console (#940): the page loads none of the engine, the first query does; and the nav shows
// its link only in a browser the Worker has told it is the owner's.

/** The DuckDB engine's requests: its JavaScript module, its worker and its wasm. */
function engineRequests(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (r) => {
    if (/duckdb/i.test(r.url())) seen.push(r);
  });
  return seen;
}

test('the SQL console loads its engine on the first query, not with the page', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'DuckDB-WASM is exercised on Chromium');
  test.setTimeout(120_000);
  const engine = engineRequests(page);
  await page.goto('/sql/');
  const run = page.getByTestId('sql-run');
  await expect(run).toBeEnabled();
  await expect(page.getByTestId('sql-engine-note')).toContainText('The first run downloads the engine');
  await expect(page.getByTestId('sql-views')).toContainText('Listed once the first query has loaded the engine');
  await page.waitForLoadState('networkidle');
  expect(engine.map((r) => r.url())).toEqual([]);

  // hold the wasm a moment, so the loading state is there to see however fast the server is
  await page.route('**/*.wasm', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.continue();
  });
  await page.getByTestId('sql-input').fill('select count(*) as teams from dim_team');
  await run.click();
  // a clear loading state while the engine and the tables load, Run held until they have
  await expect(page.getByRole('status')).toContainText("Loading the DuckDB engine and the build's tables, then the query");
  await expect(run).toBeDisabled();
  await expect(page.getByTestId('sql-results').locator('tbody tr').first()).toHaveText(/^[1-9]\d*$/, { timeout: 90_000 });
  expect(engine.some((r) => r.url().endsWith('.wasm'))).toBe(true);
  await expect(page.getByTestId('sql-views')).toContainText('dim_team');
  await expect(page.getByTestId('sql-engine-note')).toHaveCount(0);

  // the next query reuses the engine: nothing more is downloaded
  const loaded = engine.length;
  await page.getByTestId('sql-input').fill('select max(game_date) as last_game from dim_game');
  await run.click();
  await expect(page.getByTestId('sql-results').locator('tbody tr').first()).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
  expect(engine.length).toBe(loaded);
});

test("the SQL console's nav link shows only once the Worker has said this browser is the owner's", async ({ page }) => {
  const sqlLink = () => page.getByTestId('nav-behind-the-data').getByRole('link', { name: 'SQL console (owner only)' });
  const open = () => page.getByTestId('nav-behind-the-data').locator('summary').click();
  await page.goto('/');
  await open();
  await expect(sqlLink()).toHaveCount(0);

  // the owner signs in: the console's status check remembers it, and the nav shows the link
  await page.route('**/api/owner/status', (r) => r.fulfill({ json: { configured: true, owner: true } }));
  await page.goto('/sql/');
  await expect(page.getByTestId('sql-run')).toBeVisible();
  await page.goto('/');
  await open();
  await expect(sqlLink()).toBeVisible();
  await expect(sqlLink()).toHaveAttribute('href', '/sql/');

  // signed out (or another account): the Worker says not the owner, and the link goes again
  await page.route('**/api/owner/status', (r) => r.fulfill({ json: { configured: true, owner: false } }));
  await page.goto('/sql/');
  await expect(page.getByTestId('owner-signin')).toBeVisible();
  await page.goto('/');
  await open();
  await expect(sqlLink()).toHaveCount(0);
});
