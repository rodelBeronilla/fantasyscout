import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

// The preview server serves the fixture data build (tests/fixtures/data) under /data/.

type FixtureLeague = 'wnba' | 'nba';
interface FixtureGame {
  game_date: string;
  days_ahead: number;
  home_team_tricode: string;
  away_team_tricode: string;
}

/**
 * The fixture league with a game in the next seven days, and its schedule. The fixture follows the
 * live site, so the WNBA is out of season for part of the year and the week grid then belongs to
 * the NBA: tests of the grid open that league's page and route that league's files. Null when no
 * league has a game ahead, and the test says so and skips.
 */
async function leagueInSeason(page: Page): Promise<{ league: FixtureLeague; games: FixtureGame[] } | null> {
  for (const league of ['wnba', 'nba'] as const) {
    const games = (await (await page.request.get(`/data/builds/fixture/schedule/${league}.json`)).json()) as FixtureGame[];
    if (games.some((g) => g.days_ahead <= 6)) return { league, games };
  }
  return null;
}
const NO_SEASON = 'no fixture league has a game in the next seven days';

test('the page preloads the build pointer and the board is populated within budget', async ({ page }) => {
  const started = Date.now();
  await page.goto('/');
  await expect(page.locator('head link[rel="preload"][as="fetch"][href$="/data/latest.json"]')).toHaveCount(1);
  await expect(page.getByTestId('board').locator('tbody tr[data-player]').first()).toBeVisible();
  const elapsed = Date.now() - started;
  // Time to a populated board, the measure that matters (Lighthouse's LCP sees the heading). A
  // wide budget: the preview server and a cold browser, not the edge.
  test.info().annotations.push({ type: 'time-to-board-ms', description: String(elapsed) });
  expect(elapsed).toBeLessThan(10_000);
});

test('the sources page names every source with what is published from it, and the footer links it', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('sources-link').click();
  await expect(page).toHaveURL(/\/sources\/$/);
  const cards = page.getByTestId('sources').locator('article');
  expect(await cards.count()).toBeGreaterThanOrEqual(5);
  for (const name of ['NBA.com and WNBA.com statistics', 'ESPN', 'Sleeper', 'The Odds API']) {
    const card = cards.filter({ has: page.locator('h3', { hasText: name }) });
    await expect(card).toHaveCount(1);
    await expect(card.locator('dt', { hasText: 'Published' })).toBeVisible();
  }
  await expect(page.getByTestId('principles').locator('li')).toHaveCount(5);
  await expect(page.getByTestId('retention').locator('li')).toHaveCount(4);
  await expect(page.getByRole('link', { name: 'open an issue' })).toHaveAttribute('href', /github\.com/);
});

test('every page carries a canonical address without the query, Open Graph tags, and the site has robots and a sitemap', async ({ page }) => {
  await page.goto('/streamers/?league=nba');
  await expect(page.locator('head link[rel="canonical"]')).toHaveAttribute('href', /\/streamers\/$/);
  await expect(page.locator('head meta[property="og:title"]')).toHaveAttribute('content', /Streamers · FantasyScout/);
  await expect(page.locator('head meta[property="og:url"]')).toHaveAttribute('content', /\/streamers\/$/);
  await expect(page.locator('head meta[name="twitter:card"]')).toHaveAttribute('content', 'summary');
  const robots = await page.request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain('Sitemap: https://fantasyscout.beronilla.rodeo/sitemap.xml');
  const sitemap = await page.request.get('/sitemap.xml');
  expect(sitemap.status()).toBe(200);
  const xml = await sitemap.text();
  expect(xml).toContain('<loc>https://fantasyscout.beronilla.rodeo/streamers/</loc>');
  expect(xml).toContain('<loc>https://fantasyscout.beronilla.rodeo/</loc>');
  expect(xml).not.toContain('/sql/');
  expect(xml).not.toContain('/p/');
});

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
  const latest = (await (await page.request.get('/data/latest.json')).json()) as { data_as_of: Record<string, string> };
  await expect(page.locator('[data-data-build-id]')).toHaveText('fixture');
  await expect(page.locator('[data-data-as-of]')).toContainText(`WNBA ${latest.data_as_of['wnba']}`);
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

test('a failing data pointer says the data is temporarily unavailable, and a reload tries again', async ({ page }) => {
  // The page chrome and the board island both ask for the pointer: fail every request until the
  // board has shown the failure, then let the reload through.
  let failing = true;
  await page.route('**/data/latest.json', (route) => (failing ? route.fulfill({ status: 503, body: 'down' }) : route.fallback()));
  await page.goto('/');
  const alert = page.getByTestId('data-unavailable');
  await expect(alert).toContainText('temporarily unavailable (HTTP 503)');
  await expect(page.getByText('No data build has been published yet')).toHaveCount(0);
  failing = false;
  await alert.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByTestId('board').locator('tbody tr[data-player]').first()).toBeVisible();
});

test('without any build published, the pages say so', async ({ page }) => {
  await page.route('**/data/latest.json', (route) => route.fulfill({ status: 404, body: 'nope' }));
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('No data build has been published yet');
});

test('streamers shows the week grid and the candidates', async ({ page }) => {
  const season = await leagueInSeason(page);
  test.skip(!season, NO_SEASON);
  await page.goto(`/streamers/?league=${season!.league}`);
  await expect(page.getByTestId('season-note')).toBeVisible();
  const grid = page.getByTestId('week-grid');
  await expect(grid).toBeVisible();
  // The grid reads the fixture's schedule: the first game's home team, home ("v") or away ("@").
  const team = season!.games[0].home_team_tricode;
  const first = season!.games.find((g) => g.home_team_tricode === team || g.away_team_tricode === team)!;
  const matchup = first.home_team_tricode === team ? `v ${first.away_team_tricode}` : `@ ${first.home_team_tricode}`;
  await expect(grid.locator('tbody tr').filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^${team}$`) }) })).toContainText(matchup);
  const rows = page.getByTestId('trending').locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(10);
});

test('streamers shows games per fantasy week for the rest of the season when weeks are left', async ({ page }) => {
  const weeks = (await (await page.request.get('/data/builds/fixture/team_weeks/wnba.json')).json()) as {
    team_abbreviation: string | null;
    team_id: string;
    fantasy_week: string;
    games: number;
    games_left: number;
    is_current_week: boolean;
  }[];
  await page.goto('/streamers/');
  await expect(page.getByTestId('season-note')).toBeVisible();
  if (weeks.length === 0) {
    // The fixture season has no week ahead: the card stays away rather than showing an empty grid.
    await expect(page.getByTestId('weeks-grid')).toHaveCount(0);
    return;
  }
  const grid = page.getByTestId('weeks-grid');
  await expect(grid).toBeVisible();
  const first = weeks[0];
  const team = first.team_abbreviation ?? first.team_id;
  const row = grid.locator('tbody tr').filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^${team}$`) }) });
  // The current week shows what is left of it ("1 of 4"); a later week shows its whole count.
  await expect(row).toContainText(first.is_current_week ? `${first.games_left} of ${first.games}` : String(first.games));
  const current = weeks.find((w) => w.is_current_week);
  if (current) {
    const currentRow = grid.locator('tbody tr').filter({
      has: page.locator('td:first-child', { hasText: new RegExp(`^${current.team_abbreviation ?? current.team_id}$`) }),
    });
    await expect(currentRow.getByTestId('week-left')).toContainText(`${current.games_left} of ${current.games}`);
  }
  await expect(grid.locator('thead th').filter({ hasText: `W${first.fantasy_week.slice(-2)}` })).toBeVisible();
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

test('data health lists each source feed with how fresh it is', async ({ page }) => {
  await page.route('**/health.json', async (route) => {
    const file = (await (await route.fetch()).json()) as Record<string, unknown>;
    await route.fulfill({
      json: {
        ...file,
        feeds: [
          { feed_key: 'nba:espn_news', league: 'nba', feed: 'ESPN headlines', last_landed: '2026-10-29', age_days: 0, max_age_days: 2, status: 'fresh' },
          { feed_key: 'nba:sleeper_trending', league: 'nba', feed: 'Sleeper trending', last_landed: '2026-10-20', age_days: 9, max_age_days: 2, status: 'stale' },
          { feed_key: 'wnba:espn_news', league: 'wnba', feed: 'ESPN headlines', last_landed: null, age_days: null, max_age_days: 2, status: 'never' },
        ],
      },
    });
  });
  await page.goto('/health/');
  const feeds = page.getByTestId('feeds');
  await expect(feeds.locator('tbody tr')).toHaveCount(3);
  await expect(feeds.locator('tbody tr').filter({ hasText: 'Sleeper trending' })).toContainText('Stale');
  await expect(feeds.locator('tbody tr').filter({ hasText: 'WNBA' })).toContainText('Never landed');
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
for (const path of ['/pipeline/', '/schema/', '/sources/']) {
  test(`${path} has no accessibility violations`, async ({ page }) => {
    // With every model open the schema page is large: axe needs longer than the default.
    test.setTimeout(90_000);
    await page.goto(path);
    await expect(page.locator('main h1')).toBeVisible();
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => d.setAttribute('open', '')));
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(results.violations).toEqual([]);
  });
}

test('the notebooks page shows each analysis with its findings for the league', async ({ page }) => {
  // One card per notebook the page knows, each with findings for the league (an analysis short of
  // history says so instead of showing zeros).
  await page.goto('/notebooks/');
  const cards = page.getByTestId('notebooks').locator('section');
  await expect(cards.first()).toBeVisible();
  const notebooks = await cards.count();
  expect(notebooks).toBeGreaterThanOrEqual(6);
  await expect(page.getByTestId('findings').or(page.getByTestId('findings-accumulating'))).toHaveCount(notebooks);
  await expect(page.getByTestId('findings').first()).toContainText('top 30');
  await expect(page.getByTestId('findings-n').first()).toContainText('player-checkpoints');
  await expect(page.getByRole('link', { name: /open the full notebook/i }).first()).toBeVisible();
  await page.goto('/notebooks/?league=nba');
  await expect(page.getByTestId('findings').or(page.getByTestId('findings-accumulating'))).toHaveCount(notebooks);
  await expect(page.getByTestId('findings').nth(1)).toContainText('last-ten production');
  // the teammate-absence study: the uplift is real, the redistribution adds nothing beyond the last ten
  const absence = cards.last();
  await expect(absence).toContainText('Teammate absence');
  await expect(absence.getByTestId('findings')).toContainText('top teammate was out all week');
  await expect(absence.getByTestId('findings-n')).toContainText('affected player-weeks');
});

test('the notebooks page shows the findings of past builds from the history file', async ({ page }) => {
  await page.route('**/data/notebooks/findings-history.json', (route) =>
    route.fulfill({
      json: {
        updated_at: '2026-11-01T12:00:00+00:00',
        notebooks: {
          '01_board_backtest': {
            wnba: [
              { build_id: 'b1', created_at: '2026-10-30T12:00:00+00:00', headline: 'top 30: 0.61 of the pool', facts: {} },
              { build_id: 'b2', created_at: '2026-10-31T12:00:00+00:00', headline: 'top 30: 0.64 of the pool', facts: {} },
              { build_id: 'b3', created_at: '2026-11-01T12:00:00+00:00', headline: 'top 30: 0.66 of the pool', facts: {} },
            ],
          },
        },
      },
    }),
  );
  await page.goto('/notebooks/');
  const history = page.getByTestId('findings-history').first();
  await expect(history).toBeVisible();
  await history.locator('summary').click();
  const rows = history.locator('li');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('2026-11-01');
  await expect(rows.first()).toContainText('0.66');
});

test('the dashboards page explains the workbook and lists the extract', async ({ page }) => {
  await page.goto('/dashboards/');
  await expect(page.getByTestId('tableau-pending').or(page.getByTestId('tableau-embed'))).toBeVisible();
  await expect(page.getByTestId('tableau-files').locator('li')).toHaveCount(3);
});

for (const path of ['/', '/league/', '/streamers/', '/trade/', '/health/', '/p/wnba/1628932/', '/sql/', '/notebooks/', '/dashboards/', '/pipeline/', '/schema/']) {
  test(`${path} has no horizontal scroll on a phone`, async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile project only');
    await page.goto(path);
    await page.locator('main h1, main [data-testid]').first().waitFor();
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow).toBe(false);
  });
}

test('the pipeline page has its diagrams and seven stages numbered as the data-flow processes are', async ({ page }) => {
  await page.goto('/pipeline/');
  const diagrams = ['dfd-collect', 'dfd-publish', 'deploy-collect', 'deploy-publish', 'sequence', 'activity'];
  for (const id of diagrams) {
    await expect(page.getByTestId(`diagram-${id}`).locator('svg')).toBeVisible();
  }
  const stages = ['1. Ingest', '2. Model', '3. Gate', '4. Export', '5. Analyse', '6. Promote', '7. Serve'];
  await expect(page.getByTestId('pipeline-stages').locator(':scope > section > h2')).toHaveText(stages);
  const collect = page.getByTestId('diagram-dfd-collect');
  const publish = page.getByTestId('diagram-dfd-publish');
  for (const s of stages.slice(0, 3)) await expect(collect).toContainText(s);
  for (const s of stages.slice(3)) await expect(publish).toContainText(s);
  // The six source families, each linked to the sources section; other pages through the base path.
  await expect(collect.locator('a[href="#sources"]')).toHaveCount(6);
  await expect(collect.locator('a[href$="/schema/#seeds"]')).toHaveCount(1);
  await expect(page.getByTestId('diagram-deploy-publish')).toContainText('api.login.yahoo.com');
  await expect(page.getByTestId('diagram-sequence')).toContainText('latest.json last');
  await expect(page.getByTestId('diagram-activity')).toContainText('the last five games');
  await expect(page.getByTestId('value-rule')).toContainText('never moves it');
  // Every diagram fits the content column on a desktop.
  if (page.viewportSize()!.width >= 1280) {
    for (const id of diagrams) {
      const region = page.getByTestId(`diagram-${id}`).getByRole('region');
      const fits = await region.evaluate((el) => el.scrollWidth <= el.clientWidth);
      expect(fits, `${id} fits without scrolling`).toBe(true);
    }
  }
  await collect.locator('a[href="#gate"]').first().click();
  await expect(page).toHaveURL(/#gate$/);
});

test('the schema page draws the gold layer by subject area and the lineage, and a model opens to its notes and columns', async ({ page }) => {
  await page.goto('/schema/');
  const areas: Record<string, string[]> = {
    'er-games': ['dim_game', 'fct_player_game', 'mart_player_rolling', 'dim_date'],
    'er-availability': ['fct_availability', 'fct_player_news', 'dim_player'],
    'er-schedule': ['mart_schedule_upcoming', 'dim_team'],
    'er-fantasy': ['mart_board', 'mart_streamers', 'fct_market_value'],
  };
  for (const [id, names] of Object.entries(areas)) {
    const er = page.getByTestId(`diagram-${id}`);
    await expect(er.locator('svg')).toBeVisible();
    for (const name of names) await expect(er).toContainText(name);
  }
  // Unplayed games are not in dim_game, and dim_player is joined to its current stint.
  await expect(page.getByTestId('diagram-er-schedule').locator('svg')).not.toContainText('dim_game');
  await expect(page.getByTestId('diagram-er-availability')).toContainText('is_current');
  await expect(page.getByTestId('diagram-er-games')).toContainText('player_game_sk');
  // Every diagram but the lineage fits the content column on a desktop.
  if (page.viewportSize()!.width >= 1280) {
    for (const id of Object.keys(areas)) {
      const region = page.getByTestId(`diagram-${id}`).getByRole('region');
      const fits = await region.evaluate((el) => el.scrollWidth <= el.clientWidth);
      expect(fits, `${id} fits without scrolling`).toBe(true);
    }
  }
  const lineage = page.getByTestId('diagram-lineage');
  await expect(lineage.locator('a[href="#m-mart_board"]')).toHaveCount(1);
  await expect(lineage).toContainText('espn/summary');

  const bronze = page.locator('#m-espn_summary_players');
  await bronze.locator('summary').click();
  await expect(bronze.getByTestId('landing')).toContainText('landing/espn/summary');
  await expect(bronze).toContainText('values stay text until silver');
  const fact = page.locator('#m-fct_player_game');
  await fact.locator('summary').click();
  await expect(fact.getByTestId('grain')).toContainText('One row per league, game_id and player_id');
  await expect(fact.getByTestId('exported')).toContainText('players/<league>/<player_id>.json');
  await expect(fact.getByTestId('coverage')).toContainText(/\d+\/\d+ described/);
  await expect(page.locator('#m-fct_market_value').getByTestId('unit-tests')).toContainText('market_value_ranks');
  await expect(page.getByTestId('unit-tests-list').locator('tbody tr')).not.toHaveCount(0);
  await expect(page.locator('#seed-category_config')).toContainText('only the export reads it');
  for (const layer of ['bronze', 'silver', 'gold', 'ops']) {
    await expect(page.getByTestId(`layer-${layer}`).getByTestId('model').first()).toBeVisible();
  }
  const board = page.locator('#m-mart_board');
  await board.locator('summary').click();
  await expect(board).toContainText('value above replacement');
  await expect(board.locator('table')).toContainText('value_total');
  await expect(page.getByTestId('checks-list').locator('tbody tr').first()).toBeVisible();
});

test('the schema page filters models by name or column, and opens or closes them all', async ({ page }) => {
  await page.goto('/schema/');
  const filter = page.getByLabel('Filter models and columns');
  await filter.fill('mart_board');
  await expect(page.locator('details[data-model]:visible')).toHaveCount(1);
  await expect(page.getByTestId('layer-bronze')).toBeHidden();
  await filter.fill('opponent_team_sk');
  const match = page.locator('details[data-model]:visible');
  await expect(match).toHaveCount(1);
  await expect(match).toHaveAttribute('open', '');
  await expect(match.locator('tbody tr:visible')).toHaveCount(1);
  await expect(page.getByRole('status')).toContainText('1 of');
  await filter.fill('');
  await expect(page.locator('details[data-model][open]')).toHaveCount(0);
  const all = await page.locator('details[data-model]').count();
  await page.getByRole('button', { name: 'Expand all' }).click();
  await expect(page.locator('details[data-model][open]')).toHaveCount(all);
  await page.getByRole('button', { name: 'Collapse all' }).click();
  await expect(page.locator('details[data-model][open]')).toHaveCount(0);
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
    // A little to the right: the table is only a little wider than its region on a desktop, and
    // re-sorting can change the rows shown, so a large offset would be clamped differently.
    await region.evaluate((el) => el.scrollTo({ top: 400, left: 20 }));
    const before = await region.evaluate((el) => [el.scrollTop, el.scrollLeft]);
    // A tap on a header already on screen: dispatch the click so the test itself does not scroll.
    await table.locator('thead th button').nth(4).dispatchEvent('click');
    await page.waitForTimeout(200);
    const after = await region.evaluate((el) => [el.scrollTop, el.scrollLeft]);
    expect(after).toEqual(before);
  });
}

test('/trade/ has no accessibility violations once a trade is on the page', async ({ page }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/wnba.json')).json()) as { full_name: string; team_abbreviation: string; position: string }[];
  const label = (p: (typeof board)[number]) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
  await page.goto('/trade/');
  await page.getByLabel('Add a player you give').fill(label(board[0]!));
  await page.getByLabel('Add a player you get').fill(label(board[1]!));
  await expect(page.locator('main table').first()).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations).toEqual([]);
});

test('every page but the Board sits under a nav header, and the header opens on its pages', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav.getByRole('link', { name: 'Board' })).toHaveAttribute('href', '/');
  for (const [header, items] of [
    ['tools', ['Streamers', 'Trade']],
    ['analysis', ['Notebooks', 'Dashboards']],
    ['platform', ['Data Health', 'Pipeline', 'Schema', 'Docs']],
    ['coming-soon', ['League', 'SQL console']],
  ] as const) {
    const group = page.getByTestId(`nav-${header}`);
    await expect(group).not.toHaveAttribute('open', '');
    await group.locator('summary').click();
    for (const item of items) await expect(group.getByRole('link', { name: item, exact: true })).toBeVisible();
  }
  // Opening one header closes the others, and a click elsewhere closes them all.
  await expect(page.getByTestId('nav-tools')).not.toHaveAttribute('open', '');
  await expect(page.getByTestId('nav-coming-soon')).toHaveAttribute('open', '');
  await page.locator('main h1').click();
  await expect(page.getByTestId('nav-coming-soon')).not.toHaveAttribute('open', '');
  // The header of the current page is marked, not opened over the page.
  await page.goto('/trade/');
  const tools = page.getByTestId('nav-tools');
  await expect(tools).toHaveAttribute('data-current', 'true');
  await expect(tools).not.toHaveAttribute('open', '');
  await tools.locator('summary').click();
  await expect(tools.getByRole('link', { name: 'Trade' })).toHaveAttribute('aria-current', 'page');
  await page.goto('/league/');
  await expect(page.getByTestId('nav-coming-soon')).toHaveAttribute('data-current', 'true');
});

test('on a phone, tapping the Yahoo bookmark link copies its code and shows the steps', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'the clipboard is granted on chromium');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/league/?league=nba');
  const link = page.getByTestId('yahoo-bookmarklet-link');
  await expect(link).toHaveAttribute('href', /^javascript:/);
  await link.click();
  await expect(page.getByTestId('yahoo-copied')).toContainText(/Code copied|Copy the code/);
  await expect(page.getByTestId('yahoo-bookmarklet')).toContainText('Phone or tablet');
  await expect(page).toHaveURL(/league/);
});

test('the Yahoo bookmarklet reads a league\u2019s rosters in the browser and the League page imports them', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one engine is enough for the bookmarklet');
  // The fixture build's NBA board is empty: serve the WNBA board for it, and the Yahoo fixture names come from there.
  await page.route('**/board/nba.json', (route) => route.fulfill({ path: 'tests/fixtures/data/builds/fixture/board/wnba.json' }));
  await page.goto('/league/?league=nba');
  const link = page.getByTestId('yahoo-bookmarklet-link');
  await expect(link).toHaveAttribute('href', /^javascript:/);
  const code = (await link.getAttribute('href')) ?? '';
  expect(code.startsWith('javascript:')).toBe(true);
  // A Yahoo-shaped league: the fixture league page links its teams, each team page lists its players.
  await page.route(/\/nba\/12345\/(\d+)$/, (route) => route.fulfill({ path: `tests/fixtures/data/yahoo/team-${route.request().url().split('/').pop()}.html` }));
  await page.goto('/data/yahoo/league.html');
  await page.evaluate(code.slice('javascript:'.length));
  await expect(page).toHaveURL(/\/league\/\?league=nba$/);
  await expect(page.getByTestId('team-card')).toHaveCount(4);
  await expect(page.getByRole('status')).toContainText('Imported 4 teams from Yahoo: 12 players matched, 4 on the IL.');
  // IL players are owned but take no roster spot, and the IL can be toggled by hand.
  await expect(page.getByRole('button', { name: /^Injured list:/, pressed: true })).toHaveCount(4);
  await expect(page.getByText(/8 of \d+ roster spots filled \(4 more on the IL\)/)).toBeVisible();
  await page.getByRole('button', { name: /^Injured list:/, pressed: true }).first().click();
  await expect(page.getByRole('button', { name: /^Injured list:/, pressed: true })).toHaveCount(3);
  await expect(page.getByText(/9 of \d+ roster spots filled \(3 more on the IL\)/)).toBeVisible();
  await expect(page.getByTestId('team-card').nth(1).getByLabel('Name of team 2')).toHaveValue('Rim Reapers');
  await expect(page.getByTestId('team-card').nth(1).getByRole('radio')).toBeChecked();
  await expect(page.getByTestId('team-card').nth(0).getByTestId('roster').locator('li')).toHaveCount(3);
});

test('the Trade page values both sides for the rest of the season and gives a verdict', async ({ page }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/wnba.json')).json()) as { full_name: string; team_abbreviation: string; position: string }[];
  const label = (p: (typeof board)[number]) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
  await page.goto('/trade/');
  await expect(page.getByTestId('trade-no-league')).toBeVisible();
  // Give the second-best player, get the two best: the trade favours the manager.
  await page.getByLabel('Add a player you give').fill(label(board[1]!));
  await page.getByLabel('Add a player you get').fill(label(board[0]!));
  await page.getByLabel('Add a player you get').fill(label(board[2]!));
  await expect(page.getByTestId('picked-give').locator('li')).toHaveCount(1);
  await expect(page.getByTestId('picked-get').locator('li')).toHaveCount(2);
  await expect(page.getByTestId('trade-verdict')).toContainText('Favours you');
  await expect(page.getByTestId('trade-spots')).toContainText('you would drop 1');
  await expect(page.getByTestId('trade-players').locator('tbody tr')).toHaveCount(5);
  await expect(page.getByTestId('trade-categories').locator('tbody tr')).toHaveCount(9);
  // Removing a player from a side updates the verdict.
  await page.getByTestId('picked-get').getByRole('button', { name: board[0]!.full_name }).click();
  await expect(page.getByTestId('picked-get').locator('li')).toHaveCount(1);
  // Without rosters, players worth about the same as the target are offered; one tap puts one on the other side.
  await page.getByTestId('picked-get').getByRole('button', { name: board[2]!.full_name }).click();
  const nearest = page.getByTestId('trade-nearest');
  await expect(nearest.locator('li')).toHaveCount(8);
  await nearest.getByRole('button').first().click();
  await expect(page.getByTestId('picked-get').locator('li')).toHaveCount(1);
});

test("with league rosters set up, the Trade page picks from them and shows the manager's team before and after", async ({ page }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/wnba.json')).json()) as { full_name: string; team_abbreviation: string; position: string }[];
  const label = (p: (typeof board)[number]) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
  await page.goto('/league/');
  await page.getByLabel('Teams in the league').fill('4');
  // The manager holds the top eight; the partner holds the ninth, so some package of the
  // manager's players lands within 15% of it.
  for (const p of board.slice(0, 8)) await page.getByLabel('Add a player to Team 1').fill(label(p));
  await page.getByLabel('Add a player to Team 2').fill(label(board[8]!));
  await page.goto('/trade/');
  await expect(page.getByTestId('trade-no-league')).toBeHidden();
  await expect(page.getByTestId('roster-give').locator('li')).toHaveCount(8);
  await expect(page.getByTestId('roster-get').locator('li')).toHaveCount(1);
  // Asking for a partner's player suggests packages from the manager's roster that make it about even.
  await page.getByTestId('roster-get').getByRole('checkbox').first().check();
  const suggestions = page.getByTestId('trade-suggestions');
  await expect(suggestions.locator('tbody tr').first()).toBeVisible();
  await expect(suggestions.locator('thead')).toContainText('Your ranks');
  await suggestions.getByRole('button', { name: 'Use this trade' }).first().click();
  await expect(page.getByTestId('picked-give').locator('li').first()).toBeVisible();
  await expect(page.getByTestId('trade-verdict')).toBeVisible();
  const cats = page.getByTestId('trade-categories');
  await expect(cats.locator('thead')).toContainText('Your team before');
  await expect(cats.locator('thead')).toContainText('Rank of 2');
  await expect(cats.locator('tbody tr')).toHaveCount(9);
});

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

test('with rosters set up, the board recommends roster upgrades from the available players and applies one', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  const rows = board.locator('tbody tr[data-player]');
  await expect(rows.first()).toBeVisible();
  // The best player on the board and one well down it: only the second can be upgraded.
  const [best, weak] = await Promise.all([0, 40].map((i) => rows.nth(i).locator('a').first().innerText()));
  await page.goto('/league/');
  const cards = page.getByTestId('team-card');
  await cards.nth(0).getByText('Paste a roster').click();
  await page.getByLabel('Paste names for Team 1', { exact: true }).fill(`${best}\n${weak}`);
  await cards.nth(0).getByRole('button', { name: 'Add pasted players' }).click();
  await expect(cards.nth(0).getByTestId('paste-result')).toContainText('Added 2');
  await page.goto('/');
  const upgrades = page.getByTestId('upgrades');
  await expect(upgrades).toBeVisible();
  // The verdict names the weak player, and the My team view tags that row and not the best player's.
  await expect(upgrades.getByTestId('roster-verdict')).toContainText('1 of your 2 players can be upgraded');
  await expect(upgrades.getByTestId('roster-verdict')).toContainText(weak);
  await page.getByRole('radio', { name: 'My team' }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: weak }).getByTestId('replace-tag')).toBeVisible();
  await expect(rows.filter({ hasText: best }).getByTestId('replace-tag')).toHaveCount(0);
  const first = upgrades.getByTestId('upgrade').first();
  await expect(first).toContainText(`for ${weak}`);
  await expect(first).toContainText('rest of season');
  await first.getByRole('button', { name: 'Apply' }).click();
  await expect(upgrades.getByTestId('upgrade').filter({ hasText: `for ${weak}` })).toHaveCount(0);
  await expect(rows).toHaveCount(2);
  await expect(board.locator('tbody')).not.toContainText(weak);
  await expect(page.getByTestId('league-bar')).toContainText('Team 1 (2/');
});

test('a roster of the two best players is told it is optimized as is', async ({ page }) => {
  await page.goto('/');
  const rows = page.getByTestId('board').locator('tbody tr[data-player]');
  await expect(rows.first()).toBeVisible();
  const [first, second] = await Promise.all([0, 1].map((i) => rows.nth(i).locator('a').first().innerText()));
  await page.goto('/league/');
  const cards = page.getByTestId('team-card');
  await cards.nth(0).getByText('Paste a roster').click();
  await page.getByLabel('Paste names for Team 1', { exact: true }).fill(`${first}\n${second}`);
  await cards.nth(0).getByRole('button', { name: 'Add pasted players' }).click();
  await expect(cards.nth(0).getByTestId('paste-result')).toContainText('Added 2');
  await page.goto('/');
  const review = page.getByTestId('upgrades');
  await expect(review.getByTestId('roster-verdict')).toContainText('optimized as is');
  await expect(review.getByTestId('roster-verdict')).toContainText('Weakest spot');
  await expect(review.getByTestId('upgrade')).toHaveCount(0);
  await page.getByRole('radio', { name: 'My team' }).click();
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId('replace-tag')).toHaveCount(0);
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
  const season = await leagueInSeason(page);
  test.skip(!season, NO_SEASON);
  // The fixture build predates the lines: give every game one, home favoured by 4.5 in a 160 total.
  await page.route(`**/schedule/${season!.league}.json`, async (route) => {
    const games = (await (await route.fetch()).json()) as Record<string, unknown>[];
    const lined = games.map((g) => ({ ...g, home_spread: -4.5, over_under: 160, home_implied_points: 82.25, away_implied_points: 77.75 }));
    await route.fulfill({ json: lined });
  });
  await page.goto(`/streamers/?league=${season!.league}`);
  const grid = page.getByTestId('week-grid');
  await expect(grid.getByTestId('implied-points').first()).toHaveText(/^(82|78) pts$/);
  const team = season!.games[0].home_team_tricode;
  const row = grid.locator('tbody tr').filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^${team}$`) }) });
  await expect(row.locator('td[title]').first()).toHaveAttribute('title', new RegExp(`^Over/under 160, \\w+ -4\\.5: ${team} implied (82\\.25|77\\.75) points`));
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
      { lineup_role: 'inactive', lineup_confirmed: true, injury_group: null },
      { lineup_role: 'inactive', lineup_confirmed: true, injury_group: 'out', injury_status: 'Out' },
    ];
    await route.fulfill({ json: rows.map((r, i) => ({ ...r, ...(roles[i] ?? {}) })) });
  });
  await page.goto('/streamers/');
  const table = page.getByTestId('trending');
  await expect(table.getByTestId('lineup-tag').filter({ hasText: /^START$/ })).toHaveCount(1);
  await expect(table.getByTestId('lineup-tag').filter({ hasText: 'START?' })).toHaveCount(1);
  // Inactive reads as OUT for the day; a player already tagged OUT on the injury report gets no second tag.
  await expect(table.getByTestId('lineup-tag').filter({ hasText: /^OUT / })).toHaveCount(1);
  await expect(table.getByTestId('lineup-tag').filter({ hasText: /^OUT / })).toHaveAttribute('title', /listed the player inactive/);
  await page.getByTestId('tag-legend').locator('summary').click();
  await expect(page.getByTestId('tag-legend')).toContainText('not in uniform');
  await page.getByLabel('Starting today').check();
  await expect(table.locator('tbody tr')).toHaveCount(2);
});

test('streamers show waiver heat from Sleeper, filter to players being added, and credit Sleeper', async ({ page }) => {
  // The fixture build predates Sleeper: one player being added, one being dropped.
  await page.route('**/streamers/wnba.json', async (route) => {
    const rows = (await (await route.fetch()).json()) as Record<string, unknown>[];
    const heat = [
      { sleeper_adds: 26552, sleeper_drops: 120, waiver_trend: 'adding' },
      { sleeper_adds: 0, sleeper_drops: 7371, waiver_trend: 'dropping' },
    ];
    await route.fulfill({ json: rows.map((r, i) => ({ ...r, ...(heat[i] ?? {}) })) });
  });
  await page.goto('/streamers/');
  const table = page.getByTestId('trending');
  await expect(table.getByTestId('waiver-heat').filter({ hasText: '+26.4k' })).toHaveCount(1);
  await expect(table.getByTestId('waiver-heat').filter({ hasText: '−7.4k' })).toHaveCount(1);
  await expect(table.getByTestId('waiver-heat').first()).toHaveAttribute('title', /Sleeper leagues added the player/);
  await page.getByLabel('Being added on Sleeper').check();
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Sleeper', exact: true }).first()).toHaveAttribute('href', 'https://sleeper.com');
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

test("a player's page shows the board's outlook and the team's next games", async ({ page }) => {
  // The schedule answers only once the player file has named the team.
  let named: (id: string) => void = () => {};
  const teamId = new Promise<string>((resolve) => (named = resolve));
  await page.route(/\/players\/wnba\/[^/]+\.json$/, async (route) => {
    const file = (await (await route.fetch()).json()) as { team: { team_id: string }; board: Record<string, unknown> | null };
    named(file.team.team_id);
    await route.fulfill({
      json: { ...file, board: { ...(file.board ?? { rank_total: 3 }), market_rank: 7, ownership_bucket: 'most', lineup_role: 'starter', lineup_confirmed: true } },
    });
  });
  await page.route('**/schedule/wnba.json', async (route) => {
    const id = await teamId;
    await route.fulfill({
      json: [
        { game_id: 'g1', game_date: '2026-11-02', game_type: 'regular', home_team_id: id, home_team_tricode: 'HOM', away_team_id: '9', away_team_tricode: 'AWY', home_implied_points: 84.5, home_back_to_back: true },
        { game_id: 'g2', game_date: '2026-11-03', game_type: 'regular', home_team_id: '8', home_team_tricode: 'XYZ', away_team_id: '7', away_team_tricode: 'QRS' },
      ],
    });
  });
  await page.goto('/p/wnba/1628932/');
  const outlook = page.getByTestId('player-outlook');
  await expect(outlook).toContainText('Board rank (default league)');
  await expect(outlook).toContainText('#7');
  await expect(outlook).toContainText('70% or more of ESPN leagues');
  await expect(outlook).toContainText('Starting (confirmed)');
  await expect(page.getByTestId('projected-line')).toContainText('PTS');
  const next = page.getByTestId('next-games');
  await expect(next.locator('tbody tr')).toHaveCount(1);
  await expect(next).toContainText('vs AWY');
  await expect(next).toContainText('84.5');
  await expect(next).toContainText('Back-to-back');
});

test("a player's page lists ESPN's headlines about them, flagged and linked to ESPN", async ({ page }) => {
  await page.route(/\/players\/wnba\/[^/]+\.json$/, async (route) => {
    const file = (await (await route.fetch()).json()) as Record<string, unknown>;
    await route.fulfill({
      json: {
        ...file,
        news: [
          { published_date: '2026-10-29', headline: 'Guard (ankle) to miss Game 7', url: 'https://www.espn.com/wnba/story/_/id/1', news_flag: 'injury' },
          { published_date: '2026-10-27', headline: 'Guard carries the team in Game 5', url: 'https://www.espn.com/wnba/story/_/id/2', news_flag: null },
        ],
      },
    });
  });
  await page.goto('/p/wnba/1628932/');
  const news = page.getByTestId('player-news');
  await expect(news.locator('li')).toHaveCount(2);
  await expect(news.locator('li').first()).toContainText('Injury');
  await expect(news.getByRole('link', { name: 'Guard (ankle) to miss Game 7' })).toHaveAttribute('href', 'https://www.espn.com/wnba/story/_/id/1');
});

test('the streamers week grid marks the second night of a back-to-back, with travel in the tooltip', async ({ page }) => {
  const season = await leagueInSeason(page);
  test.skip(!season, NO_SEASON);
  await page.route(`**/schedule/${season!.league}.json`, async (route) => {
    const games = (await (await route.fetch()).json()) as Record<string, unknown>[];
    // The live schedule carries its own back-to-backs: one game gets the marker, every other none.
    await route.fulfill({
      json: games.map((g, i) => ({
        ...g,
        home_back_to_back: false,
        away_back_to_back: i === 0,
        away_miles_travelled: i === 0 ? 1203 : null,
        at_altitude: false,
      })),
    });
  });
  await page.goto(`/streamers/?league=${season!.league}`);
  const grid = page.getByTestId('week-grid');
  const marker = grid.getByTestId('back-to-back');
  await expect(marker).toHaveCount(1);
  await expect(marker.locator('xpath=..')).toHaveAttribute('title', /Second night of a back-to-back: rest and minutes risk\. 1203 miles from the previous game/);
});

test("the streamers week grid names a game's crew chief and the crew's tendency in the tooltip", async ({ page }) => {
  const season = await leagueInSeason(page);
  test.skip(!season, NO_SEASON);
  await page.route(`**/schedule/${season!.league}.json`, async (route) => {
    const games = (await (await route.fetch()).json()) as Record<string, unknown>[];
    const crewed = { crew_chief: 'Pat Fraher', crew_games: 120, crew_fouls_delta: 1.43, crew_fta_delta: 2.08, crew_pace_delta: -0.61 };
    // The live schedule names crews once the league posts them: one game gets this crew, every other none.
    const uncrewed = { crew_chief: null, crew_games: null, crew_fouls_delta: null, crew_fta_delta: null, crew_pace_delta: null };
    await route.fulfill({ json: games.map((g, i) => ({ ...g, ...(i === 0 ? crewed : uncrewed) })) });
  });
  await page.goto(`/streamers/?league=${season!.league}`);
  const grid = page.getByTestId('week-grid');
  const cells = grid.locator('td[title*="Crew chief"]');
  await expect(cells).toHaveCount(2); // both sides of the one game
  await expect(cells.first()).toHaveAttribute('title', /Crew chief Pat Fraher \(fouls \+1\.4, FTA \+2\.1, pace -0\.6 a game vs average\)/);
});

test("a player's next games name the crew chief once the league posts the crew", async ({ page }) => {
  let named: (id: string) => void = () => {};
  const teamId = new Promise<string>((resolve) => (named = resolve));
  await page.route(/\/players\/wnba\/[^/]+\.json$/, async (route) => {
    const file = (await (await route.fetch()).json()) as { team: { team_id: string } };
    named(file.team.team_id);
    await route.fulfill({ json: file });
  });
  await page.route('**/schedule/wnba.json', async (route) => {
    const id = await teamId;
    await route.fulfill({
      json: [
        { game_id: 'g1', game_date: '2026-11-02', game_type: 'regular', home_team_id: id, home_team_tricode: 'HOM', away_team_id: '9', away_team_tricode: 'AWY', crew_chief: 'Tony Brothers', crew_games: 0, crew_fta_delta: null },
        { game_id: 'g2', game_date: '2026-11-04', game_type: 'regular', home_team_id: '9', home_team_tricode: 'AWY', away_team_id: id, away_team_tricode: 'HOM', crew_chief: 'Zach Zarba', crew_games: 150, crew_fouls_delta: -0.97, crew_fta_delta: -1.2, crew_pace_delta: 0.4 },
        { game_id: 'g3', game_date: '2026-11-06', game_type: 'regular', home_team_id: id, home_team_tricode: 'HOM', away_team_id: '9', away_team_tricode: 'AWY' },
      ],
    });
  });
  await page.goto('/p/wnba/1628932/');
  const next = page.getByTestId('next-games');
  await expect(next.locator('tbody tr')).toHaveCount(3);
  await expect(next.locator('tbody tr').nth(0)).toContainText('Crew chief Tony Brothers');
  await expect(next.locator('tbody tr').nth(1)).toContainText('Crew chief Zach Zarba (fouls -1.0, FTA -1.2, pace +0.4 a game vs average)');
  await expect(next.locator('tbody tr').nth(2)).not.toContainText('Crew chief');
});

test('streamers sort by window value while games are scheduled', async ({ page }) => {
  const season = await leagueInSeason(page);
  test.skip(!season, NO_SEASON);
  await page.goto(`/streamers/?league=${season!.league}`);
  const header = page.getByTestId('trending').locator('th', { hasText: 'Window value' });
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  const values = await page
    .getByTestId('trending')
    .locator('tbody tr')
    .evaluateAll((trs) => trs.slice(0, 5).map((tr) => tr.textContent ?? ''));
  expect(values.length).toBeGreaterThan(0);
});

test("streamers follow the league's scoring and size", async ({ page }) => {
  await page.route('**/streamers/wnba.json', async (route) => {
    const rows = (await (await route.fetch()).json()) as Record<string, unknown>[];
    await route.fulfill({ json: rows.map((r, i) => (i === 0 ? { ...r, last_10_z_total: 5, last_10_z_turnovers: -2 } : r)) });
  });
  await page.goto('/league/');
  await page.getByLabel('Teams in the league').fill('6');
  await page.getByLabel('Scoring').selectOption('cats8');
  await page.goto('/streamers/');
  const table = page.getByTestId('trending');
  // 8 categories: turnovers leave the last-ten value (5 minus -2)
  await expect(table.locator('tbody tr').filter({ hasText: '7.00' })).toHaveCount(1);
  await expect(page.getByLabel('Likely available').locator('option', { hasText: 'your league: 6 ×' })).toHaveCount(1);
  await page.goto('/league/');
  await page.getByLabel('Scoring').selectOption('points');
  await page.goto('/streamers/');
  await expect(page.getByTestId('points-note')).toBeVisible();
});

test("an injured player's tooltip says how many games players listed like this went on to miss", async ({ page }) => {
  await page.route('**/board/wnba.json', async (route) => {
    const rows = (await (await route.fetch()).json()) as Record<string, unknown>[];
    await route.fulfill({
      json: rows.map((r, i) =>
        i === 0 ? { ...r, injury_group: 'questionable', injury_status: 'Questionable', injury_source: 'espn', expected_games_missed: 1.43, expected_return: null } : r,
      ),
    });
  });
  await page.goto('/');
  const tag = page.getByTestId('board').getByTestId('injury-tag').first();
  await expect(tag).toHaveAttribute('title', /missed 1\.4 games on average/);
});

test('the board and streamers show a fresh headline flag, the fantasy week and the ESPN ownership trend', async ({ page }) => {
  await page.route('**/board/wnba.json', async (route) => {
    const rows = (await (await route.fetch()).json()) as Record<string, unknown>[];
    await route.fulfill({
      json: rows.map((r, i) =>
        i === 0 ? { ...r, news_flag: 'return', news_headline: 'Guard returns from ankle injury', news_date: '2026-10-29', games_this_week: 3 } : r,
      ),
    });
  });
  await page.goto('/');
  const board = page.getByTestId('board');
  const tag = board.getByTestId('news-tag');
  await expect(tag).toHaveCount(1);
  await expect(tag).toHaveText('BACK');
  await expect(tag).toHaveAttribute('title', /Guard returns from ankle injury/);

  const season = await leagueInSeason(page);
  test.skip(!season, NO_SEASON);
  await page.route(`**/streamers/${season!.league}.json`, async (route) => {
    const rows = (await (await route.fetch()).json()) as Record<string, unknown>[];
    const extra = [
      { ownership_trend: 'rising', injury_group: 'questionable', injury_status: 'Questionable', injury_type: 'Ankle', injury_source: 'espn' },
      { ownership_trend: 'falling' },
    ];
    // Three rows, so the two tagged ones are on the page whatever the sort puts first; no Sleeper
    // heat, so the filter is the ESPN one.
    await route.fulfill({
      json: rows.slice(0, 3).map((r, i) => ({ ...r, waiver_trend: null, ...(extra[i] ?? { ownership_trend: null }) })),
    });
  });
  await page.goto(`/streamers/?league=${season!.league}`);
  const table = page.getByTestId('trending');
  await expect(table.getByTestId('trend-tag')).toHaveCount(2);
  await expect(table.getByTestId('injury-tag').first()).toHaveAttribute('title', /Ankle/);
  await page.getByLabel('Rising in ESPN leagues').check();
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(page.getByRole('radio', { name: /This week/ })).toBeVisible();
});

test("the board sets the fantasy market's rank beside its own, and streamers can leave out widely rostered players", async ({ page }) => {
  await page.route('**/board/wnba.json', async (route) => {
    const rows = (await (await route.fetch()).json()) as Record<string, unknown>[];
    await route.fulfill({ json: rows.map((r, i) => (i === 0 ? { ...r, market_rank: 9, market_gap: 99, ownership_bucket: 'most' } : r)) });
  });
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('thead')).toContainText('Mkt');
  await expect(board.locator('thead')).toContainText('vs Mkt');
  const mkt = board.getByTestId('market-rank').filter({ hasText: /^9$/ });
  await expect(mkt).toHaveAttribute('title', 'Rostered in most ESPN leagues');
  await expect(board.locator('tbody tr[data-player]').first().locator('td').nth(-2)).toHaveText(/\d/);
  // The gap is the market's rank minus this board's rank under the league's settings, not the export's default-league gap.
  const rows = board.locator('tbody tr[data-player]');
  const at = await rows.evaluateAll((trs) => trs.findIndex((tr) => tr.querySelector('[data-testid="market-rank"]')?.textContent === '9'));
  expect(at).toBeGreaterThanOrEqual(0);
  const gap = 9 - (at + 1);
  await expect(rows.nth(at).getByTestId('market-gap')).toHaveText(gap > 0 ? `+${gap}` : String(gap));

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

test('data health lists the recent build runs with their timings and gate', async ({ page }) => {
  await page.route('**/health.json', async (route) => {
    const file = (await (await route.fetch()).json()) as Record<string, unknown>;
    const light = {
      run_id: '41', run_url: 'https://github.com/o/r/actions/runs/41', run_at: '2026-11-01T16:05:00+00:00', finished_at: '2026-11-01T16:30:00+00:00',
      event: 'workflow_run', trigger_run_url: null, build_id: '20261101T162100Z-abcdef1', selected: 'tag:feed_reports+ path:models/ops', light: true,
      outcome: 'success', gate_passed: true, gate_reason: 'all error-severity checks passed', error_checks: 0, warn_checks: 2,
      queue_seconds: 300, build_seconds: 840, total_seconds: 1500,
    };
    const blocked = {
      run_id: '40', run_url: '', run_at: null, finished_at: '2026-11-01T02:30:00+00:00', event: 'schedule', trigger_run_url: null, build_id: null,
      selected: null, light: false, outcome: 'failure', gate_passed: false, gate_reason: 'blocked by: assert_completeness', error_checks: 1,
      warn_checks: 0, queue_seconds: null, build_seconds: null, total_seconds: null,
    };
    await route.fulfill({ json: { ...file, builds: [light, blocked] } });
  });
  await page.goto('/health/');
  const rows = page.getByTestId('builds').locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('light');
  await expect(rows.first()).toContainText('passed');
  await expect(rows.first()).toContainText('5.0 min');
  await expect(rows.first().getByRole('link', { name: '41' })).toHaveAttribute('href', /runs\/41$/);
  await expect(rows.nth(1)).toContainText('blocked');
  await expect(rows.nth(1)).toContainText('failure');
});

test('data health names the requests the ingest could not land', async ({ page }) => {
  await page.route('**/health.json', async (route) => {
    const file = (await (await route.fetch()).json()) as Record<string, unknown>;
    const failures = [
      { run_id: 'abc123def456', source: 'stats', league: 'nba', season: '2026-27', started_at: '2026-11-01T09:20:00+00:00', kind: 'failed', endpoint: 'boxscoretraditionalv3', request_key: '0022600123', reason: 'RuntimeError: HTTP 500' },
      { run_id: 'abc123def456', source: 'espn', league: 'wnba', season: '2026', started_at: '2026-11-01T09:15:00+00:00', kind: 'missing', endpoint: 'summary', request_key: '401736812', reason: 'HTTP 404' },
    ];
    await route.fulfill({ json: { ...file, fetch_failures: failures } });
  });
  await page.goto('/health/');
  const rows = page.getByTestId('fetch-failures').locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('stats NBA');
  await expect(rows.first()).toContainText('failed');
  await expect(rows.first()).toContainText('0022600123');
  await expect(rows.nth(1)).toContainText('missing');
});

