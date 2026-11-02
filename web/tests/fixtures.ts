import { test as base } from '@playwright/test';

/**
 * The preview server is a plain static server; behind the Worker, /p/{league}/{id}/ is served
 * by the single /p/ page (worker/src/index.ts). This fixture gives the tests the same rewrite,
 * so player pages work exactly as they do in production.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route(/\/p\/(wnba|nba)\/[^/]+\/?(\?.*)?$/, async (route) => {
      const url = new URL(route.request().url());
      if (route.request().resourceType() !== 'document') return route.continue();
      return route.continue({ url: `${url.origin}/p/` });
    });
    // The pages read the column-wise board and streamers first and fall back to the row files
    // (#535). Many tests rewrite a page's rows by mocking the row file, so the column files are
    // hidden here; the test that covers them calls page.unroute('**/*.columns.json').
    await page.route('**/*.columns.json', (route) => route.fulfill({ status: 404, body: 'hidden in tests' }));
    await use(page);
  },
});

export { expect } from '@playwright/test';
