import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd with the bindings declared in wrangler.toml
// (assets from ../web/dist, an isolated in-memory R2 bucket).
export default defineConfig({
  // OWNER_KEY stands in for the owner's secret, so the private Parquet routes can be tested.
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.toml' }, miniflare: { bindings: { OWNER_KEY: 'test-owner-key' } } })],
});
