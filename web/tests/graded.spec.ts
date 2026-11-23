/**
 * Last week, graded (#1058): the owner's card on My Team, with his preview on. His week's chances
 * go to the log with the preview's calls, and last week's are graded against Yahoo's final totals;
 * every preview call of the week is graded or says why not, tied to its entry by its key. For
 * everyone else, and for the owner with the switch off, My Team is unchanged. Invented data only.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { callKey, keysIn, planBatch, validCall } from '../../worker/src/owner-log-event';
import { expect as baseExpect, test } from './fixtures';

const expect = baseExpect.configure({ timeout: 15_000 });

type Row = { player_id: string };
type Score = { totals: Record<string, number>; shots: Record<string, [number, number]> };

const score = (t: [number, number, number, number, number, number, number], fg: [number, number], ft: [number, number]): Score => ({
  totals: { z_points: t[0], z_rebounds_total: t[1], z_assists: t[2], z_steals: t[3], z_blocks: t[4], z_three_pointers_made: t[5], z_turnovers: t[6] },
  shots: { z_field_goal_pct: fg, z_free_throw_pct: ft },
});

// the week of Monday 2026-11-23, Yahoo's week 9: the manager (team 0) against Summit (team 1).
// Won points, rebounds, FG% and blocks; lost assists, threes, FT% and turnovers (more of them); tied steals.
const MINE = score([520, 210, 100, 30, 25, 60, 70], [200, 400], [80, 100]);
const SUMMIT = score([500, 190, 120, 30, 20, 70, 60], [180, 400], [90, 100]);

// the chances the matchup card gave on that Monday
const CHANCES: Record<string, number> = {
  z_points: 0.7,
  z_rebounds_total: 0.4,
  z_assists: 0.3,
  z_steals: 0.6,
  z_blocks: 0.5,
  z_three_pointers_made: 0.45,
  z_field_goal_pct: 0.55,
  z_free_throw_pct: 0.8,
  z_turnovers: 0.2,
};
const EXPECTED: Record<string, [string, string, string]> = {
  z_points: ['70%', 'won', 'call right'],
  z_rebounds_total: ['40%', 'won', 'call wrong'],
  z_assists: ['30%', 'lost', 'call right'],
  z_steals: ['60%', 'tied', 'no call'],
  z_blocks: ['50%', 'won', 'no call'],
  z_three_pointers_made: ['45%', 'lost', 'call right'],
  z_field_goal_pct: ['55%', 'won', 'call right'],
  z_free_throw_pct: ['80%', 'lost', 'call wrong'],
  z_turnovers: ['20%', 'lost', 'call right'],
};
// over the eight categories won or lost (steals tied)
const BRIER = [0.3, 0.6, 0.3, 0.5, 0.45, 0.45, 0.8, 0.2].reduce((s, d) => s + d * d, 0) / 8;

const NOW = new Date('2026-11-30T16:00:00Z');
const IMPORT = `yahoo:99:${NOW.getTime() - 3_600_000}`;

/** A log line as the Worker stores a batch's call. */
const entry = (date: string, call: string, subject: string, value: string | number, naive: string | number | null = null) =>
  ({ at: `${date}T15:00:00.000Z`, kind: 'call', date, call, subject, value, naive, build: 'b1', league: IMPORT }) as Record<string, unknown>;
const chanceLines = (date: string, chances = CHANCES) => [
  ...Object.entries(chances).map(([cat, p]) => entry(date, 'week-chance', `nba 2026-11-23 vs 1 ${cat}`, p, 0.5)),
  entry(date, 'week-chance', 'nba 2026-11-23 vs 1 yahoo-week', 'week 9'),
];
const text = (lines: Record<string, unknown>[]) => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;

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

/** This browser as the owner, his preview on or off, with his log: a batch is answered by the Worker's own rule; a GET returns `log`. */
async function asOwner(page: Page, log: string, switchOn = true, posted: Record<string, unknown>[] = []): Promise<void> {
  await page.addInitScript((on) => {
    localStorage.setItem('fantasyscout:owner', '1');
    if (on) localStorage.setItem('fantasyscout:owner-preview', 'on');
  }, switchOn);
  await page.route('**/api/owner/status', (r) => r.fulfill({ json: { configured: true, owner: true } }));
  await page.route('**/api/owner/log', (r) => {
    if (r.request().method() !== 'POST') return r.fulfill({ status: 200, contentType: 'application/x-ndjson; charset=utf-8', body: log });
    const body: unknown = r.request().postDataJSON();
    if ((body as { kind?: string }).kind !== 'calls') return r.fulfill({ json: { logged: true } });
    const plan = planBatch(body, keysIn(posted.map((c) => JSON.stringify(c)).join('\n')))!;
    posted.push(...plan.write);
    return r.fulfill({ json: { results: plan.results } });
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

test("before the first grade, the card says when it comes and shows no grade; the week's chances go to the log, one entry a category (#1058)", async ({ page }) => {
  // a Monday before the first graded week is over, with games this week
  await seedLeague(page, new Date('2026-11-02T16:00:00Z'), null);
  const posted: Record<string, unknown>[] = [];
  await asOwner(page, '', true, posted);
  await page.goto('/team/?league=nba');
  const card = page.getByTestId('graded');
  await expect(card.getByTestId('graded-start')).toHaveText('Grading starts with the week of Monday, Nov 23; the first grade shows on Monday, Nov 30.');
  await expect(card.getByTestId('graded-table')).toHaveCount(0);
  await expect(card.getByTestId('graded-running')).toHaveCount(0);
  await expect(card).not.toContainText('%');
  await expect.poll(() => posted.filter((e) => e['call'] === 'week-chance').length).toBe(10);
  const chances = posted.filter((e) => e['call'] === 'week-chance');
  // one entry a category, each a chance against a coin's, and the Yahoo week (none known without weeks)
  const cats = chances.filter((e) => /^nba 2026-11-02 vs 1 z_/.test(String(e['subject'])));
  expect(cats).toHaveLength(9);
  for (const e of cats) expect(e).toMatchObject({ naive: 0.5, value: expect.any(Number) });
  expect(chances.find((e) => String(e['subject']).endsWith('yahoo-week'))).toMatchObject({ value: 'not known' });
  for (const e of chances) expect(validCall(Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'kind')))).not.toBeNull();
  // a second view adds nothing
  await page.reload();
  await expect(card.getByTestId('graded-start')).toBeVisible();
  await page.waitForTimeout(2500);
  expect(posted.filter((e) => e['call'] === 'week-chance')).toHaveLength(10);
  await axe(page);
});

test("last week's categories are graded against Yahoo's final totals, with the running record, and every preview call graded or saying why (#1058)", async ({ page }) => {
  const { rosters } = await seedLeague(page, NOW, [FINAL_WEEK_9, WEEK_10]);
  const [add, drop] = [rosters[7]![9]!, rosters[0]![9]!];
  const calls = [
    entry('2026-11-24', 'stream', `${add} for ${drop}`, 'for z_steals: 3 games on the open days, flips none'),
    entry('2026-11-24', 'too-close', 'vs 1 z_points z_steals', 'against Summit: Winning 4, losing 3, 2 too close', 'Winning 5, losing 4'),
    entry('2026-11-25', 'swaps', 'held back', 'all 2 held back: no adds left this week'),
    entry('2026-11-25', 'build', 'category z_points', 'Points · 3rd of 8 · 62%'),
    // an old single call from before the log's present form: no import named, never graded
    { at: '2026-11-24T15:00:00.000Z', kind: 'call', date: '2026-11-24', call: 'stream', subject: 'old', value: 'v', naive: null, build: 'b0' },
  ];
  const week = (player_id: string, games: number, points = 61) => ({
    league: 'nba',
    season: '2026-27',
    player_id,
    week_start: '2026-11-23',
    games_scheduled: 4,
    games_played: games,
    points,
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
  await page.route('**/player_week/nba.json', (r) => r.fulfill({ json: [week(add, 3), week(drop, 0, 0)] }));
  await asOwner(page, text([...chanceLines('2026-11-23'), ...calls]));
  await page.goto('/team/?league=nba');
  const card = page.getByTestId('graded');
  await expect(card.getByRole('heading', { name: 'Last week, graded' })).toBeVisible();
  await expect(card.getByTestId('graded-summary')).toContainText('The week of Monday, Nov 23 against Summit: 5 of 7 category calls right.');
  const rows = card.getByTestId('graded-row');
  await expect(rows).toHaveCount(9);
  for (const [cat, [chance, result, call]] of Object.entries(EXPECTED)) {
    const row = rows.and(page.locator(`[data-cat="${cat}"]`));
    await expect(row.getByRole('cell').nth(1), cat).toHaveText(chance);
    await expect(row.getByTestId('graded-result'), cat).toHaveText(result, { ignoreCase: true });
    await expect(row.getByTestId('graded-call'), cat).toHaveText(call);
    // each grade tied to its log entry by the entry's key
    await expect(row, cat).toHaveAttribute('data-key', callKey(chanceLines('2026-11-23').find((l) => String(l['subject']).endsWith(cat))!));
  }
  await expect(rows.and(page.locator('[data-cat="z_field_goal_pct"]')).getByTestId('graded-final')).toHaveText('50.0–45.0%');
  await expect(rows.and(page.locator('[data-cat="z_turnovers"]')).getByTestId('graded-final')).toHaveText('70–60');
  await expect(card.getByTestId('graded-running')).toContainText(
    `Running record over 1 week: 5 of 7 category calls right · Brier score ${BRIER.toFixed(3)} over 8 categories won or lost, against a coin's 0.25 (lower is better).`,
  );
  // the preview's calls: all four of the present form, none dropped, the old one not among them
  await expect(card.getByTestId('graded-calls-count')).toHaveText('4 calls logged that week: 2 graded, 2 not graded, each saying why.');
  const lines = card.getByTestId('graded-call-line');
  await expect(lines).toHaveCount(4);
  expect((await lines.evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))).sort()).toEqual(calls.slice(0, 4).map((c) => callKey(c)).sort());
  for (const k of await card.getByTestId('graded-kind').all()) await k.locator('summary').click();
  const stream = lines.and(page.locator('[data-call="stream"]'));
  await expect(stream.getByTestId('graded-said')).toHaveText(`${add} for ${drop}: for z_steals: 3 games on the open days, flips none`);
  await expect(stream).toContainText('(add): 3 games of 4 · 61 PTS · 22 REB · 9 AST · 5 STL · 2 BLK · 8 3PM · 6 TO · FG 21/44 · FT 11/13');
  await expect(stream).toContainText('(drop): did not play (4 games scheduled)');
  await expect(stream.getByTestId('graded-naive')).toContainText('The naive manager: no move, keeping');
  const close = lines.and(page.locator('[data-call="too-close"]'));
  await expect(close.getByTestId('graded-happened')).toHaveText("Against Summit: PTS won, STL tied. The naive manager's call: Winning 5, losing 4.");
  await expect(lines.and(page.locator('[data-call="swaps"]')).getByTestId('graded-why')).toHaveText('Not graded: held back by the adds limit: no move was shown.');
  await expect(lines.and(page.locator('[data-call="build"]')).getByTestId('graded-why')).toHaveText("Not graded: a category's standing, not a call on the week.");
  await axe(page);
});

test('a category or a team with no total is named and not graded as a loss; a week the import does not hold is named; no player data says so (#1058)', async ({ page }) => {
  const noBlocks = { ...MINE, totals: { ...MINE.totals } } as Score;
  delete noBlocks.totals['z_blocks'];
  await seedLeague(page, NOW, [{ week: 9, final: true, teams: teamsOf(noBlocks, SUMMIT) }, WEEK_10]);
  await page.route('**/player_week/nba.json', (r) => r.fulfill({ status: 404, body: 'not in this build' }));
  await asOwner(page, text([...chanceLines('2026-11-23'), entry('2026-11-24', 'top-adds', '1000001', 'window value 12.0')]));
  await page.goto('/team/?league=nba');
  const card = page.getByTestId('graded');
  const blocks = card.getByTestId('graded-row').and(page.locator('[data-cat="z_blocks"]'));
  await expect(blocks.getByTestId('graded-result')).toHaveText('not graded', { ignoreCase: true });
  await expect(blocks.getByTestId('graded-call')).toHaveText('no total for you');
  await expect(card.getByTestId('graded-missing')).toHaveText("Yahoo's week holds no total for BLK (you): it is left ungraded, not counted as a loss.");
  // the coin's 50% on blocks was no call anyway; the other eight are as before
  await expect(card.getByTestId('graded-summary')).toContainText('5 of 7 category calls right');
  for (const k of await card.getByTestId('graded-kind').all()) await k.locator('summary').click();
  await expect(card.getByTestId('graded-why')).toHaveText("Not graded: the week's player data is not in yet.");

  // Summit with no totals at all
  await seedLeague(page, NOW, [{ week: 9, final: true, teams: teamsOf(MINE, null) }, WEEK_10]);
  await page.reload();
  await expect(card.getByTestId('graded-missing')).toContainText('(Summit)');
  await expect(card.getByTestId('graded-summary')).toContainText('0 of 0 category calls right');

  // the week not final in the import: named, with its Yahoo week, and an import asked for
  await seedLeague(page, NOW, [{ ...FINAL_WEEK_9, final: false }]);
  await page.reload();
  await expect(card.getByTestId('graded-import')).toContainText("The week of Monday, Nov 23 (Yahoo's week 9) is not in your import with its final totals");
  await expect(card.getByTestId('graded-import-link')).toHaveAttribute('href', '/league/#yahoo');
  await expect(card.getByTestId('graded-running')).toContainText('Running record: no week graded yet.');
  await axe(page);
});

test('the card fits a 390 px phone with no sideways scroll (#1058)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { rosters } = await seedLeague(page, NOW, [FINAL_WEEK_9, WEEK_10]);
  const long = rosters[1]!.slice(0, 6);
  await asOwner(page, text([...chanceLines('2026-11-23'), entry('2026-11-24', 'trade-verdict', `${long.slice(0, 3).join(' ')} > ${long.slice(3).join(' ')}`, 'fair')]));
  await page.goto('/team/?league=nba');
  const card = page.getByTestId('graded');
  await expect(card.getByTestId('graded-table')).toBeVisible();
  for (const k of await card.getByTestId('graded-kind').all()) await k.locator('summary').click();
  const wide = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth }));
  const box = (await card.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(wide.view).toBe(390);
  // the card adds no sideways scroll of its own
  const without = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="graded"]') as HTMLElement;
    el.style.display = 'none';
    const w = document.documentElement.scrollWidth;
    el.style.display = '';
    return w;
  });
  expect(wide.doc).toBe(without);
});

test('signed out, as anyone but the owner, and the owner with the switch off, My Team shows no graded card and reads no log (#1058)', async ({ page }) => {
  await seedLeague(page, NOW, [FINAL_WEEK_9, WEEK_10]);
  const asked: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith('/api/owner/')) asked.push(`${r.method()} ${url.pathname}`);
  });
  const html = async () => {
    await page.goto('/team/?league=nba');
    await expect(page.getByTestId('my-roster')).toBeVisible();
    await page.waitForLoadState('networkidle');
    return page.locator('main').innerHTML();
  };
  const signedOut = await html();
  expect(asked).toEqual([]);
  expect(signedOut).not.toContain('Last week, graded');
  // the owner, his switch off: the same page, and no read of the log
  await asOwner(page, text(chanceLines('2026-11-23')), false);
  expect(await html()).toBe(signedOut);
  expect(asked.filter((a) => a === 'GET /api/owner/log')).toEqual([]);
  // the switch on in a browser the Worker does not take as the owner's
  await page.unroute('**/api/owner/**');
  await page.route('**/api/owner/status', (r) => r.fulfill({ json: { configured: true, owner: false } }));
  await page.evaluate(() => localStorage.setItem('fantasyscout:owner-preview', 'on'));
  expect(await html()).toBe(signedOut);
  expect(asked.filter((a) => a === 'GET /api/owner/log')).toEqual([]);
});
