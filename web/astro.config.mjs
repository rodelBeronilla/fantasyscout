// @ts-check
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// The SQL console loads the DuckDB-WASM engine of exactly this version from the data bucket.
const duckdbVersion = JSON.parse(
  readFileSync(new URL('./node_modules/@duckdb/duckdb-wasm/package.json', import.meta.url), 'utf8'),
).version;

// The app is the root of its own host (fantasyscout.beronilla.rodeo); the Worker serves dist/ as-is.
export default defineConfig({
  site: 'https://fantasyscout.beronilla.rodeo',
  trailingSlash: 'always',
  integrations: [react()],
  build: {
    // The stylesheet is inlined: it is small, and a render-blocking file cost a round trip
    // before first paint. The Worker's CSP allows each inline style by its SHA-256 hash
    // (worker/scripts/csp-hashes.mjs), so nothing inline runs without being listed.
    inlineStylesheets: 'always',
  },
  vite: {
    plugins: [tailwindcss()],
    build: {
      assetsInlineLimit: 0,
    },
    define: { __DUCKDB_VERSION__: JSON.stringify(duckdbVersion) },
    // DuckDB-WASM ships its own workers and wasm; they are served from this origin (CSP 'self').
    optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  },
});
