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

test('the board and streamers read their column-wise files from the stable address, not the row files (#535)', async ({ page }) => {
  await page.unroute('**/*.columns.json');
  const rowFiles: string[] = [];
  const columnFiles: string[] = [];
  page.on('request', (r) => {
    if (/\/(board|streamers)\/(nba|wnba)\.json$/.test(r.url())) rowFiles.push(r.url());
    if (/\/current\/(board|streamers)\/(nba|wnba)\.columns\.json$/.test(r.url())) columnFiles.push(r.url());
  });
  const rows = (await (await page.request.get('/data/builds/fixture/board/nba.json')).json()) as { player_id: string }[];
  await page.goto('/?league=nba');
  await expect(page.locator('head link[rel="preload"][href$="/data/current/board/nba.columns.json"]')).toHaveCount(1);
  const board = page.getByTestId('board').locator('tbody tr[data-player]');
  await expect(board.first()).toBeVisible();
  // every player the page shows is a player of the row file
  const shown = await board.evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-player')));
  const ids = new Set(rows.map((r) => r.player_id));
  expect(shown.length).toBeGreaterThan(10);
  expect(shown.every((id) => id && ids.has(id))).toBe(true);
  const builds: string[] = [];
  page.on('request', (r) => {
    if (/\/data\/builds\//.test(r.url())) builds.push(r.url());
  });
  await page.goto('/streamers/?league=nba');
  await expect(page.getByTestId('trending').locator('tbody tr').first()).toBeVisible();
  // Streamers preloads every file it reads from the head and reads them all at the stable address (#562).
  for (const file of ['streamers/nba.columns.json', 'schedule/nba.json', 'dim_team.json', 'transactions/nba.json', 'team_weeks/nba.json']) {
    await expect(page.locator(`head link[rel="preload"][href$="/data/current/${file}"]`), file).toHaveCount(1);
  }
  expect(builds).toEqual([]);
  // the first rows paint first, then the rest of the page of rows
  await expect(page.getByTestId('trending').locator('tbody tr')).not.toHaveCount(10);
  expect(columnFiles.some((u) => u.includes('/board/'))).toBe(true);
  expect(columnFiles.some((u) => u.includes('/streamers/'))).toBe(true);
  expect(rowFiles).toEqual([]);
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

test('the methodology page lists every registered number with how it was set and the issue that tests it', async ({ page }) => {
  await page.goto('/methodology/');
  const params = page.getByTestId('parameters').locator('article');
  expect(await params.count()).toBeGreaterThanOrEqual(30);
  // A measured projection weight and an assumed trade threshold, each linked to its backtest.
  const recency = page.locator('[data-param="projection.fantasy_recency"]');
  await expect(recency).toHaveAttribute('data-status', 'measured');
  await expect(recency).toContainText('1, 0.25, 0.08');
  await expect(recency.getByRole('link', { name: '#754' })).toHaveAttribute('href', /\/issues\/754$/);
  const limits = page.locator('[data-param="trade.value_limits"]');
  await expect(limits).toHaveAttribute('data-status', 'assumed');
  await expect(limits.getByRole('link', { name: '#756' })).toBeVisible();
  // The counts by status add up to the registry.
  const counts = await page.getByTestId('status-counts').locator('li .font-medium').allTextContents();
  expect(counts.reduce((n, c) => n + Number.parseInt(c, 10), 0)).toBe(await params.count());
});

test('every page carries a canonical address without the query, Open Graph tags, and the site has robots and a sitemap', async ({ page }) => {
  await page.goto('/streamers/?league=nba');
  await expect(page.locator('head link[rel="canonical"]')).toHaveAttribute('href', /\/streamers\/$/);
  await expect(page.locator('head meta[property="og:title"]')).toHaveAttribute('content', /Pickups · FantasyScout/);
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
  // A page per Schema model, never its route pattern (#449).
  expect(xml).toContain('<loc>https://fantasyscout.beronilla.rodeo/schema/mart_board/</loc>');
  expect(xml).not.toContain('[');
});

test('a chip shows where keyboard focus is', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('board').locator('tbody tr[data-player]').first()).toBeVisible();
  const chip = page.getByTestId('board-filters').locator('label').filter({ has: page.locator('input.sr-only') }).first();
  await expect(chip).toBeVisible();
  // Reach the chip's hidden checkbox with the keyboard: focus-visible only applies to keyboard focus.
  await page.getByTestId('board-filters').locator('input, button, select, a').first().focus();
  let focused = false;
  for (let i = 0; i < 30 && !focused; i += 1) {
    await page.keyboard.press('Tab');
    focused = await page.evaluate(() => {
      const el = document.activeElement;
      return !!el && el.tagName === 'INPUT' && el.classList.contains('sr-only');
    });
  }
  expect(focused).toBe(true);
  const ring = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const label = el.closest('label') as HTMLElement;
    const style = getComputedStyle(label);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(ring.style).not.toBe('none');
  expect(ring.width).not.toBe('0px');
});

test('on a phone the rank and player cells stay in view while the board scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const board = page.getByTestId('board');
  const row = board.locator('tbody tr[data-player]').first();
  await expect(row).toBeVisible();
  const region = board.locator('xpath=ancestor::*[contains(@class, "table-scroll")]').first();
  await region.evaluate((el) => {
    el.scrollLeft = 500;
  });
  const regionBox = await region.boundingBox();
  const playerBox = await row.locator('td').nth(1).boundingBox();
  const rankBox = await row.locator('td').nth(0).boundingBox();
  expect(regionBox && playerBox && rankBox).toBeTruthy();
  expect(rankBox!.x).toBeGreaterThanOrEqual(regionBox!.x - 1);
  expect(playerBox!.x).toBeGreaterThanOrEqual(regionBox!.x + rankBox!.width - 1);
  expect(playerBox!.x).toBeLessThan(regionBox!.x + regionBox!.width / 2);
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
  const before = await board.locator('tbody tr[data-player]').first().getByTestId('value').innerText();
  await page.getByTestId('board-options-toggle').click();
  await page.locator('fieldset label', { hasText: /^PTS$/ }).click();
  await expect(board.locator('thead [data-cat="z_points"]')).toHaveCount(0);
  await expect(page.getByTestId('active-filters')).toContainText('Punt PTS');
  const after = await board.locator('tbody tr[data-player]').first().getByTestId('value').innerText();
  expect(after).not.toBe(before);
});

test('the visible value switch weighs a game against the season, and the schedule columns are optional (#714)', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  const first = board.locator('tbody tr[data-player]').first();
  await expect(first).toBeVisible();
  const counted = page.getByRole('radiogroup', { name: 'Value counted' });
  await expect(counted.getByRole('radio', { name: 'Season' })).toHaveAttribute('aria-checked', 'true');
  // the fixture's WNBA season is over: no rest of season to count
  await expect(counted.getByRole('radio', { name: 'Rest of season' })).toHaveCount(0);
  const name = await first.locator('a').innerText();
  const withGames = Number(await first.getByTestId('value').innerText());
  await counted.getByRole('radio', { name: 'Per game' }).click();
  await expect(page).toHaveURL(/[?&]games=0(&|$)/);
  const row = board.locator('tbody tr[data-player]', { hasText: name }).first();
  const perGame = Number(await row.getByTestId('value').innerText());
  expect(perGame).toBeGreaterThan(withGames);
  await expect(page.getByTestId('view-help')).toContainText('Per game: what one game is worth');
  // the columns lead with the value; age and games played wait behind Filters
  await expect(board.locator('thead th').nth(2)).toContainText('Value');
  await expect(board.locator('thead')).not.toContainText('GP%');
  await page.getByTestId('board-options-toggle').click();
  await page.getByLabel(/Schedule and health columns/).check();
  await expect(board.locator('thead')).toContainText('GP%');
  await expect(board.locator('thead')).toContainText('Age');
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
  // the Worker's current-build address resolves the same pointer, so it fails with it (#436)
  await page.route('**/data/current/**', (route) => (failing ? route.fulfill({ status: 503, body: 'down' }) : route.fallback()));
  await page.goto('/');
  const alert = page.getByTestId('data-unavailable');
  await expect(alert).toContainText('temporarily unavailable (HTTP 503)');
  await expect(page.getByText('No data build has been published yet')).toHaveCount(0);
  // the footer does not claim there is no build (#460)
  await expect(page.locator('[data-data-as-of]')).toHaveText('unavailable');
  failing = false;
  await alert.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByTestId('board').locator('tbody tr[data-player]').first()).toBeVisible();
});

test('without any build published, the pages say so', async ({ page }) => {
  await page.route('**/data/latest.json', (route) => route.fulfill({ status: 404, body: 'nope' }));
  await page.route('**/data/current/**', (route) => route.fulfill({ status: 404, body: 'nope' }));
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('No data build has been published yet');
});

test('streamers shows the week grid and the candidates', async ({ page }) => {
  const season = await leagueInSeason(page);
  test.skip(!season, NO_SEASON);
  await page.goto(`/streamers/?league=${season!.league}`);
  // the pickups lead; the schedule is folded under them (#722)
  await expect(page.getByTestId('trending').locator('tbody tr').first()).toBeVisible();
  await expect(page.getByTestId('week-grid')).toBeHidden();
  await page.getByTestId('schedule-card').locator('summary').click();
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

test('streamers can show any period: next week Monday to Friday, from the URL or the shortcut', async ({ page }) => {
  const season = await leagueInSeason(page);
  test.skip(!season, NO_SEASON);
  const games = season!.games;
  const shift = (iso: string, n: number) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  // the grid's first day, as the page works it out; then next week's Monday
  const first = games.find((g) => g.days_ahead === 0)?.game_date ?? shift(games[0]!.game_date, -games[0]!.days_ahead);
  const dow = new Date(`${first}T00:00:00Z`).getUTCDay();
  const monday = shift(first, dow === 0 ? 1 : 8 - dow);
  const friday = shift(monday, 4);
  await page.goto(`/streamers/?league=${season!.league}&from=${monday}&to=${friday}`);
  await page.getByTestId('schedule-card').locator('summary').click();
  const grid = page.getByTestId('week-grid');
  await expect(grid).toBeVisible();
  const summary = page.getByTestId('schedule-card').locator('summary');
  await expect(summary).toContainText(/Games from Mon, .* to Fri, /);
  await expect(page.getByRole('radio', { name: 'Custom' })).toHaveAttribute('aria-checked', 'true');
  await expect(grid.locator('thead th')).toHaveCount(7); // Team, Games, five days
  await expect(page.getByTestId('open-days').getByRole('checkbox')).toHaveCount(5);
  // a team's count is its games on those days
  const inPeriod = games.filter((g) => g.game_date >= monday && g.game_date <= friday);
  const team = inPeriod[0]?.home_team_tricode;
  if (team) {
    const expected = inPeriod.filter((g) => g.home_team_tricode === team || g.away_team_tricode === team).length;
    const row = grid.locator('tbody tr').filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^${team}$`) }) });
    await expect(row.locator('td').nth(1)).toHaveText(String(expected));
  }
  await expect(page.getByTestId('trending').locator('thead')).toContainText('Period');
  // a preset window clears the period, and the shortcut brings it back
  await page.getByRole('radio', { name: '7 days' }).click();
  await expect(summary).toContainText('games in the next 7 days');
  await expect(page).not.toHaveURL(/from=/);
  await page.getByRole('radio', { name: 'Custom' }).click();
  await page.getByRole('button', { name: 'Next week, Mon to Fri' }).click();
  await expect(summary).toContainText(/Games from Mon, .* to Fri, /);
  await expect(page).toHaveURL(new RegExp(`from=${monday}&to=${friday}`));
  await expect(page.getByLabel('Period start')).toHaveValue(monday);
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
  // The fixture's WNBA season is over, which hides the grid (#450); mark it still running here.
  await page.route('**/streamers/wnba.json', async (route) => {
    const rows = (await (await route.fetch()).json()) as Record<string, unknown>[];
    await route.fulfill({ json: rows.map((r) => ({ ...r, season_complete: false })) });
  });
  await page.goto('/streamers/');
  await expect(page.getByTestId('trending').locator('tbody tr').first()).toBeVisible();
  if (weeks.length === 0) {
    // The fixture season has no week ahead: the card stays away rather than showing an empty grid.
    await expect(page.getByTestId('weeks-grid')).toHaveCount(0);
    return;
  }
  await page.getByTestId('schedule-card').locator('summary').click();
  // with no game in the window, the weeks are the only grid; otherwise their tab
  const tab = page.getByRole('radio', { name: 'Weeks to the end' });
  if (await tab.count()) await tab.click();
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

test('a schedule that fails to load is said to have failed, not to be empty', async ({ page }) => {
  await page.route('**/schedule/*.json', (route) => route.fulfill({ status: 500, body: 'down' }));
  await page.goto('/streamers/');
  const alert = page.getByTestId('schedule-unavailable');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('could not be loaded');
  await expect(alert.getByRole('button', { name: 'Reload' })).toBeVisible();
  await expect(page.getByTestId('season-note')).toHaveCount(0);
  await expect(page.getByTestId('trending').locator('tbody tr').first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText('regular-season games in the next seven days');
});

test('a points league sees fantasy points per game on Streamers, not category z-scores', async ({ page }) => {
  await page.goto('/league/');
  await page.getByLabel('Scoring').selectOption('points');
  await expect(page.getByTestId('point-weights')).toBeVisible();
  await page.goto('/streamers/');
  const table = page.getByTestId('trending');
  await expect(table.locator('tbody tr').first()).toBeVisible();
  await expect(table.locator('thead')).toContainText('FPts (10)');
  await expect(table.locator('thead')).not.toContainText('Value (10)');
  await expect(page.getByTestId('points-note')).toContainText('fantasy points per game');
  const rows = (await (await page.request.get('/data/builds/fixture/streamers/wnba.json')).json()) as {
    full_name: string | null;
    last_10_points_pg: number | null;
    last_10_rebounds_total_pg: number | null;
    last_10_assists_pg: number | null;
    last_10_steals_pg: number | null;
    last_10_blocks_pg: number | null;
    last_10_three_pointers_made_pg: number | null;
    last_10_turnovers_pg: number | null;
    last_10_fgm_pg: number | null;
    last_10_fga_pg: number | null;
    last_10_ftm_pg: number | null;
    last_10_fta_pg: number | null;
  }[];
  const firstName = (await table.locator('tbody tr').first().locator('a').first().innerText()).trim();
  const sample = rows.find((r) => r.full_name === firstName && typeof r.last_10_points_pg === 'number');
  if (sample) {
    // ESPN default weights: 1 pt, 1 reb, 2 ast, 4 stl, 4 blk, 1 3pm, -2 to, 2 fgm, -1 fga, 1 ftm, -1 fta
    const expected =
      (sample.last_10_points_pg ?? 0) + (sample.last_10_rebounds_total_pg ?? 0) + 2 * (sample.last_10_assists_pg ?? 0) +
      4 * (sample.last_10_steals_pg ?? 0) + 4 * (sample.last_10_blocks_pg ?? 0) + (sample.last_10_three_pointers_made_pg ?? 0) -
      2 * (sample.last_10_turnovers_pg ?? 0) + 2 * (sample.last_10_fgm_pg ?? 0) - (sample.last_10_fga_pg ?? 0) +
      (sample.last_10_ftm_pg ?? 0) - (sample.last_10_fta_pg ?? 0);
    const row = table.locator('tbody tr').filter({ hasText: sample.full_name ?? '' }).first();
    const headers = await table.locator('thead th').allInnerTexts();
    const index = headers.findIndex((h) => h.includes('FPts (10)'));
    const shown = Number((await row.locator('td').nth(index).innerText()).replace(/[^\d.-]/g, ''));
    expect(Math.abs(shown - expected)).toBeLessThan(0.06);
  }
});

test('in season the sorted column is the first number a streamer sees, on a phone and a desktop', async ({ page }) => {
  // The window columns exist only with games in the next seven days of the fixture's schedule.
  let league: 'nba' | 'wnba' | null = null;
  for (const candidate of ['nba', 'wnba'] as const) {
    const games = (await (await page.request.get(`/data/builds/fixture/schedule/${candidate}.json`)).json()) as { days_ahead: number }[];
    if (games.some((g) => g.days_ahead <= 6)) {
      league = candidate;
      break;
    }
  }
  if (!league) {
    test.skip(true, 'the fixture has no games in the next seven days');
    return;
  }
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/streamers/?league=${league}`);
    const table = page.getByTestId('trending');
    await expect(table.locator('tbody tr').first()).toBeVisible();
    const sorted = table.locator('th[aria-sort="ascending"], th[aria-sort="descending"]');
    await expect(sorted).toHaveCount(1);
    await expect(sorted).toContainText('Window value');
    // the second header: Player, then the window value, so a phone shows it beside the name
    await expect(table.locator('thead th').nth(1)).toContainText('Window value');
    const region = table.locator('xpath=ancestor::*[contains(@class, "table-scroll")]').first();
    const [box, regionBox] = await Promise.all([sorted.boundingBox(), region.boundingBox()]);
    expect(box && regionBox && box.x + box.width <= regionBox.x + regionBox.width + 1).toBeTruthy();
  }
});

test('streamers can be filtered by position and re-sorted', async ({ page }) => {
  await page.goto('/streamers/');
  const rows = page.getByTestId('trending').locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  await page.getByLabel('Position C').check({ force: true });
  const positions = await rows.getByTestId('team-pos').allInnerTexts();
  expect(positions.length).toBeGreaterThan(0);
  expect(positions.every((p) => (p.split(' · ')[0] ?? '').includes('C'))).toBe(true);
  await page.getByLabel('More columns').check();
  await page.getByRole('button', { name: /^PTS/ }).click();
  const at = await page.getByTestId('trending').locator('thead th').evaluateAll((ths) => ths.findIndex((th) => (th.textContent ?? '').trim().startsWith('PTS (5)')));
  const pts = (await rows.locator(`td:nth-child(${at + 1})`).allInnerTexts()).map(Number);
  expect(pts[0]).toBeGreaterThanOrEqual(pts[pts.length - 1] ?? 0);
});

test('the board switches between value, recent, projected and per-game views', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr[data-player]').first()).toBeVisible();
  await expect(page.getByTestId('season-note')).toContainText('regular season is over');
  await page.getByRole('radio', { name: 'Season line' }).click();
  await expect(board.locator('thead')).toContainText('MIN');
  await expect(board.locator('thead')).not.toContainText('Value');
  await page.getByRole('button', { name: /^PTS/ }).click();
  const pts = (await board.locator('tbody tr[data-player] td[data-col="points_pg"]').allInnerTexts()).map(Number);
  expect(pts[0]).toBeGreaterThanOrEqual(pts[1] ?? 0);
  await page.getByRole('radio', { name: 'Last 10' }).click();
  await expect(board.locator('thead')).toContainText('Value');
  await page.getByRole('radio', { name: 'Projected line' }).click();
  await expect(board.locator('thead')).toContainText('MIN');
  await expect(board.locator('thead')).not.toContainText('Value');
  await expect(board.locator('tbody tr[data-player]').first().locator('td[data-col="proj_minutes_pg"]')).toHaveText(/^\d+(\.\d+)?$/);
});

test('the board filters by position and shows injury tags', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr[data-player]').first()).toBeVisible();
  await page.getByTestId('board-more').click();
  await expect(page.getByTestId('injury-tag').first()).toBeVisible();
  await page.getByLabel('Position G').check({ force: true });
  const positions = await board.locator('tbody tr[data-player]').getByTestId('pos').allInnerTexts();
  expect(positions.every((p) => p.includes('G'))).toBe(true);
});

test('data health opens with the build\'s age, the last build and the open incidents (#418)', async ({ page }) => {
  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({
      json: [{ number: 901, title: 'Build failure: dbt on Databricks', html_url: 'https://github.com/x/901', created_at: '2026-11-02T03:10:00Z' }],
    }),
  );
  await page.route('**/health.json', async (route) => {
    const body = (await (await route.fetch()).json()) as Record<string, unknown>;
    body['builds'] = [
      { run_id: '1', run_url: 'https://github.com/x/actions/runs/1', outcome: 'failure', light: false, finished_at: '2026-11-02T03:05:00Z', gate_reason: 'blocked by: assert_box_closure' },
    ];
    await route.fulfill({ json: body });
  });
  await page.goto('/health/');
  const status = page.getByTestId('health-status');
  await expect(status.getByTestId('status-age')).toContainText(/the limit is (30|72) hours/);
  await expect(status.getByTestId('status-last-build')).toContainText('Last build failed');
  await expect(status.getByTestId('status-last-build')).toContainText('blocked by: assert_box_closure');
  await expect(status.getByTestId('status-incidents')).toContainText('1 open data incident');
  await expect(status.getByRole('link', { name: '#901 Build failure: dbt on Databricks' })).toHaveAttribute('href', 'https://github.com/x/901');
  // above the fold on a phone
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(status).toBeInViewport();
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

// The week grid tints the days a team plays; a back-to-back tag on that tint must still read, in
// both themes, and each scrollable table is a region with its own name (#458).
test('streamers with back-to-backs passes axe, best practices included, in both themes', async ({ page }) => {
  // Two full axe passes over a large table: about 20 s alone, longer beside other tests.
  test.setTimeout(60_000);
  await page.route('**/schedule/nba*.json', async (route) => {
    const games = (await (await route.fetch()).json()) as Record<string, unknown>[];
    await route.fulfill({ json: games.map((g) => ({ ...g, home_back_to_back: true, away_back_to_back: true })) });
  });
  await page.goto('/streamers/?league=nba');
  await page.getByTestId('schedule-card').locator('summary').click();
  await page.getByLabel('More columns').check();
  await expect(page.getByTestId('back-to-back').first()).toBeVisible();
  for (let i = 0; i < 2; i++) {
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'best-practice']).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    await page.getByRole('button', { name: /toggle dark or light theme/i }).click();
  }
  const names = await page.locator('main [role="region"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  expect(new Set(names).size).toBe(names.length);
});

/** Scroll each of the Schema overview's diagrams into view and wait for the drawing to load into it (#449). */
async function loadSchemaDiagrams(page: Page): Promise<void> {
  const figures = page.locator('figure[data-testid^="diagram-"]');
  const n = await figures.count();
  expect(n).toBeGreaterThanOrEqual(5);
  for (let i = 0; i < n; i += 1) {
    await figures.nth(i).scrollIntoViewIfNeeded();
    await expect(figures.nth(i).locator('[data-diagram-loaded] > svg')).toBeVisible();
  }
}

// Static pages. The schema overview is checked with its diagrams loaded, and a model's own page too.
for (const path of ['/pipeline/', '/schema/', '/schema/mart_board/', '/schema/category_config/', '/sources/', '/methodology/']) {
  test(`${path} has no accessibility violations`, async ({ page }) => {
    // The lineage drawing is large: axe needs longer than the default.
    test.setTimeout(90_000);
    await page.goto(path);
    await expect(page.locator('main h1')).toBeVisible();
    if (path === '/schema/') await loadSchemaDiagrams(page);
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

for (const path of ['/', '/team/', '/league/', '/streamers/', '/trade/', '/health/', '/p/wnba/1628932/', '/sql/', '/notes/', '/notebooks/', '/dashboards/', '/pipeline/', '/schema/', '/schema/mart_board/', '/methodology/']) {
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

test('the schema page draws the gold layer by subject area and the lineage as each comes into view, and their boxes link to the rows', async ({ page }) => {
  await page.goto('/schema/');
  const areas: Record<string, string[]> = {
    'er-games': ['dim_game', 'fct_player_game', 'mart_player_rolling', 'dim_date'],
    'er-availability': ['fct_availability', 'fct_player_news', 'dim_player'],
    'er-schedule': ['mart_schedule_upcoming', 'dim_team'],
    'er-fantasy': ['mart_board', 'mart_streamers', 'fct_market_value'],
  };
  // The page holds a place for each drawing and loads it as it nears the screen (#449).
  await loadSchemaDiagrams(page);
  for (const [id, names] of Object.entries(areas)) {
    const er = page.getByTestId(`diagram-${id}`);
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
  await expect(lineage).toContainText('espn/summary');
  await expect(page.getByTestId('diagram-er-fantasy').locator('a[href="#m-mart_board"]')).toHaveCount(1);
  // A box in a drawing lands on the model's row, which links to the model's own page.
  await lineage.locator('a[href="#m-mart_board"]').click();
  await expect(page).toHaveURL(/\/schema\/#m-mart_board$/);
  const row = page.locator('#m-mart_board');
  await expect(row).toBeInViewport();
  await expect(row.getByRole('link', { name: 'mart_board', exact: true })).toHaveAttribute('href', /\/schema\/mart_board\/$/);

  // Without a script, each drawing is a link to its file.
  const file = await page.request.get('/schema/diagrams/lineage.svg');
  expect(file.status()).toBe(200);
  expect(file.headers()['content-type']).toContain('image/svg+xml');
  const svg = await file.text();
  expect(svg.startsWith('<svg')).toBe(true);
  expect(svg).toContain('espn/summary');
});

test('the schema overview lists every model and seed as a row, small enough to load at once', async ({ page }) => {
  await page.goto('/schema/');
  for (const layer of ['bronze', 'silver', 'gold', 'ops']) {
    await expect(page.getByTestId(`layer-${layer}`).getByTestId('model').first()).toBeVisible();
  }
  const fact = page.locator('#m-fct_player_game');
  await expect(fact).toHaveAttribute('data-testid', 'model');
  await expect(fact).toContainText('7 checks');
  await expect(fact.getByTestId('coverage')).toContainText(/\d+\/\d+ described/);
  await expect(page.locator('#seed-category_config')).toHaveAttribute('data-testid', 'seed');
  await expect(page.getByTestId('checks-list').locator('tbody tr').first()).toBeVisible();
  await expect(page.locator('#check-assert_box_closure')).toBeAttached();
  await expect(page.getByTestId('unit-tests-list').locator('tbody tr')).not.toHaveCount(0);
  // The columns live on each model's page, not here: the page's own markup stays small (#449).
  await expect(page.locator('tr[data-column], details[data-model]')).toHaveCount(0);
  const own = await page.evaluate(() => document.querySelectorAll('body *').length - document.querySelectorAll('svg *').length);
  expect(own).toBeLessThan(3000);
});

test('each schema model and seed has its own page with its notes, grain, links and columns', async ({ page }) => {
  await page.goto('/schema/');
  await page.locator('#m-mart_board').getByRole('link', { name: 'mart_board', exact: true }).click();
  await expect(page).toHaveURL(/\/schema\/mart_board\/$/);
  const board = page.getByTestId('schema-model');
  await expect(board.locator('h1')).toHaveText('mart_board');
  await expect(board.getByTestId('summary')).toContainText('gold model');
  await expect(board.getByTestId('coverage')).toContainText(/\d+\/\d+ described/);
  await expect(board.getByTestId('notes')).toContainText('value above replacement');
  await expect(board.locator('tr[data-column="value_total"]')).toBeVisible();
  // Back to its row on the overview.
  await expect(board.getByRole('link', { name: 'Schema', exact: true })).toHaveAttribute('href', /\/schema\/#m-mart_board$/);

  await page.goto('/schema/fct_player_game/');
  const fact = page.getByTestId('schema-model');
  await expect(fact.getByTestId('grain')).toContainText('One row per league, game_id and player_id');
  await expect(fact.getByTestId('exported')).toContainText('players/<league>/<player_id>.json');
  await expect(fact.getByTestId('read-by-pages')).not.toBeEmpty();
  // What it reads and its checks link to their own page and to the overview's checks.
  await expect(fact.getByTestId('reads').getByRole('link', { name: 'dim_player', exact: true })).toHaveAttribute('href', /\/schema\/dim_player\/$/);
  await expect(fact.getByTestId('checked-by').getByRole('link', { name: 'assert_box_closure' })).toHaveAttribute(
    'href',
    /\/schema\/#check-assert_box_closure$/,
  );
  await expect(fact.locator('tr[data-column="player_game_sk"]')).toContainText('unique');
  await fact.getByTestId('reads').getByRole('link', { name: 'dim_player', exact: true }).click();
  await expect(page.getByTestId('schema-model').locator('h1')).toHaveText('dim_player');

  await page.goto('/schema/espn_summary_players/');
  const bronze = page.getByTestId('schema-model');
  await expect(bronze.getByTestId('landing')).toContainText('landing/espn/summary');
  await expect(bronze).toContainText('values stay text until silver');
  await page.goto('/schema/fct_market_value/');
  await expect(page.getByTestId('unit-tests')).toContainText('market_value_ranks');
  await page.goto('/schema/category_config/');
  const seed = page.getByTestId('schema-model');
  await expect(seed.getByTestId('read-by')).toContainText('only the export reads it');
  await expect(seed.getByRole('link', { name: 'Schema', exact: true })).toHaveAttribute('href', /\/schema\/#seed-category_config$/);
  await expect(seed.locator('tr[data-column]')).not.toHaveCount(0);
});

test('the schema page filters models by name, or by column from the column list it fetches once', async ({ page }) => {
  let fetched = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/schema/columns.json')) fetched += 1;
  });
  await page.goto('/schema/');
  const all = await page.locator('li[data-model]').count();
  const filter = page.getByLabel('Filter models and columns');
  await filter.fill('mart_board');
  await expect(page.locator('li[data-model]:visible')).toHaveCount(1);
  await expect(page.getByTestId('layer-bronze')).toBeHidden();
  await filter.fill('opponent_team_sk');
  const match = page.locator('li[data-model]:visible');
  await expect(match).toHaveCount(1);
  await expect(match).toHaveAttribute('data-model', 'fct_team_game');
  await expect(match.getByTestId('column-hits')).toHaveText('column: opponent_team_sk');
  await expect(page.getByRole('status')).toContainText(`1 of ${all} match, 1 by a column.`);
  await filter.fill('player_sk');
  await expect(page.getByTestId('column-hits').first()).toContainText('player_sk');
  await filter.fill('');
  await expect(page.locator('li[data-model]:visible')).toHaveCount(all);
  await expect(page.getByTestId('column-hits')).toHaveCount(0);
  expect(fetched).toBe(1);
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

for (const path of ['/', '/streamers/', '/health/', '/p/wnba/1628932/', '/notebooks/', '/schema/', '/schema/mart_board/']) {
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
  await expect(board.locator('thead')).toContainText('Value');
  await page.getByRole('radio', { name: 'Last 20' }).click();
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
  await page.getByTestId('board-options-toggle').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('board-csv').click()]);
  expect(download.suggestedFilename()).toBe('fantasyscout-wnba-board-value.csv');
  const text = await (await download.createReadStream()).toArray();
  const lines = Buffer.concat(text).toString('utf8').trim().split(String.fromCharCode(10));
  expect(lines[0]).toContain('rank,player,team');
  expect(lines.length).toBeGreaterThan(10);
});

test('Need fit reads the last-ten category columns, and Streamers leaves the league’s punts out of its value (#666)', async ({ page }) => {
  // The columns arrive with the next live build; until then the fixture carries them empty.
  await page.route('**/streamers/wnba.json', async (route) => {
    const rows = (await (await route.fetch()).json()) as Record<string, unknown>[];
    await route.fulfill({ json: rows.map((r) => ({ ...r, last_10_z_blocks: 7.77, last_10_z_points: 1, last_10_production_points: 1 })) });
  });
  await page.goto('/streamers/');
  const table = page.getByTestId('trending');
  await expect(table.locator('tbody tr').first()).toBeVisible();
  await page.getByLabel('Need BLK').check({ force: true });
  await expect(table.locator('tbody')).toContainText('+7.77');

  await page.goto('/league/');
  await page.getByLabel('Punt PTS').check({ force: true });
  await page.goto('/streamers/');
  await expect(table.locator('tbody tr').first()).toBeVisible();
  await expect(table.locator('thead [title*="leaving out PTS"]')).toHaveCount(1);
});

test('streamers rank by the categories you need and leave out likely rostered players', async ({ page }) => {
  await page.goto('/streamers/');
  const table = page.getByTestId('trending');
  await expect(table.locator('tbody tr').first()).toBeVisible();
  // the first ten rows paint first and the rest of the page when the browser is idle (#562)
  await expect.poll(() => table.locator('tbody tr').count()).toBeGreaterThan(10);
  const all = await table.locator('tbody tr').count();
  await page.getByLabel('Need BLK').check({ force: true });
  await page.getByLabel('Need REB').check({ force: true });
  await expect(table.locator('thead')).toContainText('Need fit');
  await page.getByLabel(/Likely available/).selectOption('60');
  await page.getByLabel('More columns').check();
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
    // the wide table: the Pickups' extra columns (#722)
    if (path === '/streamers/') await page.getByLabel('More columns').check();
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
  // the numbers card opens on its players table (#720)
  await page.getByTestId('trade-numbers').locator('summary').click();
  await expect(page.getByTestId('trade-players')).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations).toEqual([]);
});

test('the fantasy pages sit flat in the nav, the data pages under one header that opens on its pages (#724)', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  const flat = ['Rankings', 'My Team', 'Trade', 'Pickups', 'League', 'Draft', 'Notes'];
  for (const name of flat) await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Rankings', exact: true })).toHaveAttribute('aria-current', 'page');
  const data = page.getByTestId('nav-behind-the-data');
  await expect(data).not.toHaveAttribute('open', '');
  await data.locator('summary').click();
  for (const item of ['Notebooks', 'Dashboards', 'Data Health', 'Pipeline', 'Schema', 'Docs (opens in a new tab)', 'SQL console (owner only)', 'Sources and terms']) {
    await expect(data.getByRole('link', { name: item, exact: true })).toBeVisible();
  }
  // it stays on the screen, and a click elsewhere closes it
  const box = (await data.locator('ul').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.locator('footer').click();
  await expect(data).not.toHaveAttribute('open', '');
  // Nothing in the nav is "coming soon": every page there works today (#452).
  await expect(nav).not.toContainText('Coming soon');
  // a flat page is marked as current; the header of a data page is marked, not opened over the page
  await page.goto('/trade/');
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Trade', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.goto('/schema/');
  const header = page.getByTestId('nav-behind-the-data');
  await expect(header).toHaveAttribute('data-current', 'true');
  await expect(header).not.toHaveAttribute('open', '');
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
  await expect(page.getByTestId('roster').filter({ hasText: 'Napheesa Collier' })).toHaveCount(0);
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

test('the Yahoo bookmarklet reads every roster from the Starting Rosters page itself, counting only rows with a slot', async ({ page }) => {
  await page.route('**/board/nba.json', (route) => route.fulfill({ path: 'tests/fixtures/data/builds/fixture/board/wnba.json' }));
  await page.goto('/league/?league=nba');
  const code = (await page.getByTestId('yahoo-bookmarklet-link').getAttribute('href')) ?? '';
  // No team page may be fetched: the rosters are on the page the bookmark runs on.
  let fetched = 0;
  await page.route(/\/nba\/12345\/\d+$/, (route) => {
    fetched += 1;
    return route.abort();
  });
  await page.goto('/data/yahoo/startingrosters.html');
  await page.evaluate(code.slice('javascript:'.length));
  await expect(page).toHaveURL(/\/league\/\?league=nba$/);
  await expect(page.getByTestId('team-card')).toHaveCount(4);
  await expect(page.getByRole('status')).toContainText('Imported 4 teams from Yahoo: 14 players matched, 2 on the IL.');
  expect(fetched).toBe(0);
  const cards = page.getByTestId('team-card');
  await expect(cards.nth(0).getByLabel('Name of team 1')).toHaveValue('Dunk Dynasty');
  await expect(cards.nth(0).getByTestId('roster').locator('li')).toHaveCount(4);
  await expect(cards.nth(0).getByTestId('roster')).toContainText('Rhyne Howard');
  await expect(cards.nth(1).getByTestId('roster').locator('li')).toHaveCount(3);
  await expect(cards.nth(1).getByTestId('roster')).toContainText('Nneka Ogwumike'); // listed as "N. Ogwumike" on Yahoo
  await expect(cards.nth(1).getByRole('radio')).toBeChecked();
  // the sidebar's players belong to nobody
  await expect(page.getByTestId('roster').filter({ hasText: 'Napheesa Collier' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Injured list:/, pressed: true })).toHaveCount(2);
});

test('the Trade page values both sides for the rest of the season and gives a verdict', async ({ page }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/wnba.json')).json()) as { full_name: string; team_abbreviation: string; position: string }[];
  const label = (p: (typeof board)[number]) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
  await page.goto('/trade/');
  await expect(page.getByTestId('trade-no-league')).toBeVisible();
  await expect(page.getByTestId('trade-no-league')).toContainText('Values are for the default league (10 teams × 10, 9-cat).');
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
  // A wide screen gets the table; a phone a stacked list whose buttons are on screen (#455).
  const width = page.viewportSize()!.width;
  if (width >= 768) {
    const suggestions = page.getByTestId('trade-suggestions');
    await expect(suggestions.locator('tbody tr').first()).toBeVisible();
    // one team's roster alone has no rival to judge categories against: value only
    await expect(suggestions.locator('thead')).toContainText('Value');
    await expect(suggestions.locator('thead')).not.toContainText('Your categories');
    await expect(page.getByTestId('trade-suggestions-list')).toBeHidden();
  } else {
    const list = page.getByTestId('trade-suggestions-list');
    await expect(list.locator('li').first()).toContainText('You give');
    await expect(list.locator('li').first()).toContainText('Value');
    await expect(page.getByTestId('trade-suggestions')).toBeHidden();
    const use = list.getByRole('button', { name: 'Use this trade' }).first();
    await use.scrollIntoViewIfNeeded();
    const box = (await use.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.getByRole('button', { name: 'Use this trade' }).first().click();
  await expect(page.getByTestId('picked-give').locator('li').first()).toBeVisible();
  await expect(page.getByTestId('trade-verdict')).toBeVisible();
  const cats = page.getByTestId('trade-categories');
  await expect(cats.locator('thead')).toContainText('Your team before');
  await expect(cats.locator('thead')).toContainText('Rank of 2');
  await expect(cats.locator('tbody tr')).toHaveCount(9);
});

test('with rival rosters in, the Trade page judges a trade by the categories it wins, settles the roster spots and shows the partner’s side (#663)', async ({ page }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/wnba.json')).json()) as { full_name: string; team_abbreviation: string; position: string }[];
  const label = (p: (typeof board)[number]) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
  await page.goto('/league/');
  await page.getByLabel('Format').selectOption('h2h');
  await page.getByLabel('Roster spots').fill('6');
  for (const [team, picked] of [[1, [0, 5, 6]], [2, [1, 2, 7]], [3, [3, 4, 8]]] as const) {
    for (const i of picked) await page.getByLabel(`Add a player to Team ${team}`, { exact: true }).fill(label(board[i]!));
  }
  await page.goto('/trade/');
  await expect(page.getByTestId('roster-give').locator('li')).toHaveCount(3);
  // two of Team 2's players for one of the manager's: the manager drops one to make room
  await page.getByTestId('roster-give').getByRole('checkbox').first().check();
  await page.getByTestId('roster-get').getByRole('checkbox').nth(0).check();
  await page.getByTestId('roster-get').getByRole('checkbox').nth(1).check();
  const verdict = page.getByTestId('trade-category-verdict');
  await expect(verdict).toContainText(/categories in an average week against your league/);
  await expect(verdict).toContainText(/of your 9 categories/);
  await expect(page.getByTestId('trade-roster-moves')).toContainText('To make room you would drop');
  await expect(page.getByTestId('trade-partner')).toContainText('For Team 2');
  await expect(page.getByTestId('trade-verdict')).toContainText('In value');
  await expect(page.getByTestId('trade-spots')).toHaveCount(0);
  await expect(page.getByTestId('trade-categories').locator('thead')).toContainText('Win chance');
  // both sides in the same depth (#682): the objective verdict, each team's needs, the partner's win chances
  await expect(page.getByTestId('trade-objective')).toHaveText(/^(Win-win|Good for you only|Good for Team 2 only|Neither team)/);
  await expect(page.getByTestId('trade-partner')).toContainText('expected categories a week');
  await expect(page.getByTestId('trade-needs').locator('thead')).toContainText('Team 2');
  await expect(page.getByTestId('trade-needs').locator('tbody tr')).toHaveCount(3);
  await expect(page.getByTestId('trade-categories').locator('thead')).toContainText("Team 2's");
  // the suggestions now weigh categories and show the partner's side
  await page.getByTestId('roster-get').getByRole('checkbox').nth(1).uncheck();
  await page.getByTestId('roster-give').getByRole('checkbox').first().uncheck();
  const width = page.viewportSize()!.width;
  if (width >= 768) {
    const head = page.locator('#suggestions');
    await expect(head).toContainText(/raise the categories you expect to win/);
  }
});

test('the trade finder lists trades across the league that win the manager categories, and loads one (#664)', async ({ page }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/wnba.json')).json()) as { full_name: string; team_abbreviation: string; position: string }[];
  const label = (p: (typeof board)[number]) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
  await page.goto('/league/');
  await page.getByLabel('Format').selectOption('h2h');
  await page.getByLabel('Roster spots').fill('6');
  for (const [team, picked] of [[1, [0, 5, 9, 12]], [2, [1, 2, 7, 13]], [3, [3, 4, 8, 14]]] as const) {
    for (const i of picked) await page.getByLabel(`Add a player to Team ${team}`, { exact: true }).fill(label(board[i]!));
  }
  await page.goto('/trade/');
  await page.getByTestId('trade-tabs').getByRole('radio', { name: 'Find' }).click();
  const finder = page.locator('#finder');
  await expect(finder).toContainText('every team');
  // the fixture's best trades pay Team 2 in value, not categories: win-win only finds none
  await expect(page.getByTestId('win-win')).toBeChecked();
  await page.getByTestId('find-trades').click();
  await expect(page.getByTestId('found-none')).toContainText('both teams');
  await page.getByTestId('win-win').uncheck();
  const found = page.getByTestId('found-trades').locator('li');
  await expect(found.first()).toContainText('Your categories');
  await found.first().getByRole('button', { name: 'Use this trade' }).click();
  await expect(page.getByTestId('picked-give').locator('li').first()).toBeVisible();
  await expect(page.getByTestId('trade-category-verdict')).toContainText('Wins you categories');
  // using a found trade goes back to Build
  await expect(finder).toHaveCount(0);
  await expect(page.getByTestId('trade-tabs').getByRole('radio', { name: 'Build' })).toHaveAttribute('aria-checked', 'true');
});

test('with punts set, the Trade page lists the chips the league ranks above the build, and offers one (#671)', async ({ page }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/wnba.json')).json()) as { full_name: string; team_abbreviation: string; position: string }[];
  const label = (p: (typeof board)[number]) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
  await page.goto('/league/');
  await page.getByLabel('Roster spots').fill('6');
  for (const c of ['PTS', 'AST', '3PM']) await page.getByLabel(`Punt ${c}`).check({ force: true });
  for (const [team, picked] of [[1, [0, 5, 9, 12, 15, 18]], [2, [1, 2, 7, 13, 16, 19]], [3, [3, 4, 8, 14, 17, 20]]] as const) {
    for (const i of picked) await page.getByLabel(`Add a player to Team ${team}`, { exact: true }).fill(label(board[i]!));
  }
  await page.goto('/trade/');
  await page.getByTestId('trade-tabs').getByRole('radio', { name: 'Buy & sell' }).click();
  const chips = page.getByTestId('trade-chips');
  await expect(chips.locator('li').first()).toContainText(/#\d+ on value, #\d+ for you/);
  // the league's best player stays on top for any build: never a chip
  await expect(chips).not.toContainText(board[0]!.full_name);
  const first = (await chips.locator('li').first().locator('span').first().innerText()).trim();
  await chips.getByRole('button', { name: 'Offer' }).first().click();
  await expect(page.getByTestId('picked-give')).toContainText(first);
  await expect(page.locator('#chips')).toHaveCount(0);
});

test('Buy & sell lists your hot players to sell and slumping players elsewhere to buy, and loads one into a trade (#739)', async ({ page }) => {
  type Row = { player_id: string; full_name: string; team_abbreviation: string; position: string; [k: string]: unknown };
  const board = (await (await page.request.get('/data/builds/fixture/board/wnba.json')).json()) as Row[];
  const cats = ['z_points', 'z_rebounds_total', 'z_assists', 'z_steals', 'z_blocks', 'z_three_pointers_made', 'z_field_goal_pct', 'z_free_throw_pct', 'z_turnovers'];
  const hot = board[12]!; // mine, running hot
  const cold = board[1]!; // Team 2's star, in a slump
  const shift = (r: Row, by: number) => Object.fromEntries(cats.filter((c) => typeof r[c] === 'number').map((c) => [`recent_${c}`, (r[c] as number) + by]));
  await page.route('**/board/wnba.json', (route) =>
    route.fulfill({ json: board.map((r) => (r === hot ? { ...r, ...shift(r, 1) } : r === cold ? { ...r, injury_group: null, ...shift(r, -1) } : r)) }),
  );
  const label = (p: Row) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
  await page.goto('/league/');
  await page.getByLabel('Roster spots').fill('6');
  for (const [team, picked] of [[1, [0, 5, 9, 12]], [2, [1, 2, 7, 13]], [3, [3, 4, 8, 14]]] as const) {
    for (const i of picked) await page.getByLabel(`Add a player to Team ${team}`, { exact: true }).fill(label(board[i]!));
  }
  await page.goto('/trade/');
  await page.getByTestId('trade-tabs').getByRole('radio', { name: 'Buy & sell' }).click();
  await expect(page.getByTestId('sell-high')).toContainText(hot.full_name);
  const buy = page.getByTestId('buy-low').getByTestId('swing').filter({ hasText: cold.full_name });
  await expect(buy).toContainText('Team 2');
  await expect(buy).toContainText(/lately vs .* projected/);
  await buy.getByRole('button', { name: 'Ask for' }).click();
  await expect(page.getByTestId('picked-get')).toContainText(cold.full_name);
  await expect(page.getByLabel('Trade partner')).toHaveValue('1');
});

test("in a head-to-head league with this week's opponent set, the trade verdict shows the week's matchup before and after (#674)", async ({ page }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/nba.json')).json()) as { full_name: string; team_abbreviation: string; position: string; games_this_week: number | null }[];
  await page.route('**/board/nba.json', (route) => route.fulfill({ json: board.map((r) => ({ ...r, games_this_week: 3 })) }));
  const label = (p: (typeof board)[number]) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
  await page.goto('/league/?league=nba');
  await page.getByLabel('Format').selectOption('h2h');
  await page.getByLabel('Roster spots').fill('6');
  for (const [team, picked] of [[1, [0, 5, 9]], [2, [1, 2, 7]], [3, [3, 4, 8]]] as const) {
    for (const i of picked) await page.getByLabel(`Add a player to Team ${team}`, { exact: true }).fill(label(board[i]!));
  }
  await page.goto('/team/?league=nba');
  await page.getByTestId('matchup').getByLabel("This week's opponent").selectOption({ label: 'Team 3' });
  await page.goto('/trade/?league=nba');
  await page.getByTestId('roster-give').getByRole('checkbox').first().check();
  await page.getByTestId('roster-get').getByRole('checkbox').first().check();
  const week = page.getByTestId('trade-week-matchup');
  await expect(week).toContainText('This week against Team 3');
  await expect(week).toContainText(/\d+–\d+.* → \d+–\d+/);
});

test('the League page sets the league the board values for, and points leagues score fantasy points', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  const first = board.locator('tbody tr[data-player]').first();
  await expect(first).toBeVisible();
  const before = Number(await first.getByTestId('value').innerText());
  await expect(page.getByTestId('league-summary')).toHaveText('10 teams × 10, 9-cat');
  await page.getByRole('link', { name: /Set up your league/ }).click();
  await expect(page).toHaveURL(/\/league\//);
  await page.getByLabel('Teams in the league').fill('6');
  await page.getByLabel('Roster spots').fill('8');
  await expect(page.getByTestId('team-card')).toHaveCount(6);
  await page.goto('/');
  await expect(page.getByTestId('league-summary')).toHaveText('6 teams × 8, 9-cat');
  const smaller = Number(await board.locator('tbody tr[data-player]').first().getByTestId('value').innerText());
  expect(smaller).not.toBe(before);
  await page.goto('/league/');
  await page.getByLabel('Scoring').selectOption('cats8');
  await page.goto('/');
  await expect(board.locator('thead [data-cat="z_turnovers"]')).toHaveCount(0);
  await expect(board.locator('thead [data-cat]')).toHaveCount(8);
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
  await page.goto('/team/');
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
  // Rostered: everyone on a team in the league, the rival's player too
  await page.getByRole('radio', { name: 'Rostered' }).click();
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: b ?? '' })).toHaveCount(1);
  await page.getByRole('radio', { name: 'Everyone' }).click();
  await expect(rows.filter({ hasText: b ?? '' }).getByTestId('owner')).toHaveText('Rivals');
  await page.goto('/streamers/');
  await expect(page.getByLabel(/Likely available/)).toHaveValue('-1');
});

/** A named player neither the board nor the market ranks among any default league's starters (#710). */
async function deepBench(page: Page, league: 'nba' | 'wnba'): Promise<string> {
  const rows = (await (await page.request.get(`/data/builds/fixture/board/${league}.json`)).json()) as {
    full_name: string | null;
    rank_total: number | null;
    market_rank: number | null;
  }[];
  return rows.find((r) => r.full_name && (r.rank_total ?? 999) > 120 && (r.market_rank ?? 999) > 120)!.full_name!;
}

test('with rosters set up, the board recommends roster upgrades from the available players and applies one', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  const rows = board.locator('tbody tr[data-player]');
  await expect(rows.first()).toBeVisible();
  // The best player on the board and a deep bench player nobody ranks among the starters: only
  // the second can be upgraded (#710).
  const best = await rows.nth(0).locator('a').first().innerText();
  const weak = await deepBench(page, 'wnba');
  await page.goto('/league/');
  const cards = page.getByTestId('team-card');
  await cards.nth(0).getByText('Paste a roster').click();
  await page.getByLabel('Paste names for Team 1', { exact: true }).fill(`${best}\n${weak}`);
  await cards.nth(0).getByRole('button', { name: 'Add pasted players' }).click();
  await expect(cards.nth(0).getByTestId('paste-result')).toContainText('Added 2');
  // the roster's moves are on My Team, not the board (#712)
  await page.goto('/');
  await expect(rows.first()).toBeVisible();
  await expect(page.getByTestId('upgrades')).toHaveCount(0);
  await page.goto('/team/');
  const upgrades = page.getByTestId('upgrades');
  await expect(upgrades).toBeVisible();
  await expect(upgrades.getByTestId('roster-verdict')).toContainText('1 of your 2 players can be upgraded');
  await expect(upgrades.getByTestId('roster-verdict')).toContainText(weak);
  const roster = page.getByTestId('roster-table').locator('tbody tr');
  await expect(roster).toHaveCount(2);
  const first = upgrades.getByTestId('upgrade').first();
  await expect(first).toContainText(`for ${weak}`);
  await expect(first).toContainText('rest of season');
  await first.getByRole('button', { name: 'Apply' }).click();
  await expect(upgrades.getByTestId('upgrade').filter({ hasText: `for ${weak}` })).toHaveCount(0);
  await expect(roster).toHaveCount(2);
  await expect(page.getByTestId('roster-table')).not.toContainText(weak);
  await expect(page.getByTestId('league-bar')).toContainText('Team 1 (2/');
  await page.goto('/');
  await expect(board.locator('tbody')).not.toContainText(weak);
});

test('the roster review can be judged for this fantasy week: recent form over the games left', async ({ page }) => {
  // A doctored NBA board: everyone has three games left this week except the best player on the board, who has none.
  const board = (await (await page.request.get('/data/builds/fixture/board/nba.json')).json()) as { full_name: string | null; games_this_week: number | null }[];
  const weak = await deepBench(page, 'nba');
  let none = '';
  await page.route('**/board/nba.json', (route) =>
    route.fulfill({ json: board.map((r) => ({ ...r, games_this_week: r.full_name === none ? 0 : 3 })) }),
  );
  await page.goto('/?league=nba');
  const rows = page.getByTestId('board').locator('tbody tr[data-player]');
  await expect(rows.first()).toBeVisible();
  const best = await rows.nth(0).locator('a').first().innerText();
  none = best;
  await page.goto('/league/?league=nba');
  const cards = page.getByTestId('team-card');
  await cards.nth(0).getByText('Paste a roster').click();
  await page.getByLabel('Paste names for Team 1', { exact: true }).fill(`${best}\n${weak}`);
  await cards.nth(0).getByRole('button', { name: 'Add pasted players' }).click();
  await expect(cards.nth(0).getByTestId('paste-result')).toContainText('Added 2');
  await page.goto('/team/?league=nba');
  const upgrades = page.getByTestId('upgrades');
  // Rest of season: the weak player goes, the best stays.
  await expect(upgrades.getByTestId('roster-verdict')).toContainText(weak);
  await expect(upgrades.getByTestId('upgrade').first()).toContainText('rest of season');
  await expect(upgrades.getByTestId('upgrade').filter({ hasText: `for ${best}` })).toHaveCount(0);
  // This week: the best player has no game left and is worth nothing this week, but a star is a
  // trade, not a drop (#710): the bench player is the one to replace, the star a trade chip.
  await upgrades.getByRole('radio', { name: 'This week' }).click();
  await expect(upgrades.getByTestId('unit-note')).toContainText('last-ten form');
  await expect(upgrades.getByTestId('roster-verdict')).toContainText(weak);
  await expect(upgrades.getByTestId('upgrade').first()).toContainText('this week');
  await expect(upgrades.getByTestId('upgrade').filter({ hasText: `for ${best}` })).toHaveCount(0);
  await expect(upgrades.getByTestId('roster-chips')).toContainText(best);
  await expect(upgrades.getByTestId('roster-chips').getByRole('link', { name: 'Shop on the Trade page' })).toBeVisible();
  await upgrades.getByRole('radio', { name: 'Rest of season' }).click();
  await expect(upgrades.getByTestId('upgrade').first()).toContainText('rest of season');
  await expect(upgrades.getByTestId('unit-note')).toHaveCount(0);
});

test('the Trade page can judge a trade for this fantasy week and counts the games each side has left', async ({ page }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/nba.json')).json()) as {
    full_name: string;
    team_abbreviation: string;
    position: string;
    games_this_week: number | null;
  }[];
  board.forEach((r, i) => {
    r.games_this_week = i === 0 ? 0 : 3;
  });
  await page.route('**/board/nba.json', (route) => route.fulfill({ json: board }));
  const label = (p: (typeof board)[number]) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
  await page.goto('/trade/?league=nba');
  await page.getByLabel('Add a player you give').fill(label(board[1]!));
  await page.getByLabel('Add a player you get').fill(label(board[0]!));
  await page.getByLabel('Add a player you get').fill(label(board[2]!));
  const verdict = page.getByTestId('trade-verdict');
  await expect(verdict).toContainText('rest of season');
  await expect(page.getByTestId('trade-week-games')).toContainText('3 for the players you give, 3 for the players you get');
  await page.getByRole('radio', { name: 'This week' }).click();
  await expect(verdict).toContainText('this fantasy week');
  await expect(verdict).not.toContainText('rest of season');
  await expect(verdict).toContainText('last-ten form');
  await page.getByRole('radio', { name: 'Rest of season' }).click();
  await expect(verdict).toContainText('rest of season');
});

test('a head-to-head league picks this week\'s opponent on My Team and sees the categories it projects to win', async ({ page }) => {
  // The fixture's week of Monday 2 November: each side counts the games its lineup starts (#817).
  type Row = { player_id: string; full_name: string | null; team_id: string | null; injury_group: string | null };
  type Game = { game_date: string; home_team_id: string; away_team_id: string };
  const board = (await (await page.request.get('/data/builds/fixture/board/nba.json')).json()) as Row[];
  const games = (await (await page.request.get('/data/builds/fixture/schedule/nba.json')).json()) as Game[];
  await page.clock.setFixedTime(new Date('2026-11-02T16:00:00Z'));
  const week = games.filter((g) => g.game_date >= '2026-11-02' && g.game_date <= '2026-11-08');
  const gamesFor = (name: string) => {
    const r = board.find((b) => b.full_name === name);
    if (!r || ['out', 'doubtful'].includes(r.injury_group ?? '')) return 0;
    return week.filter((g) => g.home_team_id === r.team_id || g.away_team_id === r.team_id).length;
  };
  await page.goto('/?league=nba');
  const rows = page.getByTestId('board').locator('tbody tr[data-player]');
  await expect(rows.first()).toBeVisible();
  const names = await Promise.all([0, 1, 2, 60].map((i) => rows.nth(i).locator('a').first().innerText()));
  await page.goto('/league/?league=nba');
  await page.getByLabel('Format').selectOption('h2h');
  const cards = page.getByTestId('team-card');
  await cards.nth(0).getByText('Paste a roster').click();
  await page.getByLabel('Paste names for Team 1', { exact: true }).fill(names.slice(0, 3).join('\n'));
  await cards.nth(0).getByRole('button', { name: 'Add pasted players' }).click();
  await expect(cards.nth(0).getByTestId('paste-result')).toContainText('Added 3');
  await cards.nth(1).getByText('Paste a roster').click();
  await page.getByLabel('Paste names for Team 2', { exact: true }).fill(names[3] ?? '');
  await cards.nth(1).getByRole('button', { name: 'Add pasted players' }).click();
  await expect(cards.nth(1).getByTestId('paste-result')).toContainText('Added 1');
  await page.goto('/team/?league=nba');
  await expect(page.getByTestId('league-summary')).toContainText('head-to-head');
  const matchupCard = page.getByTestId('matchup');
  await expect(matchupCard.getByTestId('matchup-summary')).toContainText('Pick the team you face');
  await matchupCard.getByLabel("This week's opponent").selectOption({ label: 'Team 2' });
  // three of the best against one player far down the board: most categories are won; turnovers go the other way
  await expect(matchupCard.getByTestId('matchup-summary')).toContainText(/win [5-9] of 9 categories against Team 2/);
  // three players fill three of the ten slots, so each starts every game his team has left
  const mine = names.slice(0, 3).reduce((s, name) => s + gamesFor(name), 0);
  await expect(matchupCard.getByTestId('matchup-summary')).toContainText(`Games left this week: you ${mine}, Team 2 ${gamesFor(names[3] ?? '')}`);
  await expect(matchupCard.getByTestId('matchup-row')).toHaveCount(9);
  await expect(matchupCard.getByTestId('matchup-row').filter({ hasText: 'TO' })).toContainText('loss');
  // a head-to-head review defaults to this week
  await expect(page.getByTestId('upgrades').getByRole('radio', { name: 'This week' })).toHaveAttribute('aria-checked', 'true');
  // the opponent survives a reload and can be cleared
  await page.reload();
  await expect(matchupCard.getByTestId('matchup-row')).toHaveCount(9);
  await matchupCard.getByLabel("This week's opponent").selectOption('');
  await expect(matchupCard.getByTestId('matchup-summary')).toContainText('Pick the team you face');
});

test('with rival rosters in, Fit weighs the categories by the league standings and the bar names the least likely wins (#662)', async ({ page }) => {
  await page.goto('/');
  const rows = page.getByTestId('board').locator('tbody tr[data-player]');
  await expect(rows.first()).toBeVisible();
  const names = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => rows.nth(i).locator('a').first().innerText()));
  await page.goto('/league/');
  await page.getByLabel('Roster spots').fill('6');
  const cards = page.getByTestId('team-card');
  for (const [team, picked] of [[0, [0, 3, 4]], [1, [1, 2, 5]]] as const) {
    await cards.nth(team).getByText('Paste a roster').click();
    await page.getByLabel(`Paste names for Team ${team + 1}`, { exact: true }).fill(picked.map((i) => names[i]).join('\n'));
    await cards.nth(team).getByRole('button', { name: 'Add pasted players' }).click();
    await expect(cards.nth(team).getByTestId('paste-result')).toContainText('Added 3');
  }
  await page.goto('/');
  await expect(rows.first()).toBeVisible();
  await expect(page.getByTestId('board').locator('[title*="chance of beating"]')).toHaveCount(1);
  await expect(page.getByTestId('league-bar').getByRole('link', { name: /Team 1/ })).toHaveAttribute('href', /\/team\/$/);
});

test('the Today card groups the active roster by plays, listed and no game, on My Team', async ({ page }) => {
  type Row = { player_id: string; full_name: string | null; team_id: string | null; injury_group: string | null };
  type Game = { game_date: string; home_team_id: string; away_team_id: string };
  const board = (await (await page.request.get('/data/builds/fixture/board/nba.json')).json()) as Row[];
  const games = (await (await page.request.get('/data/builds/fixture/schedule/nba.json')).json()) as Game[];
  // the day with the most games in the fixture, as Eastern "today"
  const counts = new Map<string, number>();
  for (const g of games) counts.set(g.game_date, (counts.get(g.game_date) ?? 0) + 1);
  const day = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  await page.clock.setFixedTime(new Date(`${day}T16:00:00Z`));
  const playing = new Set(games.filter((g) => g.game_date === day).flatMap((g) => [g.home_team_id, g.away_team_id]));
  const listedGroups = new Set(['out', 'doubtful', 'questionable', 'day_to_day']);
  const named = board.filter((r) => r.full_name && r.team_id);
  const plays = named.find((r) => playing.has(r.team_id!) && !r.injury_group)!;
  const listed = named.find((r) => playing.has(r.team_id!) && listedGroups.has(r.injury_group ?? ''))!;
  const idle = named.find((r) => !playing.has(r.team_id!))!;
  const roster = [plays, listed, idle].filter(Boolean);
  await page.goto('/league/?league=nba');
  const cards = page.getByTestId('team-card');
  await cards.nth(0).getByText('Paste a roster').click();
  await page.getByLabel('Paste names for Team 1', { exact: true }).fill(roster.map((r) => r.full_name).join('\n'));
  await cards.nth(0).getByRole('button', { name: 'Add pasted players' }).click();
  await expect(cards.nth(0).getByTestId('paste-result')).toContainText(`Added ${roster.length}`);
  for (const path of ['/team/?league=nba']) {
    await page.goto(path);
    const today = page.getByTestId('today');
    await expect(today.getByTestId('today-summary')).toContainText(`${plays ? 1 : 0} of your ${roster.length} active players play today`);
    // the calls come first (#816): the healthy player starts, the one without a game never does
    const calls = today.getByTestId('today-calls');
    if (plays) await expect(calls.getByTestId('today-start').locator(`[data-player="${plays.player_id}"]`)).toBeVisible();
    if (idle) await expect(calls.locator(`[data-player="${idle.player_id}"]`)).toHaveCount(0);
    if (listed?.injury_group === 'out') await expect(calls.getByTestId('today-out')).toContainText(listed.full_name ?? '');
    if (listed && ['questionable', 'day_to_day'].includes(listed.injury_group ?? '')) {
      await expect(calls.getByTestId('today-start').locator(`[data-player="${listed.player_id}"]`).getByTestId('check-by')).toBeVisible();
    }
    // the full lists, one click down
    await today.getByText("All of today's players").click();
    if (plays) await expect(today.getByTestId('today-plays').locator(`[data-player="${plays.player_id}"]`)).toBeVisible();
    if (listed) await expect(today.getByTestId('today-listed').locator(`[data-player="${listed.player_id}"]`)).toBeVisible();
    if (idle) await expect(today.getByTestId('today-idle').locator(`[data-player="${idle.player_id}"]`)).toBeVisible();
  }
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
  await page.goto('/team/');
  const review = page.getByTestId('upgrades');
  await expect(review.getByTestId('roster-verdict')).toContainText('optimized as is');
  await expect(review.getByTestId('roster-verdict')).toContainText('Weakest spot');
  await expect(review.getByTestId('upgrade')).toHaveCount(0);
});

test('My Team shows the chance of beating the league in each kept category, and says where to start when the team is empty (#712)', async ({ page }) => {
  await page.goto('/team/');
  await expect(page.getByTestId('team-empty')).toContainText('Your team is empty');
  await page.goto('/');
  const rows = page.getByTestId('board').locator('tbody tr[data-player]');
  await expect(rows.first()).toBeVisible();
  const names = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => rows.nth(i).locator('a').first().innerText()));
  await page.goto('/league/');
  await page.getByLabel('Roster spots').fill('6');
  const cards = page.getByTestId('team-card');
  for (const [team, picked] of [[0, [0, 3, 4]], [1, [1, 2, 5]]] as const) {
    await cards.nth(team).getByText('Paste a roster').click();
    await page.getByLabel(`Paste names for Team ${team + 1}`, { exact: true }).fill(picked.map((i) => names[i]).join('\n'));
    await cards.nth(team).getByRole('button', { name: 'Add pasted players' }).click();
    await expect(cards.nth(team).getByTestId('paste-result')).toContainText('Added 3');
  }
  await page.getByLabel('Punt PTS').check({ force: true });
  await expect(page.getByTestId('team-link').getByRole('link', { name: /My Team/ })).toBeVisible();
  await page.goto('/team/');
  const cats = page.getByTestId('my-categories');
  await expect(cats.getByTestId('cats-summary')).toContainText(/of 8 categories/);
  await expect(cats.getByTestId('cat-chance')).toHaveCount(8);
  await expect(cats.locator('[data-cat="z_points"]')).toHaveCount(0);
  await expect(cats).toContainText('Punted: PTS');
  await expect(cats.getByTestId('cat-chance').first()).toContainText(/\d+%\s*(1st|2nd) of 2/);
  await expect(page.getByTestId('roster-table').locator('tbody tr')).toHaveCount(3);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations).toEqual([]);
});

test('Build your team lists targets and players to let go, each with a move and a link to the Trade page prefilled (#809)', async ({ page, isMobile }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/wnba.json')).json()) as { full_name: string; team_abbreviation: string; position: string }[];
  const label = (p: (typeof board)[number]) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
  await page.goto('/league/');
  await page.getByLabel('Roster spots').fill('6');
  for (const [team, picked] of [[1, [0, 5, 9, 12]], [2, [1, 2, 7, 13]], [3, [3, 4, 8, 14]]] as const) {
    for (const i of picked) await page.getByLabel(`Add a player to Team ${team}`, { exact: true }).fill(label(board[i]!));
  }
  await page.goto('/team/');
  const tile = page.getByTestId('build-plan');
  await expect(tile).toBeVisible();
  await expect(tile.getByTestId('unvalidated')).toBeVisible();
  // the default league is rotisserie: the plan reads its expected points
  await expect(tile.getByTestId('build-summary')).toContainText('expected rotisserie points against the league');
  await expect(tile.getByTestId('build-import')).toHaveCount(0);
  // the category picture: every kept category with its place among the three teams
  await expect(tile.getByTestId('build-cat')).toHaveCount(9);
  await expect(tile.getByTestId('build-cat').first()).toContainText(/(1st|2nd|3rd) of 3 · \d+%/);
  // targets, and the two let-go lists of the four players on the roster
  await expect(tile.getByTestId('build-targets').getByTestId('build-row').first()).toBeVisible();
  await expect(tile.getByTestId('build-surplus').getByTestId('build-row')).toHaveCount(4);
  await expect(tile.getByTestId('build-lowest').getByTestId('build-row')).toHaveCount(4);
  // every free-agent target comes with its swap, and a link to Pickups
  for (const row of await tile.getByTestId('build-targets').getByTestId('build-row').all()) {
    const link = row.getByTestId('build-link');
    if ((await link.innerText()).includes('Pickups')) {
      await expect(row.getByTestId('build-move')).toHaveAttribute('data-kind', 'pickup');
      await expect(link).toHaveAttribute('href', /\/streamers\/\?league=wnba$/);
    } else {
      await expect(row.getByTestId('build-move')).toHaveAttribute('data-kind', 'trade');
      await expect(link).toHaveAttribute('href', new RegExp(`/trade/\\?league=wnba(&give=\\d+)+&get=${await row.getAttribute('data-player')}$`));
    }
  }
  // a player let go opens the Trade page with that player on the give side
  const spare = tile.getByTestId('build-surplus').getByTestId('build-row').first();
  const id = (await spare.getAttribute('data-player'))!;
  const name = await spare.locator('a').first().innerText();
  const more = spare.getByRole('link', { name: 'more on Trade →' });
  await expect(more).toHaveAttribute('href', new RegExp(`/trade/\\?league=wnba&give=${id}(&|$)`));
  const results = await new AxeBuilder({ page }).include('[data-testid="build-plan"]').withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations).toEqual([]);
  if (isMobile) expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
  await more.click();
  await expect(page).toHaveURL(/\/trade\//);
  await expect(page.getByTestId('picked-give')).toContainText(name);
});

test('without rival rosters Build your team ranks targets by need-weighted value and says importing adds the deals; a points league has none (#809)', async ({ page }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/wnba.json')).json()) as { full_name: string; team_abbreviation: string; position: string }[];
  const label = (p: (typeof board)[number]) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
  await page.goto('/league/');
  for (const i of [0, 5, 9]) await page.getByLabel('Add a player to Team 1', { exact: true }).fill(label(board[i]!));
  await page.getByLabel('Punt PTS').check({ force: true });
  await page.goto('/team/');
  const tile = page.getByTestId('build-plan');
  await expect(tile.getByTestId('build-import')).toContainText('Import your league to see swaps and trades');
  await expect(tile.getByTestId('build-targets').getByTestId('build-row')).toHaveCount(5);
  await expect(tile.getByTestId('build-move')).toHaveCount(0);
  await expect(tile.getByTestId('build-surplus').getByTestId('build-row')).toHaveCount(3);
  // the punt: out of the picture, and named as counting for nothing
  await expect(tile.getByTestId('build-cat')).toHaveCount(8);
  await expect(tile.locator('[data-cat="z_points"]')).toHaveCount(0);
  await expect(tile).toContainText('Punted, counting for nothing: PTS');
  const first = tile.getByTestId('build-targets').getByTestId('build-row').first();
  await expect(first.getByTestId('build-link')).toHaveAttribute('href', new RegExp(`/trade/\\?league=wnba&get=${await first.getAttribute('data-player')}$`));
  await page.goto('/league/');
  await page.getByLabel('Scoring').selectOption('points');
  await page.goto('/team/');
  await expect(page.getByTestId('roster-table')).toBeVisible();
  await expect(page.getByTestId('build-plan')).toHaveCount(0);
});

test('My Team plans the week lineup under the league slots: starts, games lost to a full lineup, and open slots to stream (#735)', async ({ page }) => {
  type Row = { player_id: string; full_name: string | null; team_id: string | null; team_abbreviation: string; position: string; injury_group: string | null };
  type Game = { game_date: string; days_ahead: number; home_team_id: string; away_team_id: string };
  const board = (await (await page.request.get('/data/builds/fixture/board/nba.json')).json()) as Row[];
  const games = (await (await page.request.get('/data/builds/fixture/schedule/nba.json')).json()) as Game[];
  // the fixture's own "today" (days ahead 0): the day Pickups counts its window from, too
  const day = games.find((g) => g.days_ahead === 0)?.game_date ?? '';
  test.skip(!day, 'the fixture has no game today');
  await page.clock.setFixedTime(new Date(`${day}T16:00:00Z`));
  const playing = new Set(games.filter((g) => g.game_date === day).flatMap((g) => [g.home_team_id, g.away_team_id]));
  // four healthy guards who all play today: a one-guard, one-utility lineup must sit two of them
  const guards = board.filter((r) => r.full_name && r.team_id && playing.has(r.team_id) && !r.injury_group && r.position === 'G').slice(0, 4);
  test.skip(guards.length < 4, 'the fixture has too few guards playing on its busiest day');
  const label = (p: Row) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
  await page.goto('/league/?league=nba');
  await page.getByLabel('Format').selectOption('h2h');
  for (const [k, n] of [['G', '1'], ['F', '1'], ['C', '1'], ['Util', '1']] as const) await page.getByLabel(`${k} slots`).fill(n);
  for (const g of guards) await page.getByLabel('Add a player to Team 1', { exact: true }).fill(label(g));
  await page.goto('/team/?league=nba');
  const tile = page.getByTestId('lineup-plan');
  await expect(tile.getByTestId('lineup-summary')).toContainText('You can start');
  const today = tile.locator(`tr[data-date="${day}"]`);
  // G and Util take two guards today; the other two sit, and F and C stay open
  await expect(today.locator('td').nth(1)).toHaveText('2');
  await expect(today.getByTestId('open-slots')).toHaveText('1 F · 1 C');
  await expect(today.locator('td').nth(3)).toContainText(',');
  await expect(tile.getByTestId('lineup-summary')).toContainText('lost to a full lineup');
  // the open days go to Pickups, this week's window with those days picked
  await tile.getByTestId('lineup-pickups').click();
  await expect(page).toHaveURL(new RegExp(`/streamers/\\?league=nba&window=week&open=[^&]*${day}`));
  await expect(page.getByRole('radio', { name: /^This week/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel(`Open on ${day}`)).toBeChecked();
});

test('the lineup setting resets with the rest, and a Pickups link with a day outside its window still lists players (#735)', async ({ page }) => {
  await page.goto('/league/?league=nba');
  await expect(page.getByRole('button', { name: 'Reset settings' })).toHaveCount(0);
  await page.getByLabel('G slots').fill('1');
  await page.getByRole('button', { name: 'Reset settings' }).click();
  await expect(page.getByLabel('G slots')).toHaveValue('3');
  // a day long past is not in the window: it picks nothing and filters nothing
  await page.goto('/streamers/?league=nba&window=week&open=2001-01-01');
  await expect(page.getByTestId('trending').locator('tbody tr').first()).toBeVisible();
  await expect(page.getByTestId('trending').locator('thead')).not.toContainText('Open days');
});

test('My Team ranks every team by projection: matchup win rates in head-to-head, roto points in rotisserie (#743)', async ({ page }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/wnba.json')).json()) as { full_name: string; team_abbreviation: string; position: string }[];
  const label = (p: (typeof board)[number]) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
  await page.goto('/league/');
  await page.getByLabel('Format').selectOption('h2h');
  await page.getByLabel('Teams in the league').fill('4');
  await page.getByLabel('Roster spots').fill('6');
  for (let i = 0; i < 24; i += 1) await page.getByLabel(`Add a player to Team ${(i % 4) + 1}`, { exact: true }).fill(label(board[i]!));
  await page.goto('/team/');
  const table = page.getByTestId('league-table');
  await expect(table).toContainText('Power rankings');
  const rows = table.getByTestId('power-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.first().locator('td').first()).toHaveText('1');
  // every matchup has a winner: the rates average one half
  const rates = (await rows.locator('td:nth-child(3)').allInnerTexts()).map((s) => Number(s.replace('%', '')));
  expect(rates.reduce((s, r) => s + r, 0) / rates.length).toBeGreaterThanOrEqual(48);
  expect(rates.reduce((s, r) => s + r, 0) / rates.length).toBeLessThanOrEqual(52);
  expect(rates[0]).toBeGreaterThanOrEqual(rates[3]!);
  await page.goto('/league/');
  await page.getByLabel('Format').selectOption('roto');
  await page.goto('/team/');
  await expect(table.locator('thead')).toContainText('Roto pts');
  await expect(table.locator('thead')).not.toContainText('Win %');
});

test('My Team suggests IL moves from the board availability and applies them', async ({ page }) => {
  const rows = (await (await page.request.get('/data/builds/fixture/board/nba.json')).json()) as {
    full_name: string | null;
    expected_games_missed: number | null;
    injury_group: string | null;
  }[];
  const hurt = rows.find((r) => (r.expected_games_missed ?? 0) >= 3 && r.full_name);
  const healthy = rows.find((r) => !r.injury_group && r.full_name && r.full_name !== hurt?.full_name);
  if (!hurt || !healthy) {
    test.skip(true, 'the fixture has no listed-out player');
    return;
  }
  await page.goto('/league/?league=nba');
  const cards = page.getByTestId('team-card');
  await cards.nth(0).getByText('Paste a roster').click();
  await page.getByLabel('Paste names for Team 1', { exact: true }).fill(`${hurt.full_name}\n${healthy.full_name}`);
  await cards.nth(0).getByRole('button', { name: 'Add pasted players' }).click();
  await expect(cards.nth(0).getByTestId('paste-result')).toContainText('Added 2');
  await page.goto('/team/?league=nba');
  const candidates = page.getByTestId('il-candidates');
  await expect(candidates).toContainText(hurt.full_name ?? '');
  await expect(candidates).not.toContainText(healthy.full_name ?? '');
  await candidates.getByTestId('il-move').first().click();
  await expect(page.getByTestId('roster-table').locator('tr').filter({ hasText: hurt.full_name ?? '' })).toContainText('IL');
  await expect(page.getByTestId('il-candidates')).toHaveCount(0);
  // a healthy player parked on the IL by hand on the League page is offered back
  await page.goto('/league/?league=nba');
  const row = cards.nth(0).getByTestId('roster').locator('li').filter({ hasText: healthy.full_name ?? '' });
  await row.getByRole('button', { name: /^Injured list:/ }).click();
  await page.goto('/team/?league=nba');
  const back = page.getByTestId('il-back');
  await expect(back).toContainText(healthy.full_name ?? '');
  await back.getByTestId('il-move').first().click();
  await expect(page.getByTestId('il-back')).toHaveCount(0);
});

test('a draft on the Draft page snakes pick by pick, here and on the board, with undo', async ({ page }) => {
  await page.goto('/league/');
  await page.getByLabel('Teams in the league').fill('4');
  await expect(page.getByTestId('draft-panel')).toHaveCount(0);
  await page.goto('/draft/');
  await expect(page.locator('h1')).toContainText('Coming soon');
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

test('the Draft page prices players for an auction; Rankings carries no price (#741, #825)', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr[data-player]').first()).toBeVisible();
  await expect(board.getByTestId('auction')).toHaveCount(0);
  await expect(board.locator('thead th', { hasText: /^\$$/ })).toHaveCount(0);
  await page.goto('/draft/');
  await page.getByRole('button', { name: 'Start a draft' }).click();
  await expect(page.getByTestId('best-available').getByTestId('draft-auction').first()).toHaveText(/^\$\d+$/);
});

test('Rankings shows each player game range on demand, and the player page the range in the outlook (#747)', async ({ page }) => {
  await page.route('**/board/wnba*.json', async (route) => {
    const body = (await (await route.fetch()).json()) as Record<string, unknown>[] | Record<string, unknown[]>;
    if (Array.isArray(body)) {
      await route.fulfill({ json: body.map((r, i) => ({ ...r, game_floor: -1 + i * 0.01, game_ceiling: 6 - i * 0.01, game_value_sd: 2 + (i % 5) })) });
    } else {
      const n = (Object.values(body)[0] as unknown[]).length;
      await route.fulfill({
        json: { ...body, game_floor: Array.from({ length: n }, (_, i) => -1 + i * 0.01), game_ceiling: Array.from({ length: n }, (_, i) => 6 - i * 0.01), game_value_sd: Array.from({ length: n }, (_, i) => 2 + (i % 5)) },
      });
    }
  });
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr[data-player]').first()).toBeVisible();
  await expect(board.locator('thead')).not.toContainText('Ceiling');
  await page.getByTestId('board-options-toggle').click();
  await page.getByLabel(/Consistency columns/).check();
  await expect(board.locator('thead')).toContainText('Floor');
  await expect(board.locator('thead')).toContainText('Spread');
  await expect(board.locator('tbody tr[data-player]').first().locator('td[data-col="game_ceiling"]')).toHaveText(/^\+\d\.\d$/);
  // steadiest first: the spread sorts low to high
  await board.getByRole('button', { name: /^Spread/ }).click();
  await expect(board.locator('tbody tr[data-player]').first().locator('td[data-col="game_value_sd"]')).toHaveText('2.0');
  await page.route('**/players/wnba/1628932.json', async (route) => {
    const file = (await (await route.fetch()).json()) as { board: Record<string, unknown> | null };
    if (file.board) Object.assign(file.board, { game_floor: 1.5, game_ceiling: 9.25 });
    await route.fulfill({ json: file });
  });
  await page.goto('/p/wnba/1628932/');
  await expect(page.getByTestId('game-range')).toHaveText('+1.5 to +9.3');
});

test('the value view groups the board into tiers by pick and round, and ranks players by position', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr[data-player]').first()).toBeVisible();
  const heads = board.getByTestId('tier-head');
  await expect(heads.first()).toContainText(/^Tier 1 · (pick 1 \(round 1\) · value [\d.]+$|picks 1–\d+ \(rounds? 1)/);
  expect(await heads.count()).toBeGreaterThan(1);
  await expect(page.getByTestId('tier-note')).toContainText('natural breaks');
  await expect(board.getByTestId('pos-rank').first()).toHaveText(/^\([GFC]1\)$/);
  await page.getByRole('radio', { name: 'Season line' }).click();
  await expect(heads).toHaveCount(0);
});

test('the League page imports a public ESPN league: settings, lineup, teams and rosters; a private one says how to open it (#745)', async ({ page }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/nba.json')).json()) as { full_name: string }[];
  const entry = (i: number) => ({ lineupSlotId: 0, playerPoolEntry: { player: { fullName: board[i]!.full_name } } });
  const league = {
    settings: {
      name: 'Hoops Club',
      size: 4,
      rosterSettings: { lineupSlotCounts: { '0': 1, '1': 1, '2': 1, '3': 1, '4': 1, '5': 1, '6': 1, '11': 3, '12': 3, '13': 1 } },
      scoringSettings: { scoringType: 'H2H_MOST_CATEGORIES', scoringItems: [0, 6, 3, 2, 1, 17, 19, 20, 11].map((statId) => ({ statId, points: 0 })) },
    },
    teams: [
      { name: 'Brick City', roster: { entries: [entry(0), entry(1)] } },
      { location: 'Glass', nickname: 'Cleaners', roster: { entries: [entry(2), { lineupSlotId: 12, playerPoolEntry: { player: { fullName: 'Nobody Atall' } } }] } },
      { name: 'Third', roster: { entries: [entry(3)] } },
      { name: 'Fourth', roster: { entries: [entry(4)] } },
    ],
  };
  let asked = '';
  await page.route('https://lm-api-reads.fantasy.espn.com/**', (route) => {
    asked = route.request().url();
    return route.request().url().includes('/leagues/999999') ? route.fulfill({ status: 401, json: { messages: ['not authorized'] } }) : route.fulfill({ json: league });
  });
  await page.goto('/league/?league=nba');
  const card = page.getByTestId('espn-import');
  await card.getByLabel('ESPN league address or ID').fill('https://fantasy.espn.com/basketball/league?leagueId=123456');
  await card.getByRole('button', { name: 'Import' }).click();
  await expect(card.getByTestId('espn-note')).toContainText('Imported Hoops Club: 4 teams, 5 of 6 players matched. Not on the board: Nobody Atall.');
  expect(asked).toMatch(/\/fba\/seasons\/\d{4}\/segments\/0\/leagues\/123456\?view=mTeam/);
  await expect(page.getByLabel('Format')).toHaveValue('h2h');
  await expect(page.getByLabel('Roster spots')).toHaveValue('13');
  await expect(page.getByLabel('G slots')).toHaveValue('3');
  await expect(page.getByLabel('Util slots')).toHaveValue('3');
  await expect(page.getByLabel('Name of team 2')).toHaveValue('Glass Cleaners');
  await expect(page.getByTestId('team-card').nth(0).getByTestId('roster')).toContainText(board[1]!.full_name);
  // a private league: the page says how to open it
  page.once('dialog', (d) => void d.accept());
  await card.getByLabel('ESPN league address or ID').fill('999999');
  await card.getByRole('button', { name: 'Import' }).click();
  await expect(card.getByTestId('espn-note')).toContainText('Make League Viewable to Public');
});

test('/league/ and /draft/ have no accessibility violations', async ({ page }) => {
  await page.goto('/draft/');
  await page.getByRole('button', { name: 'Start a draft' }).click();
  const best = page.getByTestId('best-available').locator('li');
  await best.first().getByRole('button', { name: /^Draft / }).click();
  await best.first().getByRole('button', { name: /^Draft / }).click();
  await expect(page.getByTestId('pick-log').locator('li')).toHaveCount(2);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.goto('/league/');
  await expect(page.getByTestId('draft-link')).toBeVisible();
  await expect(page.getByTestId('team-card').first()).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
});

test('the League page leads with the Yahoo import only while the league is empty, and folds full rosters to one open card (#716)', async ({ page }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/nba.json')).json()) as { full_name: string; team_abbreviation: string; position: string }[];
  const label = (p: (typeof board)[number]) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
  await page.goto('/league/?league=nba');
  await expect(page.getByTestId('yahoo-soon')).toBeVisible();
  await expect(page.getByTestId('yahoo-folded')).toHaveCount(0);
  await page.getByLabel('Teams in the league').fill('4');
  await page.getByLabel('Roster spots').fill('6');
  for (let i = 0; i < 24; i += 1) await page.getByLabel(`Add a player to Team ${(i % 4) + 1}`, { exact: true }).fill(label(board[i]!));
  // with rosters in, the import is one folded line
  const folded = page.getByTestId('yahoo-folded');
  await expect(folded).toContainText('Re-import from Yahoo');
  await expect(folded.getByTestId('yahoo-soon')).toBeHidden();
  // every roster full: your card stays open, the other folds to a name and a count
  await expect(page.getByTestId('team-card')).toHaveCount(1);
  await expect(page.getByTestId('team-card-folded')).toHaveCount(3);
  await expect(page.getByTestId('team-card-folded').first()).toHaveText(/Team 2\s*6\/6/);
  await page.getByTestId('team-card-folded').first().click();
  await expect(page.getByTestId('team-card').getByLabel('Name of team 2')).toBeVisible();
  await expect(page.getByTestId('team-card-folded').first()).toContainText('My team');
  // the league table is on My Team now
  await expect(page.getByTestId('team-strength')).toHaveCount(0);
  await page.goto('/team/?league=nba');
  await expect(page.getByTestId('team-strength').locator('tbody tr')).toHaveCount(4);
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
  await page.getByTestId('schedule-card').locator('summary').click();
  await page.getByLabel('More columns').check();
  const grid = page.getByTestId('week-grid');
  await expect(grid.getByTestId('implied-points').first()).toHaveText(/^(82|78) pts$/);
  const team = season!.games[0].home_team_tricode;
  const row = grid.locator('tbody tr').filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^${team}$`) }) });
  await expect(row.locator('td[title]').first()).toHaveAttribute('title', new RegExp(`^Over/under 160, \\w+ -4\\.5 \\(DraftKings, as of [^)]+\\): ${team} implied (82\\.25|77\\.75) points`));
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
      official_report_at: '2026-10-29T22:45:00+00:00', // 18:45 Eastern (EDT): the export publishes the instant (#387)
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
      json: { ...file, board: { ...(file.board ?? { rank_total: 3 }), market_rank: 7, ownership_bucket: 'most', lineup_role: 'starter', lineup_confirmed: true, season_complete: false } },
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
  await expect(board.locator('tbody tr[data-player]').first().getByTestId('value')).toHaveText(/\d/);
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

test('a board whose market ranks no one has no market columns, and the ownership trend sits with the name (#451)', async ({ page }) => {
  // The WNBA's ESPN data has ownership but no draft position.
  await page.route('**/board/wnba*.json', async (route) => {
    const body = (await (await route.fetch()).json()) as Record<string, unknown> | Record<string, unknown>[];
    if (Array.isArray(body)) {
      await route.fulfill({ json: body.map((r) => ({ ...r, market_rank: null, ownership_bucket: 'most', ownership_trend: 'rising' })) });
    } else {
      const n = (Object.values(body)[0] as unknown[]).length;
      await route.fulfill({
        json: { ...body, market_rank: Array(n).fill(null), ownership_bucket: Array(n).fill('most'), ownership_trend: Array(n).fill('rising') },
      });
    }
  });
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr[data-player]').first()).toBeVisible();
  await expect(board.locator('thead')).not.toContainText('Mkt');
  await expect(board.getByTestId('market-rank')).toHaveCount(0);
  // the arrow is in the player's own cell, with the other name tags
  await expect(board.locator('tbody tr[data-player]').first().getByTestId('trend-tag')).toHaveCount(1);
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


test("Trade's no-roster sentence names the manager's settings, the same summary as the League bar (#453)", async ({ page }) => {
  await page.goto('/league/');
  await page.getByLabel('Teams in the league').fill('6');
  await page.getByLabel('Scoring').selectOption('points');
  await expect(page.getByTestId('team-card')).toHaveCount(6);
  // The League bar sits on the Board.
  await page.goto('/');
  await expect(page.getByTestId('league-summary')).toHaveText('6 teams × 10, Points');
  const summary = await page.getByTestId('league-summary').textContent();
  await page.goto('/trade/');
  await expect(page.getByTestId('trade-settings')).toHaveText(summary!);
  await expect(page.getByTestId('trade-no-league')).toContainText(`Values are for your settings (${summary}).`);
  await expect(page.getByTestId('trade-no-league')).not.toContainText('9 categories');
});

test('punts are a league setting: chosen on the League page, they reach the board and the Trade page (#661)', async ({ page }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/wnba.json')).json()) as { full_name: string; team_abbreviation: string; position: string }[];
  const label = (p: (typeof board)[number]) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
  await page.goto('/league/');
  await page.getByLabel('Punt PTS').check({ force: true });
  await page.getByLabel('Punt AST').check({ force: true });
  await page.goto('/');
  const table = page.getByTestId('board');
  await expect(table.locator('tbody tr[data-player]').first()).toBeVisible();
  await expect(table.locator('thead [data-cat]')).toHaveCount(7);
  await expect(page.getByTestId('league-summary')).toContainText('punting PTS, AST');
  await expect(page).toHaveURL(/[?&]punt=pts-ast(&|$)/);

  await page.goto('/trade/');
  await page.getByLabel('Add a player you give').fill(label(board[1]!));
  await page.getByLabel('Add a player you get').fill(label(board[0]!));
  await expect(page.getByTestId('trade-punts')).toContainText('Punting PTS, AST');
  await expect(page.getByTestId('trade-categories').locator('tbody tr')).toHaveCount(7);

  // The board's chips edit the same setting.
  await page.goto('/');
  await expect(table.locator('tbody tr[data-player]').first()).toBeVisible();
  await page.getByTestId('active-filters').getByRole('button', { name: 'Clear all' }).click();
  await page.goto('/league/');
  await expect(page.getByLabel('Punt PTS')).not.toBeChecked();
  await expect(page.getByLabel('Punt AST')).not.toBeChecked();
});

test('signed in to a Yahoo account, the League page takes the account’s newer setup and saves each change to it (#684)', async ({ page }) => {
  const saved: { setup: Record<string, unknown>; savedAt: number }[] = [];
  await page.route('**/api/account/status', (route) => route.fulfill({ json: { configured: true, signedIn: true } }));
  await page.route('**/api/account/setup?league=wnba', async (route) => {
    if (route.request().method() === 'PUT') {
      saved.push(route.request().postDataJSON() as (typeof saved)[number]);
      return route.fulfill({ json: { saved: true } });
    }
    // the account holds a 6-team league saved later than anything in this fresh browser
    return route.fulfill({ json: { setup: { version: 5, teams: 6, rosterSpots: 10, scoring: 'cats9', format: 'h2h', punts: ['z_points'], focus: ['z_blocks'] }, savedAt: Date.now() + 60_000 } });
  });
  await page.goto('/league/');
  await expect(page.getByTestId('account-box')).toContainText('Saved to your Yahoo account');
  await expect(page.getByTestId('team-card')).toHaveCount(6);
  await expect(page.getByLabel('Punt PTS')).toBeChecked();
  await page.getByLabel('Teams in the league').fill('7');
  await expect.poll(() => saved.at(-1)?.setup['teams']).toBe(7);
  expect(saved.at(-1)?.savedAt).toBeGreaterThan(0);
});

test('not signed in, the League page offers the Yahoo sign-in that saves the league to an account (#684)', async ({ page }) => {
  await page.route('**/api/account/status', (route) => route.fulfill({ json: { configured: true, signedIn: false } }));
  await page.goto('/league/');
  await expect(page.getByTestId('account-signin')).toHaveAttribute('href', '/auth/account/start?league=wnba');
});

test('the scouting notes show each note with the numbers it states traced to the board history, the rejections and the eval (phase 7)', async ({ page }) => {
  const rowRef = 'fct_board_history/wnba/1628932/2026-09-01..2026-09-08';
  await page.route('**/data/notes/wnba.json', (route) =>
    route.fulfill({
      json: {
        league: 'wnba',
        label: 'AI-drafted from FantasyScout data',
        model: 'qwen3:8b',
        generated_at: '2026-09-08T14:40:00+00:00',
        compared: { before: '2026-09-01', after: '2026-09-08' },
        counts: { drafted: 2, published: 1, rejected: 1, numbers_written: 5, numbers_traced: 4 },
        notes: [
          {
            player_id: '1628932',
            name: "A'ja Wilson",
            team: 'LVA',
            reason: 'riser',
            headline: 'Wilson climbs with more minutes',
            body: 'Projected minutes rose by 2.3 to 33.8. Rest-of-season value increased by 2.2 to 13.4. Start her.',
            confidence: 'high',
            claims: [
              { metric: 'projected_minutes.change', value: 2.3, row_ref: rowRef },
              { metric: 'value_rest_of_season.after', value: 13.4, row_ref: rowRef },
            ],
          },
        ],
        rejected: [{ player_id: '1', name: 'Someone Else', reasons: ["the text states 85%, which is not one of the build's numbers"] }],
      },
    }),
  );
  await page.route('**/data/notes/evals.json', (route) =>
    route.fulfill({
      json: { model: 'qwen3:8b', generated_at: '2026-09-08T14:40:00+00:00', leagues: { wnba: { weeks: [{}, {}], drafted: 20, rejection_rate: 0.25, claim_accuracy: 0.9, published_claims_verified: 1 } } },
    }),
  );
  await page.goto('/notes/');
  await expect(page.getByTestId('notes-meta')).toContainText('drafted by qwen3:8b');
  const note = page.getByTestId('note');
  await expect(note).toHaveCount(1);
  await expect(note).toContainText('Wilson climbs with more minutes');
  await note.locator('summary').click();
  await expect(note.getByTestId('note-claims')).toContainText('projected minutes change: 2.3');
  await expect(note.getByTestId('note-claims')).toContainText(rowRef);
  await expect(page.getByTestId('notes-rejected')).toContainText("85%, which is not one of the build's numbers");
  await expect(page.getByTestId('notes-eval')).toContainText('90% were the build');
});

test('before the first notes, the notes page says when they come (phase 7)', async ({ page }) => {
  await page.goto('/notes/');
  await expect(page.getByTestId('notes-none')).toContainText('drafted every Monday');
});

test('a trade the market calls lopsided is not called even: the lenses are shown and a warning stops the manager (#692)', async ({ page }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/nba.json')).json()) as {
    player_id: string;
    full_name: string;
    team_abbreviation: string;
    position: string;
    market_rank: number | null;
  }[];
  // the manager gives a player the market prices as its first pick, for three it ranks near 300
  const star = board[40]!;
  const depth = [board[2]!, board[3]!, board[4]!];
  await page.route('**/board/nba.json', (route) =>
    route.fulfill({
      json: board.map((r) => ({
        ...r,
        market_rank: r.player_id === star.player_id ? 1 : depth.some((d) => d.player_id === r.player_id) ? 300 : null,
      })),
    }),
  );
  const label = (p: (typeof board)[number]) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
  await page.goto('/trade/?league=nba');
  await page.getByLabel('Add a player you give').fill(label(star));
  for (const p of depth) await page.getByLabel('Add a player you get').fill(label(p));
  const warning = page.getByTestId('trade-warning');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('terrible trade for you');
  await expect(warning).toContainText("ESPN's ranks");
  await expect(page.getByTestId('trade-fairness')).toContainText('Not clearly even');
  await expect(page.getByTestId('trade-fairness-market')).toContainText('partner +');
  await expect(page.getByTestId('trade-fairness-disagree')).toHaveCount(1);
  // the scorecard leads with the call and the lenses (#694)
  await expect(page.getByTestId('trade-call')).toHaveText('Bad for you');
  await expect(page.getByTestId('lens-market')).toContainText('Team 2 +');
  await expect(page.getByTestId('lens-value')).toContainText('you +');
  await expect(page.getByTestId('trade-verdict')).not.toContainText('About even');
});

for (const league of ['wnba', 'nba']) {
  test(`on a phone the ${league} board's largest paint is its static intro, not a later card (#704, #717)`, async ({ page, isMobile }) => {
    test.skip(!isMobile, 'mobile project only');
    await page.addInitScript(() => {
      const w = window as unknown as { lcp: (Element | null)[] };
      w.lcp = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as (PerformanceEntry & { element?: Element })[]) w.lcp.push(e.element ?? null);
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    });
    await page.goto(`/?league=${league}`);
    await page.getByTestId('board').locator('tbody tr').first().waitFor();
    await page.waitForTimeout(1000);
    // a card React paints later and larger than the intro would hold the LCP over the 2 s budget
    expect(await page.evaluate(() => (window as unknown as { lcp: (Element | null)[] }).lcp.at(-1)?.getAttribute('data-testid'))).toBe('intro');
  });
}

test('UI polish: a phone sees each value beside the name, a day without games has no Today card, and the footer reads cleanly (#696)', async ({ page }) => {
  await page.goto('/');
  const first = page.getByTestId('board').locator('tbody tr[data-player]').first();
  await expect(first).toBeVisible();
  // the value is the third column, beside the pinned name, on a phone too (#714)
  await expect(first.getByTestId('value')).toBeInViewport();
  // the fixture's WNBA season is over: no games today, so no Today card
  await expect(page.getByTestId('today')).toHaveCount(0);
  await expect(page.locator('footer')).toContainText('any bookmaker. Sources, terms and what is published');
});

test('live AI: a signed-in manager has the trade explained from its own numbers; others are asked to sign in (#702)', async ({ page }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/wnba.json')).json()) as { full_name: string; team_abbreviation: string; position: string }[];
  const label = (p: (typeof board)[number]) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
  let sent: { facts?: Record<string, unknown> } = {};
  await page.route('**/api/ai/status', (route) => route.fulfill({ json: { available: true, signedIn: true } }));
  await page.route('**/api/ai/explain-trade', async (route) => {
    sent = route.request().postDataJSON() as typeof sent;
    await route.fulfill({ json: { explanation: 'Take it: the value leans your way.' } });
  });
  await page.goto('/trade/');
  await page.getByLabel('Add a player you give').fill(label(board[1]!));
  await page.getByLabel('Add a player you get').fill(label(board[0]!));
  await page.getByRole('button', { name: 'Explain this trade' }).click();
  await expect(page.getByTestId('explain-text')).toHaveText('Take it: the value leans your way.');
  expect(sent.facts?.['you_give']).toEqual([board[1]!.full_name]);
  expect(sent.facts?.['you_get']).toEqual([board[0]!.full_name]);

  await page.unroute('**/api/ai/status');
  await page.route('**/api/ai/status', (route) => route.fulfill({ json: { available: true, signedIn: false } }));
  await page.reload();
  await page.getByLabel('Add a player you give').fill(label(board[1]!));
  await expect(page.getByTestId('explain-signin')).toContainText('Sign in with Yahoo');
});

test('every Streamers column says what it holds, and the box-score columns are the last five games (#456)', async ({ page }) => {
  await page.goto('/streamers/?league=nba');
  const table = page.getByTestId('trending');
  await expect(table.locator('tbody tr').first()).toBeVisible();
  await page.getByLabel('More columns').check();
  const untitled = await table.locator('thead th').evaluateAll((ths) =>
    ths.filter((th) => !th.hasAttribute('title') && !th.querySelector('[title]')).map((th) => th.textContent?.trim()),
  );
  expect(untitled).toEqual([]);
  await expect(table.locator('thead')).toContainText('PTS (5)');
  await expect(table.getByRole('button', { name: 'PTS (5)' })).toHaveAttribute('title', 'Points per game, last five games');
  // the intro describes the same baseline the columns use
  await expect(page.locator('main > section > p').first()).toContainText("each player's baseline");
  await expect(page.locator('main')).not.toContainText('twenty-game');
});

// WCAG 2.5.8: a pointer target is at least 24 by 24 CSS pixels (#457). A checkbox counts with the
// label that wraps it, which is what a tap lands on; links inside sentences are exempt.
test('every control on the Board is at least 24 by 24', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('board').locator('tbody tr[data-player]').first()).toBeVisible();
  const small = await page.locator('main').evaluate((main) => {
    const out: string[] = [];
    for (const el of main.querySelectorAll<HTMLElement>('button, select, summary, input:not([type="hidden"])')) {
      const target = (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') && el.closest('label')) || el;
      const box = target.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (box.width === 0 || style.visibility === 'hidden' || el.classList.contains('sr-only') && !el.closest('label')) continue;
      if (box.width < 24 || box.height < 24) out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
    return [...new Set(out)];
  });
  expect(small).toEqual([]);
});

// After the WNBA's last game nothing on its pages speaks of the rest of the season, the next seven
// days or a clinched place (#450). The fixture's WNBA season is complete.
test('the off-season WNBA pages drop in-season wording', async ({ page }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/wnba.json')).json()) as { full_name: string; team_abbreviation: string; position: string; season_complete: boolean }[];
  expect(board.every((r) => r.season_complete)).toBe(true);
  const absent = (text: string) => {
    expect(text).not.toMatch(/rest of season/i);
    expect(text).not.toMatch(/next 7 days/i);
    expect(text).not.toContain('Clinched');
  };
  await page.goto('/p/wnba/1628932/');
  await expect(page.getByTestId('season-over')).toHaveText('2026 season over · 2027 projection');
  absent(await page.locator('main').innerText());
  await page.goto('/streamers/');
  await expect(page.getByTestId('trending').locator('tbody tr').first()).toBeVisible();
  await expect(page.getByTestId('weeks-grid')).toHaveCount(0);
  absent(await page.locator('main').innerText());
  const label = (p: (typeof board)[number]) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
  await page.goto('/trade/');
  await page.getByLabel('Add a player you give').fill(label(board[1]!));
  await page.getByLabel('Add a player you get').fill(label(board[0]!));
  await expect(page.getByTestId('trade-verdict')).toContainText('for the next season');
  await expect(page.getByTestId('trade-players').locator('thead')).toContainText('Next season');
  await expect(page.getByTestId('trade-players').locator('thead')).not.toContainText('Available');
  absent(await page.locator('main').innerText());
});

// Part of a name is enough: the list under the box filters as you type, Enter takes the first
// (best on the board), and text that matches nobody says so (#454). League uses the same picker.
test('the player picker finds a player from part of a name and Enter adds the best match', async ({ page }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/wnba.json')).json()) as { full_name: string; team_abbreviation: string }[];
  const first = board[0]!;
  const part = first.full_name.split(' ').at(-1)!.slice(0, 4).toLowerCase();
  await page.goto('/trade/');
  const box = page.getByLabel('Add a player you give');
  await box.fill(part);
  const options = page.getByTestId('player-options').first();
  await expect(options.getByRole('option').first()).toBeVisible();
  await expect(box).toHaveAttribute('aria-expanded', 'true');
  await box.press('Enter');
  await expect(page.getByTestId('picked-give')).toContainText(first.full_name);
  await expect(box).toHaveValue('');
  await box.fill('zzqx');
  await expect(page.getByTestId('player-no-match')).toHaveText('No player matches “zzqx”.');
  // the arrow keys move the choice
  await box.fill(part);
  await box.press('ArrowDown');
  await expect(page.getByTestId('player-options').first().getByRole('option', { selected: true })).toHaveCount(1);
  // the League page has the same picker
  await page.goto('/league/');
  const team = page.getByLabel('Add a player to Team 1', { exact: true });
  await team.fill(part);
  await team.press('Enter');
  await expect(page.getByTestId('team-card').first()).toContainText(first.full_name);
});

// Columns the export ships are shown (#463): games played beside Min (5) on Streamers, and the
// season's z-scores beside the last twenty and last ten games' on the player page.
test('the player page says where the player stands in your league and takes the next step: add, or trade for (#726)', async ({ page }) => {
  const board = (await (await page.request.get('/data/builds/fixture/board/wnba.json')).json()) as { player_id: string; full_name: string; team_abbreviation: string; position: string }[];
  const label = (p: (typeof board)[number]) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;
  const player = board.find((r) => r.player_id === '1628932')!;
  const other = board.find((r) => r.player_id !== player.player_id && r.full_name)!;
  await page.goto('/p/wnba/1628932/');
  await expect(page.getByTestId('league-status')).toContainText('Set up your league');
  // the trend labels each line's latest value; no source-agreement columns
  await expect(page.getByTestId('trend-last').locator('text').first()).toHaveText(/^[A-Z]+ \d+\.\d$/);
  await expect(page.getByTestId('season-lines').locator('thead')).not.toContainText('Sources');
  // available in a league with rosters: one tap adds the player to your team
  await page.goto('/league/');
  await page.getByLabel('Add a player to Team 1', { exact: true }).fill(label(other));
  await page.goto('/p/wnba/1628932/');
  const status = page.getByTestId('league-status');
  await expect(status).toContainText('Available in your league');
  await status.getByRole('button', { name: 'Add to Team 1' }).click();
  await expect(status).toContainText('On your team');
  await expect(status.getByRole('link', { name: 'Offer in a trade' })).toHaveAttribute('href', '/trade/?league=wnba&give=1628932');
  // on another team: Trade for opens the Trade page with the player asked for and that team as the partner
  await page.goto('/league/');
  const mine = page.getByTestId('team-card').nth(0).getByTestId('roster').locator('li').filter({ hasText: player.full_name });
  await mine.getByRole('button', { name: /^Remove / }).click();
  await page.getByLabel('Add a player to Team 2', { exact: true }).fill(label(player));
  await page.goto('/p/wnba/1628932/');
  await expect(status).toContainText('On Team 2');
  await status.getByRole('link', { name: /^Trade for / }).click();
  await expect(page).toHaveURL(/\/trade\/\?league=wnba&get=1628932$/);
  await expect(page.getByTestId('picked-get')).toContainText(player.full_name);
  await expect(page.getByLabel('Trade partner')).toHaveValue('1');
});

test('streamers shows games played, and the player page sets recent z-scores beside the season', async ({ page }) => {
  await page.goto('/streamers/?league=nba');
  const table = page.getByTestId('trending');
  await expect(table.locator('tbody tr').first()).toBeVisible();
  await page.getByLabel('More columns').check();
  await expect(table.getByRole('button', { name: 'GP', exact: true })).toHaveAttribute('title', /Games played this season/);
  await page.goto('/p/wnba/1628932/');
  const windows = page.getByTestId('category-windows');
  await expect(windows.locator('tbody tr').first()).toContainText('Season');
  await expect(windows.locator('tbody tr')).toHaveCount(3);
  await expect(windows.locator('tbody')).toContainText('Last 20');
  await expect(windows.locator('tbody')).toContainText('Last 10');
});

// A starter whose team's next game has a spread of 10 or more carries a flag; nobody else does (#486).
test('streamers flags a starter whose next game is lopsided on the line', async ({ page }) => {
  await page.route('**/schedule/nba*.json', async (route) => {
    const games = (await (await route.fetch()).json()) as Record<string, unknown>[];
    await route.fulfill({ json: games.map((g) => ({ ...g, home_spread: -14 })) });
  });
  await page.route('**/streamers/nba.json', async (route) => {
    const rows = (await (await route.fetch()).json()) as Record<string, unknown>[];
    await route.fulfill({ json: rows.map((r) => ({ ...r, lineup_role: 'starter' })) });
  });
  await page.goto('/streamers/?league=nba');
  const table = page.getByTestId('trending');
  await expect(table.locator('tbody tr').first()).toBeVisible();
  const tags = table.getByTestId('blowout');
  await expect(tags.first()).toBeVisible();
  await expect(tags.first()).toHaveAttribute('title', /spread is 14 points: starters play about 2\.0 fewer minutes/);
  // the same rows off the bench carry no flag
  await page.unroute('**/streamers/nba.json');
  await page.route('**/streamers/nba.json', async (route) => {
    const rows = (await (await route.fetch()).json()) as Record<string, unknown>[];
    await route.fulfill({ json: rows.map((r) => ({ ...r, lineup_role: 'bench' })) });
  });
  await page.reload();
  await expect(table.locator('tbody tr').first()).toBeVisible();
  await expect(table.getByTestId('blowout')).toHaveCount(0);
});

// A streamer whose team's largest-usage player is out for the next game carries a tag naming them (#485).
test("streamers tags a candidate whose team's top-usage teammate is out", async ({ page }) => {
  await page.route('**/streamers/nba.json', async (route) => {
    const rows = (await (await route.fetch()).json()) as Record<string, unknown>[];
    await route.fulfill({ json: rows.map((r) => ({ ...r, top_teammate_out: 'Star Player', top_teammate_out_usage: 0.31 })) });
  });
  await page.goto('/streamers/?league=nba');
  const table = page.getByTestId('trending');
  await expect(table.locator('tbody tr').first()).toBeVisible();
  const tag = table.getByTestId('top-out').first();
  await expect(tag).toHaveText('TOP OUT');
  await expect(tag).toHaveAttribute('title', /^Star Player \(31% of the team's possessions\) is out for the next game/);
  await expect(page.getByTestId('tag-legend')).toContainText('TOP OUT');
});

// The dbt docs have their own chrome and no way back, so the nav opens them in a new tab; a betting
// line says who posted it and when (#462).
test('every feature not yet backtested says so and links the issue that will validate it (#764)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('board').locator('tbody tr[data-player]').first()).toBeVisible();
  const status = page.getByTestId('validation-status');
  await expect(status.getByTestId('unvalidated')).toHaveCount(3);
  for (const [issue, label] of [[754, 'value'], [755, 'Fit'], [761, 'consistency']] as const) {
    await expect(status.locator(`a[href$="/issues/${issue}"]`)).toHaveText(label);
  }
  await page.goto('/streamers/');
  await expect(page.locator('#trending').getByTestId('unvalidated')).toHaveAttribute('href', /\/issues\/762$/);
  await page.goto('/p/wnba/1628932/');
  await expect(page.locator('#outlook').getByTestId('unvalidated')).toHaveAttribute('href', /\/issues\/754$/);
  // and defense vs position is gone: an earlier study found positional defence is noise (ADR 0012)
  await page.goto('/streamers/?league=nba');
  await expect(page.getByTestId('trending').locator('tbody tr').first()).toBeVisible();
  await expect(page.locator('main')).not.toContainText('Defense vs position');
});

test('the docs open in a new tab and the line cells name their provider and date', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('nav-behind-the-data').locator('summary').click();
  const docs = page.getByRole('link', { name: /^Docs/ });
  await expect(docs).toHaveAttribute('target', '_blank');
  await expect(docs).toHaveAttribute('rel', 'noopener');
  await page.goto('/streamers/?league=nba');
  const cell = page.locator('[data-testid="week-grid"] td[title*="Over/under"]').first();
  await expect(cell).toHaveAttribute('title', /\(DraftKings, as of [A-Z][a-z]{2} \d{1,2}, \d{4}\)/);
});

// Copy and control polish (#460): a note that repeats the status is left out, a return beyond a
// finished season says next season, the starters filter names its game day, and an 8-category
// league cannot punt turnovers.
test('the injury card, the starters filter and the punt chips say only what holds', async ({ page }) => {
  await page.route('**/players/wnba/*.json', async (route) => {
    const file = (await (await route.fetch()).json()) as { board: Record<string, unknown> | null };
    if (file.board) Object.assign(file.board, { injury_group: 'out', injury_status: 'Out', injury_note: 'out', injury_news: null, expected_return: '2027-05-01', season_complete: true });
    await route.fulfill({ json: file });
  });
  await page.goto('/p/wnba/1628932/');
  const card = page.getByTestId('injury-card');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('injury-news')).toHaveCount(0);
  await expect(card.getByTestId('expected-return')).toHaveText('· expected back next season (May 1, 2027)');

  await page.route('**/streamers/nba.json', async (route) => {
    const rows = (await (await route.fetch()).json()) as Record<string, unknown>[];
    await route.fulfill({ json: rows.map((r) => ({ ...r, lineup_role: 'starter', lineup_date: '2099-01-02' })) });
  });
  await page.goto('/streamers/?league=nba');
  await expect(page.getByTestId('starters-label')).toHaveText('Starting Fri, Jan 2');

  await page.goto('/league/');
  await page.getByLabel('Scoring').selectOption('cats8');
  await page.goto('/');
  await page.getByTestId('board').locator('tbody tr').first().waitFor();
  await page.getByTestId('board-options-toggle').click();
  const chip = page.locator('fieldset label', { hasText: /^TO$/ });
  await expect(chip.locator('input')).toBeDisabled();
  await expect(chip).toHaveAttribute('title', /does not count turnovers/);
});

test('the board keeps its punts and filters in the URL, through a reload and a copied link', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr[data-player]').first()).toBeVisible();
  await page.getByTestId('board-options-toggle').click();
  await page.locator('fieldset label', { hasText: /^PTS$/ }).click();
  await expect(page).toHaveURL(/[?&]punt=pts(&|$)/);
  await page.reload();
  await expect(page.getByTestId('active-filters')).toContainText('Punt PTS');
  await expect(board.locator('thead [data-cat="z_points"]')).toHaveCount(0);

  // a link someone copied: punt FT%, 20+ MPG, healthy only
  await page.goto('/?punt=ft&mpg=20&avail=healthy');
  const chips = page.getByTestId('active-filters');
  await expect(chips).toContainText('Punt FT%');
  await expect(chips).toContainText('20+ MPG');
  await expect(chips).toContainText('Healthy only');
  await page.getByRole('button', { name: 'Remove 20+ MPG' }).click();
  await expect(page).not.toHaveURL(/mpg=/);
  await expect(page).toHaveURL(/punt=ft/);
});

test('"Clear all" on the board clears every punt, not only the last', async ({ page }) => {
  await page.goto('/');
  const board = page.getByTestId('board');
  await expect(board.locator('tbody tr[data-player]').first()).toBeVisible();
  await page.getByTestId('board-options-toggle').click();
  await page.locator('fieldset label', { hasText: /^PTS$/ }).click();
  await page.locator('fieldset label', { hasText: /^AST$/ }).click();
  await expect(board.locator('thead [data-cat]')).toHaveCount(7);
  await page.getByTestId('active-filters').getByRole('button', { name: 'Clear all' }).click();
  await expect(page.getByTestId('active-filters')).toHaveCount(0);
  await expect(board.locator('thead [data-cat]')).toHaveCount(9);
});
