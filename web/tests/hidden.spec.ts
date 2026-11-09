/**
 * The site shows only calls that passed their check (#936, #937): the hidden ones stay off every
 * page, from one switch list (src/lib/visibility.ts), and the data under them stays as data.
 */
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import { SHOWS } from '../src/lib/visibility';

type Row = { player_id: string; full_name: string; team_abbreviation: string; position: string; [k: string]: unknown };

const label = (p: Row) => `${p.full_name} · ${p.team_abbreviation} · ${p.position}`;

async function boardOf(page: Page, league: 'nba' | 'wnba'): Promise<Row[]> {
  return (await (await page.request.get(`/data/builds/fixture/board/${league}.json`)).json()) as Row[];
}

test('the Draft and Notes addresses send their visitor to Rankings, which says why in a line (#937)', async ({ page }) => {
  test.skip(SHOWS.draft || SHOWS.notes, 'both pages are shown');
  await page.goto('/draft/');
  await expect(page).toHaveURL(/\/(\?league=\w+)?$/);
  await expect(page.getByTestId('paused-page')).toHaveText('Draft tools return before the 2027-28 drafts.');
  await expect(page.getByTestId('board').locator('tbody tr[data-player]').first()).toBeVisible();
  // the line has been said: a reload or a copied link does not carry it
  expect(new URL(page.url()).searchParams.has('from')).toBe(false);
  await page.goto('/notes/');
  await expect(page.getByTestId('paused-page')).toContainText('Scouting notes are off until their calls are judged');
  await expect(page.getByRole('radio', { name: 'Last 10' })).toHaveAttribute('aria-checked', 'true');
  // a page that is off is not offered to crawlers
  const sitemap = await (await page.request.get('/sitemap.xml')).text();
  expect(sitemap).not.toContain('/draft/');
  expect(sitemap).not.toContain('/notes/');
});

test("Rankings and the player page show no hidden call: no AI note, no consistency, no games-missed estimate (#937)", async ({ page }) => {
  test.skip(SHOWS.notes || SHOWS.consistency || SHOWS.injuryEstimate, 'shown');
  const board = await boardOf(page, 'wnba');
  const first = board[0]!;
  let notesRead = false;
  await page.route('**/data/notes/players/*.json', (route) => {
    notesRead = true;
    return route.fulfill({ json: { league: 'wnba', notes: { [first.player_id]: { action: 'start', line: 'Start him.', sources: [] } } } });
  });
  await page.route('**/board/wnba.json', (route) =>
    route.fulfill({
      json: board.map((r, i) =>
        i === 0 ? { ...r, injury_group: 'questionable', injury_status: 'Questionable', injury_source: 'espn', expected_games_missed: 1.43, expected_return: null } : r,
      ),
    }),
  );
  await page.goto('/');
  const table = page.getByTestId('board');
  await expect(table.locator('tbody tr[data-player]').first()).toBeVisible();
  await expect(table.locator('tbody tr[data-note-for]')).toHaveCount(0);
  // the injury listing shows; the estimate of the games he will miss does not
  await expect(table.getByTestId('injury-tag').first()).toHaveAttribute('title', /ESPN's injury listing/);
  await expect(table.getByTestId('injury-tag').first()).not.toHaveAttribute('title', /missed .* games on average/);
  await page.getByTestId('board-options-toggle').click();
  await expect(page.getByTestId('board-options')).toBeVisible();
  await expect(page.getByTestId('board-options')).not.toContainText('Consistency columns');
  await expect(table.locator('thead')).not.toContainText(/Floor|Ceiling|Spread/);

  await page.route('**/players/wnba/1628932.json', async (route) => {
    const file = (await (await route.fetch()).json()) as { board: Record<string, unknown> };
    await route.fulfill({ json: { ...file, board: { ...file.board, game_floor: -1.2, game_ceiling: 3.4, availability_multiplier: 0.8, expected_games_missed: 2.5, expected_return: null } } });
  });
  await page.goto('/p/wnba/1628932/');
  await expect(page.getByTestId('player-outlook')).toBeVisible();
  await expect(page.getByTestId('game-range')).toHaveCount(0);
  await expect(page.getByTestId('player-outlook')).not.toContainText('Expected to miss');
  await expect(page.getByTestId('player-outlook')).not.toContainText('Available for');
  await expect(page.getByTestId('player-page-note')).toHaveCount(0);
  // no page reads the notes while their calls are hidden
  expect(notesRead).toBe(false);
});

test('Pickups lists players by window value as a labelled table, with no "Top 3" call and no Apply (#937)', async ({ page }) => {
  test.skip(SHOWS.topAdds, 'the top adds are shown');
  for (const league of ['wnba', 'nba'] as const) {
    const games = (await (await page.request.get(`/data/builds/fixture/schedule/${league}.json`)).json()) as { days_ahead: number }[];
    if (!games.some((g) => g.days_ahead <= 6)) continue;
    await page.goto(`/streamers/?league=${league}`);
    await expect(page.getByTestId('trending').locator('tbody tr').first()).toBeVisible();
    await expect(page.getByTestId('top-adds')).toHaveCount(0);
    await expect(page.getByTestId('top-add-apply')).toHaveCount(0);
    await expect(page.getByTestId('explore')).toHaveAttribute('open', '');
    await expect(page.getByTestId('explore-summary')).toContainText('Players by window value');
    const caption = page.getByTestId('pickups-table-label');
    await expect(caption).toContainText('by window value in the next 7 days');
    await expect(caption).toContainText('A table to sort, not a pick list');
    await expect(caption.getByTestId('unvalidated')).toHaveAttribute('href', /\/issues\/762$/);
    return;
  }
  test.skip(true, 'no fixture league has a game in the next seven days');
});

test('the Trade page keeps buy low in the NBA, and hides the calls that failed (#937)', async ({ page }) => {
  test.skip(SHOWS.tradeFinder || SHOWS.tradeChips || SHOWS.sellHigh || SHOWS.buyLowWnba || !SHOWS.buyLowNba, 'shown');
  const cats = ['z_points', 'z_rebounds_total', 'z_assists', 'z_steals', 'z_blocks', 'z_three_pointers_made', 'z_field_goal_pct', 'z_free_throw_pct', 'z_turnovers'];
  const shift = (r: Row, by: number) => Object.fromEntries(cats.filter((c) => typeof r[c] === 'number').map((c) => [`recent_${c}`, (r[c] as number) + by]));
  for (const league of ['nba', 'wnba'] as const) {
    const board = await boardOf(page, league);
    const hot = board[12]!;
    const cold = board[1]!;
    await page.route(`**/board/${league}.json`, (route) =>
      route.fulfill({ json: board.map((r) => (r === hot ? { ...r, ...shift(r, 1) } : r === cold ? { ...r, injury_group: null, ...shift(r, -1) } : r)) }),
    );
    await page.goto(`/league/?league=${league}`);
    await page.getByLabel('Format').selectOption('h2h');
    await page.getByLabel('Roster spots').fill('6');
    for (const c of ['PTS', 'AST', '3PM']) await page.getByLabel(`Punt ${c}`).check({ force: true });
    for (const [team, picked] of [[1, [0, 5, 9, 12]], [2, [1, 2, 7, 13]], [3, [3, 4, 8, 14]]] as const) {
      for (const i of picked) await page.getByLabel(`Add a player to Team ${team}`, { exact: true }).fill(label(board[i]!));
    }
    await page.goto(`/trade/?league=${league}`);
    await expect(page.getByTestId('roster-give').locator('li')).toHaveCount(4);
    const tabs = page.getByTestId('trade-tabs');
    if (league === 'nba') {
      // buy low passed in the NBA (ADR 0027): its tab holds it alone, with no sell high beside it
      await expect(tabs.getByRole('radio')).toHaveText(['Build', 'Buy low']);
      await tabs.getByRole('radio', { name: 'Buy low' }).click();
      await expect(page.locator('#buy-sell h2')).toHaveText('Buy low');
      await expect(page.getByTestId('sell-high')).toHaveCount(0);
      await expect(page.getByTestId('trade-chips')).toHaveCount(0);
      const buy = page.getByTestId('buy-low').getByTestId('swing').filter({ hasText: cold.full_name });
      await buy.getByRole('button', { name: 'Ask for' }).click();
      await expect(page.getByTestId('picked-get')).toContainText(cold.full_name);
    } else {
      // in the WNBA buy low failed (#904): the page is Build alone
      await expect(tabs).toHaveCount(0);
      await expect(page.locator('#buy-sell')).toHaveCount(0);
    }
    await page.unroute(`**/board/${league}.json`);
  }
  // the trade itself: what it does to the categories, no suggestions, no "even" or "favours"
  await page.getByTestId('roster-give').getByRole('checkbox').first().check();
  await page.getByTestId('roster-get').getByRole('checkbox').first().check();
  await expect(page.locator('#verdict h2')).toHaveText('What the trade does');
  await expect(page.getByTestId('trade-category-verdict')).toContainText('expect to win');
  await expect(page.getByTestId('trade-verdict')).not.toContainText(/Favours|Fair|Even|About even|Win-win|reason to accept/);
  await expect(page.getByTestId('trade-suggestions')).toHaveCount(0);
  await expect(page.getByTestId('explain-trade')).toHaveCount(0);
  await expect(page.getByTestId('explain-signin')).toHaveCount(0);
});
