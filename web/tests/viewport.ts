import { expect, type Page } from '@playwright/test';

/**
 * The page does not scroll sideways (#1112): the document is no wider than the viewport the test
 * set. It reads the set width from `page.viewportSize()`, never `window.innerWidth`: under phone
 * emulation the layout viewport grows with the content, so a page 559 px wide at a 390 px viewport
 * had `innerWidth` 559 and passed.
 */
export async function expectNoSidewaysScroll(page: Page, what?: string): Promise<void> {
  const set = page.viewportSize()?.width;
  if (!set) throw new Error('expectNoSidewaysScroll needs a fixed viewport width');
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, `${what ?? new URL(page.url()).pathname}: the document is ${width} px wide at a ${set} px viewport`).toBeLessThanOrEqual(set);
}
