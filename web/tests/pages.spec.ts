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
  await expect(page.getByTestId('trend-chart')).toBeVisible();
  // plus-minus is filled in, with a sign
  await expect(page.getByTestId('game-log').locator('tbody')).toContainText(/[+-]\d/);
});

test('streamers shows the week grid and the candidates', async ({ page }) => {
  await page.goto('/streamers/');
  await expect(page.getByTestId('season-note')).toBeVisible();
  const grid = page.getByTestId('week-grid');
  await expect(grid).toBeVisible();
  await expect(grid.locator('tbody tr').filter({ has: page.locator('td:first-child', { hasText: /^ATL$/ }) })).toContainText('v GSV');
  const rows = page.getByTestId('trending').locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(10);
});

test('streamers can be filtered by position and re-sorted', async ({ page }) => {
  await page.goto('/streamers/');
  const rows = page.getByTestId('trending').locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  await page.getByLabel('Position C').check({ force: true });
  const positions = await rows.locator('td:nth-child(3)').allInnerTexts();
  expect(positions.length).toBeGreaterThan(0);
  expect(positions.every((p) => p.includes('C'))).toBe(true);
  await page.getByRole('button', { name: /^PTS/ }).click();
  const pts = (await rows.locator('td:nth-child(10)').allInnerTexts()).map(Number);
  expect(pts[0]).toBeGreaterThanOrEqual(pts[pts.length - 1] ?? 0);
});

test('the board switches between blended, recent and per-game views', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr').first()).toBeVisible();
  await expect(page.getByTestId('season-note')).toContainText('regular season is over');
  await page.getByRole('radio', { name: 'Per game' }).click();
  await expect(board.locator('thead')).toContainText('MIN');
  await expect(board.locator('thead')).not.toContainText('Total');
  await page.getByRole('button', { name: /^PTS/ }).click();
  const pts = (await board.locator('tbody tr td:nth-child(7)').allInnerTexts()).map(Number);
  expect(pts[0]).toBeGreaterThanOrEqual(pts[1] ?? 0);
  await page.getByRole('radio', { name: 'Last 10 games' }).click();
  await expect(board.locator('thead')).toContainText('Total');
});

test('the board filters by position and shows injury tags', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr').first()).toBeVisible();
  await page.getByTestId('board-more').click();
  await expect(page.getByTestId('injury-tag').first()).toBeVisible();
  await page.getByLabel('Position G').check({ force: true });
  const positions = await board.locator('tbody tr td:nth-child(4)').allInnerTexts();
  expect(positions.every((p) => p.includes('G'))).toBe(true);
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
  await page.getByTestId('sql-input').fill('select max(game_date) as last_game from dim_game');
  await page.getByTestId('sql-run').click();
  await expect(page.getByTestId('sql-results').locator('tbody tr').first()).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
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

for (const path of ['/', '/streamers/', '/health/', '/p/wnba/1628932/']) {
  test(`${path} has no accessibility violations`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('main table').first()).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations).toEqual([]);
  });
}

test('the notebooks page shows each analysis with its findings for the league', async ({ page }) => {
  await page.goto('/notebooks/');
  const cards = page.getByTestId('notebooks').locator('section');
  await expect(cards).toHaveCount(3);
  await expect(page.getByTestId('findings')).toHaveCount(3);
  await expect(page.getByTestId('findings').first()).toContainText('points per 100');
  await expect(page.getByRole('link', { name: /open the full notebook/i }).first()).toBeVisible();
  await page.goto('/notebooks/?league=nba');
  await expect(page.getByTestId('findings').nth(2)).toContainText('rank correlation');
});

test('the dashboards page explains the workbook and lists the extract', async ({ page }) => {
  await page.goto('/dashboards/');
  await expect(page.getByTestId('tableau-pending').or(page.getByTestId('tableau-embed'))).toBeVisible();
  await expect(page.getByTestId('tableau-files').locator('li')).toHaveCount(3);
});

for (const path of ['/', '/streamers/', '/health/', '/p/wnba/1628932/', '/sql/', '/notebooks/', '/dashboards/']) {
  test(`${path} has no horizontal scroll on a phone`, async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile project only');
    await page.goto(path);
    await page.locator('main h1, main [data-testid]').first().waitFor();
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow).toBe(false);
  });
}
