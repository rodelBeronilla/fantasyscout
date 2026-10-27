import AxeBuilder from '@axe-core/playwright';

import { expect, test } from './fixtures';

// The preview server serves the fixture data build (tests/fixtures/data) under /data/.

test('the board ranks players and links to player pages', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board).toBeVisible();
  const rows = board.locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(0);
  const firstLink = rows.first().locator('a');
  await expect(firstLink).toHaveAttribute('href', /\/p\/wnba\/\d+\//);
});

test('punting a category removes it from the total', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr').first()).toBeVisible();
  const before = await board.locator('tbody tr').first().locator('td').last().innerText();
  await page.locator('fieldset label', { hasText: /^PTS$/ }).click();
  await expect(board.locator('thead s')).toHaveText('PTS');
  const after = await board.locator('tbody tr').first().locator('td').last().innerText();
  expect(after).not.toBe(before);
});

test('the footer shows the data build and links to its Data Health entry', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-data-build-id]')).toHaveText('fixture');
  await expect(page.locator('[data-data-as-of]')).toContainText('WNBA 2026-09-24');
  await expect(page.locator('[data-data-build-link]')).toHaveAttribute('href', '/health/#build-fixture');
  await expect(page.locator('[data-build-id]')).not.toBeEmpty();
});

test('a player page renders the season line, shot chart and game log', async ({ page }) => {
  await page.goto('/');
  const first = page.getByTestId('board').locator('tbody tr').first().locator('a');
  const name = await first.innerText();
  await first.click();
  await expect(page).toHaveURL(/\/p\/wnba\/\d+\//);
  await expect(page.getByTestId('player-name')).toHaveText(name);
  await expect(page.getByTestId('season-lines').locator('tbody tr').first()).toBeVisible();
  await expect(page.getByTestId('game-log').locator('tbody tr').first()).toBeVisible();
  await expect(page.getByTestId('shot-chart')).toBeVisible();
});

test('streamers lists games in the next seven days and the minutes trend', async ({ page }) => {
  await page.goto('/streamers/');
  await expect(page.getByTestId('trending')).toBeVisible();
  await expect(page.getByRole('heading', { name: /games in the next 7 days/i })).toBeVisible();
});

test('data health shows the build, its checks and the reconciliation table', async ({ page }) => {
  await page.goto('/health/');
  await expect(page.getByTestId('health-build-id')).toHaveText('fixture');
  await expect(page.getByTestId('ingest')).toBeVisible();
  await expect(page.getByTestId('reconciliation').locator('tbody tr').first()).toBeVisible();
  await page.getByRole('button', { name: /show all/i }).click();
  await expect(page.getByTestId('checks').locator('tbody tr').first()).toBeVisible();
});

test('the SQL console runs a saved query in the browser', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'DuckDB-WASM is exercised on Chromium');
  test.setTimeout(120_000);
  await page.goto('/sql/');
  await expect(page.getByTestId('sql-run')).toBeEnabled({ timeout: 90_000 });
  await expect(page.getByTestId('sql-views')).toContainText('dim_team');
  await page.getByTestId('sql-input').fill('select count(*) as teams from dim_team');
  await page.getByTestId('sql-run').click();
  await expect(page.getByTestId('sql-results').locator('tbody tr').first()).toHaveText(/^[1-9]\d*$/);
});

test('the league toggle switches the board to the NBA', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('group', { name: 'League' }).getByRole('link', { name: 'NBA', exact: true }).click();
  await expect(page).toHaveURL(/league=nba/);
  await expect(page.getByRole('group', { name: 'League' }).locator('[aria-current="true"]')).toHaveText('NBA');
});

test('the theme toggle flips between dark and light', async ({ page }) => {
  await page.goto('/');
  const html = page.locator('html');
  await page.getByRole('button', { name: /toggle dark or light theme/i }).click();
  const first = await html.getAttribute('data-theme');
  expect(first === 'dark' || first === 'light').toBe(true);
  await page.getByRole('button', { name: /toggle dark or light theme/i }).click();
  expect(await html.getAttribute('data-theme')).not.toBe(first);
});

for (const path of ['/', '/streamers/', '/health/']) {
  test(`${path} has no accessibility violations`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('main table').first()).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations).toEqual([]);
  });
}
