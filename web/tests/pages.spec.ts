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
  const before = await board.locator('tbody tr').first().locator('td').nth(-2).innerText();
  await page.locator('fieldset label', { hasText: /^PTS$/ }).click();
  await expect(board.locator('thead s')).toHaveText('PTS');
  const after = await board.locator('tbody tr').first().locator('td').nth(-2).innerText();
  expect(after).not.toBe(before);
});

test('counting games played scales the total by the projected games share', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('thead')).toContainText('GP%');
  const first = board.locator('tbody tr').first();
  await expect(first).toBeVisible();
  const name = await first.locator('a').innerText();
  const withGames = Number(await first.locator('td').nth(-2).innerText());
  await page.getByLabel('Count games played').uncheck();
  const row = board.locator('tbody tr', { hasText: name }).first();
  const perGame = Number(await row.locator('td').nth(-2).innerText());
  expect(perGame).toBeGreaterThan(withGames);
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

test('the board switches between value, recent, projected and per-game views', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr').first()).toBeVisible();
  await expect(page.getByTestId('season-note')).toContainText('regular season is over');
  await page.getByRole('radio', { name: 'Per game' }).click();
  await expect(board.locator('thead')).toContainText('MIN');
  await expect(board.locator('thead')).not.toContainText('Total');
  await page.getByRole('button', { name: /^PTS/ }).click();
  const pts = (await board.locator('tbody tr td:nth-child(8)').allInnerTexts()).map(Number);
  expect(pts[0]).toBeGreaterThanOrEqual(pts[1] ?? 0);
  await page.getByRole('radio', { name: 'Last 10 games' }).click();
  await expect(board.locator('thead')).toContainText('Total');
  await page.getByRole('radio', { name: 'Projected line' }).click();
  await expect(board.locator('thead')).toContainText('MIN');
  await expect(board.locator('thead')).not.toContainText('Total');
  await expect(board.locator('tbody tr').first().locator('td:nth-child(7)')).toHaveText(/^\d+(\.\d+)?$/);
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

// Static pages: nothing loads after the first paint. The schema page is checked with every model open.
for (const path of ['/pipeline/', '/schema/']) {
  test(`${path} has no accessibility violations`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('main h1')).toBeVisible();
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => d.setAttribute('open', '')));
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

for (const path of ['/', '/streamers/', '/health/', '/p/wnba/1628932/', '/sql/', '/notebooks/', '/dashboards/', '/pipeline/', '/schema/']) {
  test(`${path} has no horizontal scroll on a phone`, async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile project only');
    await page.goto(path);
    await page.locator('main h1, main [data-testid]').first().waitFor();
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow).toBe(false);
  });
}

test('the pipeline page has its four diagrams and every stage', async ({ page }) => {
  await page.goto('/pipeline/');
  for (const id of ['dfd', 'deployment', 'sequence', 'activity']) {
    await expect(page.getByTestId(`diagram-${id}`).locator('svg')).toBeVisible();
  }
  const dfd = page.getByTestId('diagram-dfd');
  expect(await dfd.locator('a').count()).toBeGreaterThanOrEqual(10);
  await expect(dfd).toContainText('Decide the gate');
  await expect(page.getByTestId('diagram-sequence')).toContainText('latest.json (last)');
  await expect(page.getByTestId('diagram-activity')).toContainText('games share');
  await expect(page.getByTestId('pipeline-stages').locator(':scope > section')).toHaveCount(11);
  await expect(page.getByTestId('known-gaps').locator('li')).toHaveCount(5);
  await dfd.locator('a[href="#gate"]').first().click();
  await expect(page).toHaveURL(/#gate$/);
});

test('the schema page draws the star schema and the lineage, and a model opens to its notes and columns', async ({ page }) => {
  await page.goto('/schema/');
  const er = page.getByTestId('diagram-er');
  await expect(er.locator('svg')).toBeVisible();
  for (const name of ['dim_player', 'fct_player_game', 'mart_board']) await expect(er).toContainText(name);
  await expect(page.getByTestId('diagram-lineage').locator('a[href="#m-mart_board"]')).toHaveCount(1);
  for (const layer of ['bronze', 'silver', 'gold', 'ops']) {
    await expect(page.getByTestId(`layer-${layer}`).getByTestId('model').first()).toBeVisible();
  }
  const board = page.locator('#m-mart_board');
  await board.locator('summary').click();
  await expect(board).toContainText('value above replacement');
  await expect(board.locator('table')).toContainText('value_total');
  await expect(page.getByTestId('checks-list').locator('tbody tr').first()).toBeVisible();
});

test('the board header stays in view while its rows scroll', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr').first()).toBeVisible();
  const region = page.locator('.table-scroll', { has: board });
  await region.evaluate((el) => el.scrollTo({ top: 800 }));
  const regionBox = await region.boundingBox();
  const headBox = await board.locator('thead th').first().boundingBox();
  expect(Math.abs((headBox?.y ?? 0) - (regionBox?.y ?? -100))).toBeLessThan(2);
});

for (const path of ['/', '/streamers/', '/health/', '/p/wnba/1628932/', '/notebooks/', '/schema/']) {
  test(`every table on ${path} keeps its header in view`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('main table').first()).toBeAttached();
    const tables = await page.locator('main table').count();
    expect(await page.locator('main .table-scroll table').count()).toBe(tables);
    const position = await page.locator('main table thead th').first().evaluate((th) => getComputedStyle(th).position);
    expect(position).toBe('sticky');
  });
}

test('a punted category is struck through on its chip', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('board').locator('tbody tr').first()).toBeVisible();
  const chip = page.locator('fieldset label', { hasText: /^PTS$/ });
  expect(await chip.evaluate((el) => getComputedStyle(el).textDecorationLine)).not.toContain('line-through');
  await chip.click();
  expect(await chip.evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain('line-through');
});

test('the board ranks by this season and the last twenty games, and filters to rookies', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr').first()).toBeVisible();
  await page.getByRole('radio', { name: 'This season' }).click();
  await expect(board.locator('thead')).toContainText('Total');
  await page.getByRole('radio', { name: 'Last 20 games' }).click();
  await expect(board.locator('tbody tr').first()).toBeVisible();
  await page.getByRole('radio', { name: 'Value' }).click();
  const all = await board.locator('tbody tr').count();
  await page.getByLabel('Rookies only').check();
  const rookies = board.locator('tbody tr');
  await expect(rookies.first()).toContainText('R');
  expect(await rookies.count()).toBeLessThan(all);
  await page.getByLabel('Rookies only').uncheck();
  await page.getByTestId('league-settings').locator('summary').click();
  await page.getByLabel('Scoring').selectOption('cats8');
  await expect(board.locator('thead s')).toHaveText('TO');
  await page.getByLabel('Scoring').selectOption('cats9');
});

test('the watchlist keeps starred players across visits, and compare lines players up', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr').first()).toBeVisible();
  const first = board.locator('tbody tr').first();
  const name = await first.locator('a').innerText();
  await first.getByTestId('watch').click();
  await page.reload();
  await expect(board.locator('tbody tr').first()).toBeVisible();
  await page.getByLabel(/Watchlist only/).check();
  await expect(board.locator('tbody tr')).toHaveCount(1);
  await expect(board.locator('tbody tr').first()).toContainText(name);
  await page.getByLabel(/Watchlist only/).uncheck();
  const rows = board.locator('tbody tr');
  await rows.nth(0).getByRole('checkbox', { name: /^Compare / }).check();
  await rows.nth(1).getByRole('checkbox', { name: /^Compare / }).check();
  const compare = page.getByTestId('compare');
  await expect(compare).toContainText('Compare (2/4)');
  await expect(compare.locator('thead')).toContainText(name);
  await expect(compare.locator('tbody')).toContainText('PTS (proj)');
});

test('the board exports what it shows as CSV', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('board').locator('tbody tr').first()).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('board-csv').click()]);
  expect(download.suggestedFilename()).toBe('fantasyscout-wnba-board-value.csv');
  const text = await (await download.createReadStream()).toArray();
  const lines = Buffer.concat(text).toString('utf8').trim().split(String.fromCharCode(10));
  expect(lines[0]).toContain('rank,player,team');
  expect(lines.length).toBeGreaterThan(10);
});

test('streamers rank by the categories you need and leave out likely rostered players', async ({ page }) => {
  await page.goto('/streamers/');
  const table = page.getByTestId('trending');
  await expect(table.locator('tbody tr').first()).toBeVisible();
  const all = await table.locator('tbody tr').count();
  await page.getByLabel('Need BLK').check({ force: true });
  await page.getByLabel('Need REB').check({ force: true });
  await expect(table.locator('thead')).toContainText('Need fit');
  await page.getByLabel(/Likely available/).selectOption('60');
  const after = await table.locator('tbody tr').count();
  expect(after).toBeLessThanOrEqual(all);
  const ranks = (await table.locator('tbody tr td:nth-last-child(2)').allInnerTexts()).filter((t) => t !== '–').map(Number);
  expect(ranks.every((r) => r > 60)).toBe(true);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('streamers-csv').click()]);
  expect(download.suggestedFilename()).toBe('fantasyscout-wnba-streamers.csv');
});

for (const [path, testid] of [['/', 'board'], ['/streamers/', 'trending']]) {
  test(`sorting ${path} by another column keeps the table where it was scrolled`, async ({ page }) => {
    await page.goto(path);
    const table = page.getByTestId(testid);
    await expect(table.locator('tbody tr').nth(20)).toBeVisible();
    const region = page.locator('.table-scroll', { has: table });
    await region.evaluate((el) => el.scrollTo({ top: 400, left: 120 }));
    const before = await region.evaluate((el) => [el.scrollTop, el.scrollLeft]);
    // A tap on a header already on screen: dispatch the click so the test itself does not scroll.
    await table.locator('thead th button').nth(4).dispatchEvent('click');
    await page.waitForTimeout(200);
    const after = await region.evaluate((el) => [el.scrollTop, el.scrollLeft]);
    expect(after).toEqual(before);
  });
}

test('league settings re-measure value for the league, and points leagues score fantasy points', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr').first()).toBeVisible();
  const first = board.locator('tbody tr').first();
  const before = Number(await first.locator('td').nth(-2).innerText());
  await page.getByTestId('league-settings').locator('summary').click();
  await page.getByLabel('Teams in the league').fill('6');
  await page.getByLabel('Roster spots').fill('8');
  await expect(page.getByTestId('league-summary')).toHaveText('6 teams × 8, 9-cat');
  const smaller = Number(await board.locator('tbody tr').first().locator('td').nth(-2).innerText());
  expect(smaller).not.toBe(before);
  await page.getByLabel('Scoring').selectOption('points');
  await expect(board.locator('thead')).toContainText('FPts/G');
  await expect(page.getByTestId('point-weights')).toBeVisible();
  await page.reload();
  await expect(board.locator('thead')).toContainText('FPts/G');
  await expect(page.getByTestId('league-summary')).toHaveText('6 teams × 8, Points');
  await page.getByTestId('league-settings').locator('summary').click();
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(page.getByTestId('league-summary')).toHaveText('10 teams × 10, 9-cat');
});

test('marking my team and taken players gives best available, a category profile and Fit', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr').first()).toBeVisible();
  const rows = board.locator('tbody tr');
  const mineName = await rows.nth(0).locator('a').innerText();
  const takenName = await rows.nth(1).locator('a').innerText();
  await rows.nth(0).getByTestId('mark-mine').click();
  await rows.nth(1).getByTestId('mark-taken').click();
  await rows.nth(2).getByTestId('mark-mine').click();
  const team = page.getByTestId('my-team');
  await expect(team).toContainText('My team (2 players)');
  await expect(team).toContainText(mineName);
  await expect(team.getByTestId('category-profile')).toContainText('Weakest');
  await expect(board.locator('thead')).toContainText('Fit');
  await page.getByLabel('Show').selectOption('available');
  await expect(board.locator('tbody')).not.toContainText(mineName);
  await expect(board.locator('tbody')).not.toContainText(takenName);
  await board.getByRole('button', { name: /^Fit/ }).click();
  await expect(board.locator('tbody tr').first()).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('my-team')).toContainText('My team (2 players)');
  await page.getByRole('button', { name: 'Clear my team' }).click();
  await expect(page.getByTestId('my-team')).toHaveCount(0);
});

test('the value view breaks the board into tiers and ranks players by position', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr').first()).toBeVisible();
  await expect(board.getByTestId('tier-start').first()).toHaveText('Tier 1');
  expect(await board.getByTestId('tier-start').count()).toBeGreaterThan(1);
  await expect(board.getByTestId('pos-rank').first()).toHaveText(/^[GFC]1$/);
});
