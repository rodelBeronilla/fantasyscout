import { defineConfig } from 'vitest/config';

// Unit tests for the pure libraries under src/lib (value, trades, the league setup, the Yahoo
// import, the data client). Flows stay in Playwright (tests/), which boots a browser per test.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
