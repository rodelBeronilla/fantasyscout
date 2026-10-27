import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('home page renders', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Board');
  await expect(page.locator('[data-build-id]')).not.toBeEmpty();
});

test('league toggle defaults to WNBA', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('group', { name: 'League' }).locator('[aria-current="true"]')).toHaveText('WNBA');
});

test('unknown page shows the 404 page', async ({ page }) => {
  const response = await page.goto('/does-not-exist/');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('No such page.');
});

test('home page has no accessibility violations', async ({ page }) => {
  await page.goto('/');
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations).toEqual([]);
});

test('no horizontal scroll on a phone', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'mobile project only');
  await page.goto('/');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
