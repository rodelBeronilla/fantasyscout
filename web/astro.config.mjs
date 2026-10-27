// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// The app is the root of its own host (fantasyscout.beronilla.rodeo); the Worker serves dist/ as-is.
export default defineConfig({
  site: 'https://fantasyscout.beronilla.rodeo',
  trailingSlash: 'always',
  build: {
    // Keep styles in files so the Worker's CSP can stay at style-src 'self'.
    inlineStylesheets: 'never',
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
