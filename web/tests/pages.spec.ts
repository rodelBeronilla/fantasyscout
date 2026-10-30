import AxeBuilder from '@axe-core/playwright';

import { expect, test } from './fixtures';

// The preview server serves the fixture data build (tests/fixtures/data) under /data/.

test('the board ranks players and links to player pages', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board).toBeVisible();
  const rows = board.locator('tbody tr[data-player]');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(0);
  const firstLink = rows.first().locator('a');
  await expect(firstLink).toHaveAttribute('href', /\/p\/wnba\/\d+\//);
});

test('punting a category removes it from the total', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr[data-player]').first()).toBeVisible();
  const before = await board.locator('tbody tr[data-player]').first().locator('td').nth(-2).innerText();
  await page.getByTestId('board-options-toggle').click();
  await page.locator('fieldset label', { hasText: /^PTS$/ }).click();
  await expect(board.locator('thead s')).toHaveText('PTS');
  await expect(page.getByTestId('active-filters')).toContainText('Punt PTS');
  const after = await board.locator('tbody tr[data-player]').first().locator('td').nth(-2).innerText();
  expect(after).not.toBe(before);
});

test('counting games played scales the total by the projected games share', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('thead')).toContainText('GP%');
  const first = board.locator('tbody tr[data-player]').first();
  await expect(first).toBeVisible();
  const name = await first.locator('a').innerText();
  const withGames = Number(await first.locator('td').nth(-2).innerText());
  await page.getByTestId('board-options-toggle').click();
  await page.getByLabel('Count games played').uncheck();
  const row = board.locator('tbody tr[data-player]', { hasText: name }).first();
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
  const first = page.getByTestId('board').locator('tbody tr[data-player]').first().locator('a');
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
  await expect(board.locator('tbody tr[data-player]').first()).toBeVisible();
  await expect(page.getByTestId('season-note')).toContainText('regular season is over');
  await page.getByRole('radio', { name: 'Per game' }).click();
  await expect(board.locator('thead')).toContainText('MIN');
  await expect(board.locator('thead')).not.toContainText('Total');
  await page.getByRole('button', { name: /^PTS/ }).click();
  const pts = (await board.locator('tbody tr[data-player] td:nth-child(8)').allInnerTexts()).map(Number);
  expect(pts[0]).toBeGreaterThanOrEqual(pts[1] ?? 0);
  await page.getByRole('radio', { name: 'Last 10 games' }).click();
  await expect(board.locator('thead')).toContainText('Total');
  await page.getByRole('radio', { name: 'Projected line' }).click();
  await expect(board.locator('thead')).toContainText('MIN');
  await expect(board.locator('thead')).not.toContainText('Total');
  await expect(board.locator('tbody tr[data-player]').first().locator('td:nth-child(7)')).toHaveText(/^\d+(\.\d+)?$/);
});

test('the board filters by position and shows injury tags', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr[data-player]').first()).toBeVisible();
  await page.getByTestId('board-more').click();
  await expect(page.getByTestId('injury-tag').first()).toBeVisible();
  await page.getByLabel('Position G').check({ force: true });
  const positions = await board.locator('tbody tr[data-player] td:nth-child(4)').allInnerTexts();
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

for (const path of ['/', '/league/', '/streamers/', '/health/', '/p/wnba/1628932/', '/sql/', '/notebooks/', '/dashboards/', '/pipeline/', '/schema/']) {
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
  await expect(board.locator('tbody tr[data-player]').first()).toBeVisible();
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
  await page.getByTestId('board-options-toggle').click();
  const chip = page.locator('fieldset label', { hasText: /^PTS$/ });
  expect(await chip.evaluate((el) => getComputedStyle(el).textDecorationLine)).not.toContain('line-through');
  await chip.click();
  expect(await chip.evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain('line-through');
});

test('the board ranks by this season and the last twenty games, and filters to rookies', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr[data-player]').first()).toBeVisible();
  await page.getByRole('radio', { name: 'This season' }).click();
  await expect(board.locator('thead')).toContainText('Total');
  await page.getByRole('radio', { name: 'Last 20 games' }).click();
  await expect(board.locator('tbody tr[data-player]').first()).toBeVisible();
  await page.getByRole('radio', { name: 'Value' }).click();
  const all = await board.locator('tbody tr[data-player]').count();
  await page.getByTestId('board-options-toggle').click();
  await page.getByLabel('Rookies only').check();
  const rookies = board.locator('tbody tr[data-player]');
  await expect(rookies.first()).toContainText('R');
  expect(await rookies.count()).toBeLessThan(all);
  await page.getByRole('button', { name: 'Remove Rookies' }).click();
  expect(await board.locator('tbody tr[data-player]').count()).toBe(all);
});

test('the watchlist keeps starred players across visits, and compare lines players up', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr[data-player]').first()).toBeVisible();
  const first = board.locator('tbody tr[data-player]').first();
  const name = await first.locator('a').innerText();
  await first.getByTestId('watch').click();
  await page.reload();
  await expect(board.locator('tbody tr[data-player]').first()).toBeVisible();
  await page.getByTestId('board-options-toggle').click();
  await page.getByLabel(/Watchlist only/).check();
  await expect(board.locator('tbody tr[data-player]')).toHaveCount(1);
  await expect(board.locator('tbody tr[data-player]').first()).toContainText(name);
  await page.getByLabel(/Watchlist only/).uncheck();
  const rows = board.locator('tbody tr[data-player]');
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

test('the League page sets the league the board values for, and points leagues score fantasy points', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  const first = board.locator('tbody tr[data-player]').first();
  await expect(first).toBeVisible();
  const before = Number(await first.locator('td').nth(-2).innerText());
  await expect(page.getByTestId('league-summary')).toHaveText('10 teams × 10, 9-cat');
  await page.getByRole('link', { name: /Set up your league/ }).click();
  await expect(page).toHaveURL(/\/league\//);
  await page.getByLabel('Teams in the league').fill('6');
  await page.getByLabel('Roster spots').fill('8');
  await expect(page.getByTestId('team-card')).toHaveCount(6);
  await page.goto('/');
  await expect(page.getByTestId('league-summary')).toHaveText('6 teams × 8, 9-cat');
  const smaller = Number(await board.locator('tbody tr[data-player]').first().locator('td').nth(-2).innerText());
  expect(smaller).not.toBe(before);
  await page.goto('/league/');
  await page.getByLabel('Scoring').selectOption('cats8');
  await page.goto('/');
  await expect(board.locator('thead s')).toHaveText('TO');
  await page.goto('/league/');
  await page.getByLabel('Scoring').selectOption('points');
  await expect(page.getByTestId('point-weights')).toBeVisible();
  await page.goto('/');
  await expect(board.locator('thead')).toContainText('FPts/G');
  await expect(page.getByTestId('league-summary')).toHaveText('6 teams × 8, Points');
  await page.goto('/league/');
  await page.getByRole('button', { name: 'Reset settings' }).click();
  await expect(page.getByLabel('Teams in the league')).toHaveValue('10');
});

test('rosters on the League page give the board who is available, owners, Fit and what is left in each tier', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  const rows = board.locator('tbody tr[data-player]');
  await expect(rows.first()).toBeVisible();
  const [a, b, c] = await Promise.all([0, 1, 2].map((i) => rows.nth(i).locator('a').innerText()));
  await page.goto('/league/');
  const cards = page.getByTestId('team-card');
  await cards.nth(0).getByText('Paste a roster').click();
  await page.getByLabel('Paste names for Team 1', { exact: true }).fill(`${a}\n${c}\nNobody Atall`);
  await cards.nth(0).getByRole('button', { name: 'Add pasted players' }).click();
  await expect(cards.nth(0).getByTestId('paste-result')).toHaveText('Added 2. Not found: Nobody Atall.');
  await page.getByLabel('Name of team 2').fill('Rivals');
  await cards.nth(1).getByText('Paste a roster').click();
  await page.getByLabel('Paste names for Rivals').fill(b ?? '');
  await cards.nth(1).getByRole('button', { name: 'Add pasted players' }).click();
  await expect(cards.nth(1).getByTestId('roster')).toContainText(b ?? '');
  await expect(page.getByTestId('team-strength')).toContainText('Rivals');
  await expect(page.getByTestId('category-profile')).toBeVisible();
  await page.goto('/');
  await expect(page.getByTestId('league-bar')).toContainText('Team 1 (2/10)');
  await expect(page.getByRole('radio', { name: 'Available' })).toHaveAttribute('aria-checked', 'true');
  await expect(rows.first()).toBeVisible();
  await expect(board.locator('tbody')).not.toContainText(a ?? '');
  await expect(board.locator('tbody')).not.toContainText(b ?? '');
  await expect(board.locator('thead')).toContainText('Fit');
  await expect(board.getByTestId('tier-head').first()).toContainText('available');
  await page.getByRole('radio', { name: 'My team' }).click();
  await expect(rows).toHaveCount(2);
  await page.getByRole('radio', { name: 'Everyone' }).click();
  await expect(rows.filter({ hasText: b ?? '' }).getByTestId('owner')).toHaveText('Rivals');
  await page.goto('/streamers/');
  await expect(page.getByLabel(/Likely available/)).toHaveValue('-1');
});

test('a draft on the League page snakes pick by pick, here and on the board, with undo', async ({ page }) => {
  await page.goto('/league/');
  await page.getByLabel('Teams in the league').fill('4');
  await page.getByRole('button', { name: 'Start a draft' }).click();
  const bar = page.getByTestId('draft-bar');
  await expect(bar).toContainText('Round 1, pick 1 (#1): Team 1 is your team');
  const best = page.getByTestId('best-available').locator('li');
  await best.first().getByRole('button', { name: /^Draft / }).click();
  await expect(bar).toContainText('Round 1, pick 2 (#2): Team 2 is on the clock');
  await expect(page.getByTestId('pick-log')).toContainText('#1 R1 Team 1');
  for (let i = 0; i < 3; i += 1) await best.first().getByRole('button', { name: /^Draft / }).click();
  // The order reverses: the last team in round one picks first in round two.
  await expect(bar).toContainText('Round 2, pick 1 (#5): Team 4 is on the clock');
  await page.goto('/');
  await expect(page.getByTestId('draft-bar')).toContainText('(#5)');
  const rows = page.getByTestId('board').locator('tbody tr[data-player]');
  const name = await rows.first().locator('a').innerText();
  await rows.first().getByTestId('draft').click();
  await expect(page.getByTestId('draft-bar')).toContainText(`Last pick: ${name}`);
  await expect(page.getByTestId('draft-bar')).toContainText('(#6)');
  await page.getByRole('button', { name: 'Undo last pick' }).click();
  await expect(page.getByTestId('draft-bar')).toContainText('(#5)');
  await page.getByRole('button', { name: 'End draft' }).click();
  await expect(page.getByTestId('draft-bar')).toHaveCount(0);
});

test('the value view groups the board into tiers by pick and round, and ranks players by position', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr[data-player]').first()).toBeVisible();
  const heads = board.getByTestId('tier-head');
  await expect(heads.first()).toContainText(/^Tier 1 · (pick 1 \(round 1\) · value [\d.]+$|picks 1–\d+ \(rounds? 1)/);
  expect(await heads.count()).toBeGreaterThan(1);
  await expect(page.getByTestId('tier-note')).toContainText('natural breaks');
  await expect(board.getByTestId('pos-rank').first()).toHaveText(/^[GFC]1$/);
  await page.getByRole('radio', { name: 'Per game' }).click();
  await expect(heads).toHaveCount(0);
});

test('/league/ has no accessibility violations', async ({ page }) => {
  await page.goto('/league/');
  await page.getByRole('button', { name: 'Start a draft' }).click();
  const best = page.getByTestId('best-available').locator('li');
  await best.first().getByRole('button', { name: /^Draft / }).click();
  await best.first().getByRole('button', { name: /^Draft / }).click();
  await expect(page.getByTestId('team-strength')).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations).toEqual([]);
});

test('the Yahoo import shows as coming soon until it is live, then imports settings, teams and rosters', async ({ page }) => {
  await page.goto('/league/?league=nba');
  await expect(page.getByTestId('team-card').first()).toBeVisible();
  await expect(page.getByTestId('yahoo-soon')).toContainText('Coming soon');
  await expect(page.getByTestId('yahoo-import')).toHaveCount(0);
  await page.goto('/league/?league=wnba');
  await expect(page.getByTestId('team-card').first()).toBeVisible();
  await expect(page.getByTestId('yahoo-soon')).toHaveCount(0);

  // The fixture build's NBA board is empty: stand the WNBA players in for it.
  await page.route('**/board/nba.json', async (r) => r.fulfill({ response: await r.fetch({ url: r.request().url().replace(/\/nba\.json$/, '/wnba.json') }) }));
  await page.goto('/?league=nba');
  const rows = page.getByTestId('board').locator('tbody tr[data-player]');
  await expect(rows.first()).toBeVisible();
  const [a, b, c] = await Promise.all([0, 1, 2].map((i) => rows.nth(i).locator('a').innerText()));
  const league = {
    name: 'Hoops Club',
    settings: { teams: 4, rosterSpots: 13, scoring: 'cats8', weights: null },
    teams: [
      { name: 'Dunk Tank', mine: false, players: [{ name: a, team: 'X', position: 'G' }, { name: 'Not A Player', team: 'X', position: 'G' }] },
      { name: 'Brick City', mine: true, players: [{ name: b, team: 'X', position: 'F' }, { name: c, team: 'X', position: 'C' }] },
      { name: 'Third', mine: false, players: [] },
      { name: 'Fourth', mine: false, players: [] },
    ],
  };
  await page.route('**/api/yahoo/status', (r) => r.fulfill({ json: { configured: true, live: true, connected: true } }));
  await page.route('**/api/yahoo/leagues', (r) => r.fulfill({ json: [{ key: '466.l.1234', name: 'Hoops Club', season: '2025', teams: 4 }] }));
  await page.route('**/api/yahoo/league/466.l.1234', (r) => r.fulfill({ json: league }));
  await page.goto('/league/?league=nba');
  const card = page.getByTestId('yahoo-import');
  await expect(card.getByLabel('Yahoo league')).toHaveValue('466.l.1234');
  await card.getByRole('button', { name: 'Import this league' }).click();
  await expect(page.getByTestId('yahoo-note')).toHaveText('Imported Hoops Club: 4 teams, 3 of 4 players matched. Not on the board: Not A Player.');
  await expect(page.getByTestId('team-card')).toHaveCount(4);
  await expect(page.getByLabel('Name of team 2')).toHaveValue('Brick City');
  await expect(page.getByLabel('Brick City is my team')).toBeChecked();
  await expect(page.getByLabel('Scoring')).toHaveValue('cats8');
  await expect(page.getByLabel('Roster spots')).toHaveValue('13');
  await page.goto('/?league=nba');
  await expect(page.getByTestId('league-bar')).toContainText('Brick City (2/13)');
});

test('the SQL console asks the public to sign in as the owner, and every page credits the sources', async ({ page }) => {
  await page.route('**/api/owner/status', (r) => r.fulfill({ json: { configured: true, owner: false } }));
  await page.goto('/sql/?signin=notowner&account=ABC123');
  const box = page.getByTestId('owner-signin');
  await expect(box).toContainText("open to the site's owner only");
  await expect(box.getByRole('link', { name: 'Sign in with Yahoo' })).toHaveAttribute('href', '/auth/owner/start');
  await expect(box.getByTestId('signin-note')).toContainText('set the repository variable OWNER_YAHOO_GUID to ABC123');
  await expect(page.getByTestId('sql-run')).toHaveCount(0);
  await page.goto('/sql/?signin=noid&fields=access_token,expires_in');
  await expect(page.getByTestId('signin-note')).toContainText('(it sent access_token,expires_in)');
  await expect(page.getByRole('link', { name: /^Sign in with Yahoo/ })).toHaveCount(1);
  await page.route('**/api/owner/status', (r) => r.fulfill({ json: { configured: false, owner: false } }));
  await page.goto('/sql/');
  await expect(page.getByTestId('console-private')).toBeVisible();
  for (const path of ['/', '/streamers/', '/league/']) {
    await page.goto(path);
    await expect(page.getByTestId('source-credit')).toContainText('Statistics from NBA.com and WNBA.com');
  }
});

test('streamers show the points the betting lines imply, in the grid and per player', async ({ page }) => {
  // The fixture build predates the lines: give every game one, home favoured by 4.5 in a 160 total.
  await page.route('**/schedule/wnba.json', async (route) => {
    const games = (await (await route.fetch()).json()) as Record<string, unknown>[];
    const lined = games.map((g) => ({ ...g, home_spread: -4.5, over_under: 160, home_implied_points: 82.25, away_implied_points: 77.75 }));
    await route.fulfill({ json: lined });
  });
  await page.goto('/streamers/');
  const grid = page.getByTestId('week-grid');
  await expect(grid.getByTestId('implied-points').first()).toHaveText(/^(82|78) pts$/);
  const atl = grid.locator('tbody tr').filter({ has: page.locator('td:first-child', { hasText: /^ATL$/ }) });
  await expect(atl.locator('td[title]').first()).toHaveAttribute('title', /^Over\/under 160, \w+ -4\.5: ATL implied (82\.25|77\.75) points$/);
  const table = page.getByTestId('trending');
  await expect(table.locator('thead')).toContainText('Team pts');
  // A player with games in the window shows the average of their team's implied points.
  await expect(table.locator('tbody td', { hasText: /^(82\.3|77\.8|80\.0)$/ }).first()).toBeVisible();
});

test("an injured player's page shows the injury, since when, the news and how the status changed", async ({ page }) => {
  // The fixture build predates the news and the history: add them to every player file.
  await page.route(/\/players\/wnba\/[^/]+\.json$/, async (route) => {
    const file = (await (await route.fetch()).json()) as { board: Record<string, unknown> | null };
    if (file.board) Object.assign(file.board, { injury_since: '2026-10-20', injury_news: 'Out after an MRI on the knee.' });
    await route.fulfill({
      json: {
        ...file,
        injury_history: [
          { injury_id: 'i1', status: 'Out', status_group: 'out', status_from: '2026-10-20', status_to: '2026-10-28', reports: 9 },
          { injury_id: 'i1', status: 'Day-To-Day', status_group: 'day_to_day', status_from: '2026-10-18', status_to: '2026-10-19', reports: 2 },
        ],
      },
    });
  });
  await page.goto('/');
  const board = page.getByTestId('board');
  await page.getByTestId('board-more').click();
  const injured = board.locator('tbody tr[data-player]', { has: page.getByTestId('injury-tag') }).first();
  await injured.locator('a').first().click();
  const card = page.getByTestId('injury-card');
  await expect(card).toContainText('since Oct 20, 2026');
  await expect(card.getByTestId('injury-news')).toHaveText('Out after an MRI on the knee.');
  await expect(card.getByTestId('injury-history').locator('li')).toHaveCount(2);
});

test("the board shows the league's official injury report status for the next game", async ({ page }) => {
  // The fixture build predates the official reports: mark the first injured player as listed on one.
  await page.route('**/board/wnba.json', async (route) => {
    const rows = (await (await route.fetch()).json()) as Record<string, unknown>[];
    const i = rows.findIndex((r) => r['injury_group']);
    rows[i] = {
      ...rows[i],
      injury_status: 'Probable',
      injury_group: 'probable',
      injury_source: 'official',
      official_game_date: '2026-10-30',
      official_report_at: '2026-10-29T18:45:00',
    };
    await route.fulfill({ json: rows });
  });
  await page.goto('/');
  await page.getByTestId('board-more').click();
  const tag = page.getByTestId('board').getByTestId('injury-tag').filter({ hasText: 'PROB' }).first();
  await expect(tag).toBeVisible();
  await expect(tag).toHaveAttribute('title', /^Probable · Official report for Oct 30, 2026 \(18:45 ET\)/);
});

test("streamers mark today's starters and inactives from the league's lineups, and filter to starters", async ({ page }) => {
  // The fixture build predates the lineups: give the first rows a role.
  await page.route('**/streamers/wnba.json', async (route) => {
    const rows = (await (await route.fetch()).json()) as Record<string, unknown>[];
    const roles = [
      { lineup_role: 'starter', lineup_confirmed: true },
      { lineup_role: 'starter', lineup_confirmed: false },
      { lineup_role: 'inactive', lineup_confirmed: true },
    ];
    await route.fulfill({ json: rows.map((r, i) => ({ ...r, ...(roles[i] ?? {}) })) });
  });
  await page.goto('/streamers/');
  const table = page.getByTestId('trending');
  await expect(table.getByTestId('lineup-tag').filter({ hasText: /^START$/ })).toHaveCount(1);
  await expect(table.getByTestId('lineup-tag').filter({ hasText: 'START?' })).toHaveCount(1);
  await expect(table.getByTestId('lineup-tag').filter({ hasText: 'INACT' })).toHaveCount(1);
  await page.getByLabel('Starting today').check();
  await expect(table.locator('tbody tr')).toHaveCount(2);
});

test("streamers list the league's recent moves, and a player's page lists theirs", async ({ page }) => {
  const today = new Date().toISOString().slice(0, 10);
  await page.route('**/transactions/wnba.json', (route) =>
    route.fulfill({
      json: [
        { transaction_date: today, team_abbreviation: 'GS', player_id: null, move_type: 'signing', description: 'Signed C Aminata Gueye to a hardship contract.' },
        { transaction_date: '2020-01-01', team_abbreviation: 'LV', player_id: null, move_type: 'waive', description: 'An old move.' },
      ],
    }),
  );
  await page.route('**/schedule/wnba.json', (route) => route.fulfill({ json: [] }));
  await page.goto('/streamers/');
  const moves = page.getByTestId('recent-moves');
  await expect(moves.locator('li')).toHaveCount(1);
  await expect(moves).toContainText('Signed C Aminata Gueye');
  await expect(moves).toContainText('Signed');

  await page.route(/\/players\/wnba\/[^/]+\.json$/, async (route) => {
    const file = (await (await route.fetch()).json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...file, moves: [{ transaction_date: '2026-10-20', team_abbreviation: 'NYL', move_type: 'signing', description: 'New York Liberty signed guard X.' }] } });
  });
  await page.goto('/p/wnba/1628932/');
  await expect(page.getByTestId('player-moves')).toContainText('New York Liberty signed guard X.');
});

test('the streamers week grid marks the second night of a back-to-back, with travel in the tooltip', async ({ page }) => {
  await page.route('**/schedule/wnba.json', async (route) => {
    const games = (await (await route.fetch()).json()) as Record<string, unknown>[];
    await route.fulfill({ json: games.map((g, i) => (i === 0 ? { ...g, away_back_to_back: true, away_miles_travelled: 1203, at_altitude: false } : g)) });
  });
  await page.goto('/streamers/');
  const grid = page.getByTestId('week-grid');
  const marker = grid.getByTestId('back-to-back');
  await expect(marker).toHaveCount(1);
  await expect(marker.locator('xpath=..')).toHaveAttribute('title', /Second night of a back-to-back: rest and minutes risk\. 1203 miles from the previous game/);
});

test("the board sets the fantasy market's rank beside its own, and streamers can leave out widely rostered players", async ({ page }) => {
  await page.route('**/board/wnba.json', async (route) => {
    const rows = (await (await route.fetch()).json()) as Record<string, unknown>[];
    await route.fulfill({ json: rows.map((r, i) => (i === 0 ? { ...r, market_rank: 9, market_gap: 8, ownership_bucket: 'most' } : r)) });
  });
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('thead')).toContainText('Mkt');
  await expect(board.locator('thead')).toContainText('vs Mkt');
  const mkt = board.getByTestId('market-rank').filter({ hasText: /^9$/ });
  await expect(mkt).toHaveAttribute('title', 'Rostered in most ESPN leagues');
  await expect(board.locator('tbody tr[data-player]').first().locator('td').nth(-2)).toHaveText(/\d/);

  await page.route('**/streamers/wnba.json', async (route) => {
    const rows = (await (await route.fetch()).json()) as Record<string, unknown>[];
    // Three players rostered in few leagues; everyone else in most.
    await route.fulfill({ json: rows.map((r, i) => ({ ...r, ownership_bucket: i < 3 ? 'few' : 'most' })) });
  });
  await page.goto('/streamers/');
  const table = page.getByTestId('trending');
  await expect(table.locator('tbody tr').first()).toBeVisible();
  await page.getByLabel(/Likely available/).selectOption('-2');
  await expect(table.locator('tbody tr')).toHaveCount(3);
});

test('players on teams with nothing left to play for late in the season carry a rest-risk tag', async ({ page }) => {
  await page.route('**/board/wnba.json', async (route) => {
    const rows = (await (await route.fetch()).json()) as Record<string, unknown>[];
    await route.fulfill({ json: rows.map((r, i) => (i === 0 ? { ...r, rest_risk: true, team_stakes: 'clinched' } : r)) });
  });
  await page.goto('/');
  const tag = page.getByTestId('board').getByTestId('rest-risk');
  await expect(tag).toHaveCount(1);
  await expect(tag).toHaveAttribute('title', /clinched a playoff place with few games left/);
});
