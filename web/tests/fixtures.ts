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
    await use(page);
  },
});

export { expect } from '@playwright/test';
