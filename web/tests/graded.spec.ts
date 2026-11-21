/**
 * Last week, graded (#1058): the owner's card on My Team. His week's chances are logged once a
 * week from his browser, and last week's are graded against Yahoo's final totals. For everyone
 * else My Team is unchanged and asks nothing new of the owner's routes. Invented names only.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

type Row = { player_id: string };
type Score = { totals: Record<string, number>; shots: Record<string, [number, number]> };

const score = (t: [number, number, number, number, number, number, number], fg: [number, number], ft: [number, number]): Score => ({
  totals: { z_points: t[0], z_rebounds_total: t[1], z_assists: t[2], z_steals: t[3], z_blocks: t[4], z_three_pointers_made: t[5], z_turnovers: t[6] },
  shots: { z_field_goal_pct: fg, z_free_throw_pct: ft },
});

// the week of Monday 2026-11-23, Yahoo's week 9: the manager (team 0) against Summit (team 1).
// Won points, rebounds and FG%; lost assists, threes, FT% and turnovers (more of them); tied
// steals; won blocks.
const MINE = score([520, 210, 100, 30, 25, 60, 70], [200, 400], [80, 100]);
const SUMMIT = score([500, 190, 120, 30, 20, 70, 60], [180, 400], [90, 100]);

// the chances the matchup card gave on that Monday, as the log keeps them
const CHANCES = { PTS: 0.7, REB: 0.4, AST: 0.3, STL: 0.6, BLK: 0.5, '3PM': 0.45, 'FG%': 0.55, 'FT%': 0.8, TO: 0.2 };
const EXPECTED: Record<string, [string, string, string]> = {
  PTS: ['70%', 'won', 'call right'],
  REB: ['40%', 'won', 'call wrong'],
  AST: ['30%', 'lost', 'call right'],
  STL: ['60%', 'tied', 'no call'],
  BLK: ['50%', 'won', 'no call'],
  '3PM': ['45%', 'lost', 'call right'],
  'FG%': ['55%', 'won', 'call right'],
  'FT%': ['80%', 'lost', 'call wrong'],
  TO: ['20%', 'lost', 'call right'],
};
// over the eight categories won or lost (steals tied)
const BRIER = [0.3, 0.6, 0.3, 0.5, 0.45, 0.45, 0.8, 0.2].reduce((s, d) => s + d * d, 0) / 8;

const logLine = (o: Record<string, unknown>) => JSON.stringify({ at: '2026-11-23T15:00:00.000Z', ...o });
const WEEK_RECORD = logLine({
  kind: 'call',
  date: '2026-11-23',
  call: 'week-chances',
  subject: 'nba:2026-11-23:1',
  value: JSON.stringify({ w: 9, c: CHANCES, s: null }),
  naive: 0.5,
  build: 'b1',
});

/** A made-up eight-team Yahoo head-to-head league, as the import keeps it, ten players a team. */
async function seedLeague(page: Page, now: Date, weeks: unknown[] | null): Promise<{ rosters: string[][] }> {
  const board = (await (await page.request.get('/data/builds/fixture/board/nba.json')).json()) as Row[];
  const teams = 8;
  const rosters = Array.from({ length: teams }, (_, t) => Array.from({ length: 10 }, (_, k) => board[t + teams * k]!.player_id));
  const copy = {
    version: 10,
    teams,
    rosterSpots: 13,
    scoring: 'cats9',
    format: 'h2h',
    punts: [],
    names: ['Harbor', 'Summit', 'Prairie', 'Canyon', 'Delta', 'Ridge', 'Meadow', 'Coast'],
    rosters,
    mine: 0,
    il: [],
    drafting: false,
    picks: [],
    opponent: 1,
    lineup: { G: 3, F: 3, C: 1, UTIL: 3 },
    ilSlots: 2,
    addsPerWeek: 4,
    waiverDays: 2,
    source: {
      host: 'yahoo',
      leagueId: '99',
      syncedAt: now.getTime() - 3_600_000,
      rosters,
      changes: null,
      opponents: [1, 0, 3, 2, 5, 4, 7, 6],
      ...(weeks ? { weeks } : {}),
    },
  };
  await page.clock.setFixedTime(now);
  await page.addInitScript((stored) => localStorage.setItem('fantasyscout:league:nba', stored), JSON.stringify(copy));
  return { rosters };
}

/** This browser as the owner: the flag his sign-in leaves, the Worker agreeing, and his log. */
async function asOwner(page: Page, log: string, posted: Record<string, unknown>[] = []): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('fantasyscout:owner', '1'));
  await page.route('**/api/owner/status', (r) => r.fulfill({ json: { configured: true, owner: true } }));
  await page.route('**/api/owner/log', (r) => {
    if (r.request().method() === 'POST') {
      posted.push(r.request().postDataJSON() as Record<string, unknown>);
      return r.fulfill({ json: { logged: true } });
    }
    return r.fulfill({ status: 200, contentType: 'application/x-ndjson; charset=utf-8', body: log });
  });
}

const teamsOf = (mine: Score | null, theirs: Score | null) => [mine, theirs, null, null, null, null, null, null];
const FINAL_WEEK_9 = { week: 9, final: true, teams: teamsOf(MINE, SUMMIT) };
const WEEK_10 = { week: 10, final: false, teams: teamsOf(score([10, 4, 2, 1, 0, 1, 1], [4, 9], [1, 1]), score([12, 3, 1, 0, 1, 2, 2], [5, 10], [2, 2])) };

async function axe(page: Page) {
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    const found = await new AxeBuilder({ page }).include('[data-testid="graded"]').withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(found.violations, theme).toEqual([]);
  }
}

test("the owner's My Team logs the week's chances once a week, and says when grading starts (#1058)", async ({ page }) => {
  // a Monday before the first graded week is over
  await seedLeague(page, new Date('2026-11-02T16:00:00Z'), null);
  const posted: Record<string, unknown>[] = [];
  await asOwner(page, '', posted);
  for (let visit = 0; visit < 2; visit += 1) {
    await page.goto('/team/?league=nba');
    await expect(page.getByTestId('matchup-table')).toBeVisible();
    await expect(page.getByTestId('graded-start')).toHaveText('Grading starts with the week of Monday, Nov 23; the first grade shows on Monday, Nov 30.');
    await page.waitForLoadState('networkidle');
  }
  const chances = posted.filter((e) => e['call'] === 'week-chances');
  expect(chances).toHaveLength(1);
  const [e] = chances;
  expect(e).toMatchObject({ kind: 'call', date: '2026-11-02', subject: 'nba:2026-11-02:1', naive: 0.5, build: 'fixture' });
  const value = JSON.parse(String(e!['value'])) as { w: unknown; c: Record<string, number>; s: unknown };
  // the nine categories the card shows, each a chance; no Yahoo week without one in the import, no score so far
  expect(Object.keys(value.c).sort()).toEqual(['3PM', 'AST', 'BLK', 'FG%', 'FT%', 'PTS', 'REB', 'STL', 'TO']);
  expect(Object.values(value.c).every((p) => p >= 0 && p <= 1)).toBe(true);
  expect(value).toMatchObject({ w: null, s: null });
  await axe(page);
});

test('the day before the first grade, the card still says when grading starts (#1058)', async ({ page }) => {
  await seedLeague(page, new Date('2026-11-29T23:00:00Z'), [FINAL_WEEK_9]);
  await asOwner(page, WEEK_RECORD);
  await page.goto('/team/?league=nba');
  await expect(page.getByTestId('graded-start')).toBeVisible();
  await expect(page.getByTestId('graded-table')).toHaveCount(0);
});

test("last week's categories are graded against Yahoo's final totals, with the running record (#1058)", async ({ page }) => {
  // Tuesday of the week after: the import of Monday holds week 9 final
  const { rosters } = await seedLeague(page, new Date('2026-12-01T16:00:00Z'), [FINAL_WEEK_9, WEEK_10]);
  const [add, drop] = [rosters[7]![9]!, rosters[0]![9]!];
  const calls = [
    WEEK_RECORD,
    logLine({ kind: 'call', date: '2026-11-24', call: 'stream', subject: `${add} for ${drop}`, value: 'z_steals: 3 games on the open days, flips none', naive: null, build: 'b1' }),
    logLine({ kind: 'call', date: '2026-11-25', call: 'trade-verdict', subject: 'a > b', value: 'fair', naive: null, build: 'b1' }),
  ];
  const week = (player_id: string, games: number) => ({
    league: 'nba',
    season: '2026-27',
    player_id,
    week_start: '2026-11-23',
    games_scheduled: 4,
    games_played: games,
    points: 61,
    rebounds_total: 22,
    assists: 9,
    steals: 5,
    blocks: 2,
    three_pointers_made: 8,
    turnovers: 6,
    field_goals_made: 21,
    field_goals_attempted: 44,
    free_throws_made: 11,
    free_throws_attempted: 13,
  });
  await page.route('**/player_week/nba.json', (r) => r.fulfill({ json: [week(add, 3), week(drop, 2)] }));
  await asOwner(page, [...calls, ''].join('\n'));
  await page.goto('/team/?league=nba');
  const card = page.getByTestId('graded');
  await expect(card.getByRole('heading', { name: 'Last week, graded' })).toBeVisible();
  await expect(card.getByTestId('graded-summary')).toContainText('The week of Monday, Nov 23 against Summit: 5 of 7 calls right.');
  const rows = card.getByTestId('graded-row');
  await expect(rows).toHaveCount(9);
  for (const [label, [chance, result, call]] of Object.entries(EXPECTED)) {
    const row = rows.filter({ has: page.getByRole('cell', { name: label, exact: true }) });
    await expect(row.getByRole('cell').nth(1), label).toHaveText(chance);
    await expect(row.getByTestId('graded-result'), label).toHaveText(result, { ignoreCase: true });
    await expect(row.getByTestId('graded-call'), label).toHaveText(call);
  }
  // the totals as Yahoo scored them, a percentage from its makes and attempts
  await expect(rows.filter({ hasText: 'FG%' }).getByTestId('graded-final')).toHaveText('50.0–45.0%');
  await expect(rows.and(page.locator('[data-cat="z_turnovers"]')).getByTestId('graded-final')).toHaveText('70–60');
  await expect(card.getByTestId('graded-running')).toContainText(
    `Running record over 1 week: 5 of 7 calls right · Brier score ${BRIER.toFixed(3)} against a coin's 0.25 (lower is better).`,
  );
  await expect(card.getByTestId('graded-running')).toContainText('A 50% chance, or a category tied, is no call.');
  // the preview's calls: the stream graded by its players' week, the trade listed as not graded
  const stream = card.locator('[data-testid="graded-call-line"][data-call="stream"]');
  await expect(stream).toContainText('The stream, from Tue, Nov 24:');
  await expect(stream).toContainText('(add): 3 games of 4 · 61 PTS · 22 REB · 9 AST · 5 STL · 2 BLK · 8 3PM · 6 TO · FG 21/44 · FT 11/13');
  await expect(stream).toContainText('(drop): 2 games of 4');
  await expect(card.locator('[data-testid="graded-call-line"][data-call="trade-verdict"]')).toHaveText("A trade's verdict: not graded: no plain measure yet.");
  await axe(page);
});

test("a week whose totals are not imported asks for an import; the preview's calls wait on the player data (#1058)", async ({ page }) => {
  await seedLeague(page, new Date('2026-11-30T16:00:00Z'), [{ ...FINAL_WEEK_9, final: false }]);
  await page.route('**/player_week/nba.json', (r) => r.fulfill({ status: 404, body: 'not in this build' }));
  await asOwner(page, [WEEK_RECORD, logLine({ kind: 'call', date: '2026-11-24', call: 'top-adds', subject: 'x1 x2', value: 'v', naive: null, build: 'b1' }), ''].join('\n'));
  await page.goto('/team/?league=nba');
  const card = page.getByTestId('graded');
  await expect(card.getByTestId('graded-import')).toContainText('Import from Yahoo after the week ends to grade it.');
  await expect(card.getByTestId('graded-import-link')).toHaveAttribute('href', '/league/#yahoo');
  await expect(card.getByTestId('graded-running')).toContainText('Running record: no week graded yet.');
  await expect(card.locator('[data-testid="graded-call-line"][data-call="top-adds"]')).toHaveText("Top adds: graded once the week's player data is published.");
  await axe(page);
});

test('signed out, and signed in as anyone but the owner, My Team shows no graded card and asks nothing new (#1058)', async ({ page }) => {
  await seedLeague(page, new Date('2026-12-01T16:00:00Z'), [FINAL_WEEK_9, WEEK_10]);
  const asked: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith('/api/owner/')) asked.push(`${r.method()} ${url.pathname}`);
  });
  await page.route('**/api/owner/status', (r) => r.fulfill({ json: { configured: true, owner: false } }));
  await page.route('**/api/owner/log', (r) => r.fulfill({ status: 401, json: { error: 'the owner only' } }));
  const html = async () => {
    await page.goto('/team/?league=nba');
    await expect(page.getByTestId('my-roster')).toBeVisible();
    await page.waitForLoadState('networkidle');
    return page.locator('main').innerHTML();
  };
  const signedOut = await html();
  expect(asked).toEqual([]);
  expect(signedOut).not.toContain('Last week, graded');
  // a browser an owner sign-in once flagged, the Worker saying it is not the owner's: the status
  // check the nav already makes, and nothing else
  await page.evaluate(() => localStorage.setItem('fantasyscout:owner', '1'));
  expect(await html()).toBe(signedOut);
  expect(asked.every((a) => a === 'GET /api/owner/status')).toBe(true);
  expect(asked.length).toBeLessThanOrEqual(1);
});
