import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd with the bindings declared in wrangler.toml
// (assets from ../web/dist, an isolated in-memory R2 bucket).
export default defineConfig({
  // Stand-ins for the Yahoo app's credentials and the owner's account, so the private Parquet
  // routes and the owner's sign-in can be tested. The league import stays parked (no YAHOO_IMPORT).
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: { bindings: { YAHOO_CLIENT_ID: 'test-client-id', YAHOO_CLIENT_SECRET: 'test-client-secret', OWNER_YAHOO_GUID: 'OWNERGUID' } },
    }),
  ],
});
