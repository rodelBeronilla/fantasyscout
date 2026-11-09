import AxeBuilder from '@axe-core/playwright';

import { expect, test } from './fixtures';

// The NBA player pages (#942): the fixture carries the player files of the top of the NBA board, so
// the NBA page is tested from the board's link as the WNBA one is.

test('an NBA player page opens from the NBA board and renders the season line, shot chart and game log', async ({ page }) => {
  await page.goto('/?league=nba');
  const first = page.getByTestId('board').locator('tbody tr[data-player]').first().locator('a');
  await expect(first).toHaveAttribute('href', /\/p\/nba\/\d+\//);
  const name = await first.innerText();
  await first.click();
  await expect(page).toHaveURL(/\/p\/nba\/\d+\//);
  await expect(page.getByTestId('player-name')).toHaveText(name);
  await expect(page.getByText("Could not load this page's data.")).toHaveCount(0);
  await expect(page.getByTestId('player-outlook')).toContainText('Board rank (default league)');
  await expect(page.getByTestId('projected-line')).toContainText('PTS');
  await expect(page.getByTestId('season-lines').locator('tbody tr').first()).toContainText('2026-27');
  await expect(page.getByTestId('game-log').locator('tbody tr').first()).toBeVisible();
  await expect(page.getByTestId('shot-chart')).toBeVisible();
  await expect(page.getByTestId('trend-chart')).toBeVisible();
});

test('every NBA player the fixture names has a page, and it has no accessibility violations', async ({ page }) => {
  // Nikola Jokić leads the fixture's NBA board; the notes tests name Tyrese Haliburton.
  for (const [id, name] of [
    ['203999', 'Nikola Jokić'],
    ['1630169', 'Tyrese Haliburton'],
  ] as const) {
    const file = page.waitForResponse((r) => r.url().endsWith(`/players/nba/${id}.json`));
    await page.goto(`/p/nba/${id}/`);
    expect((await file).status()).toBe(200);
    await expect(page.getByTestId('player-name')).toHaveText(name);
    await expect(page.getByText("Could not load this page's data.")).toHaveCount(0);
  }
  await expect(page.getByTestId('season-lines')).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations).toEqual([]);
});
