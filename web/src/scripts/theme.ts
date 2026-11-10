// Applies the remembered theme before first paint, and the typeface once this browser has it.
// Runs in <head>; no DOM yet beyond <html>.
import { readRaw } from '../lib/storage';

// The theme's key joined the namespace (fantasyscout:theme); a value under the old key moves once.
const stored = readRaw('fantasyscout:theme', 'fantasyscout.theme');
if (stored === 'dark' || stored === 'light') document.documentElement.dataset.theme = stored;

// Inter is in the cache after a first visit (scripts/chrome.ts fetches it once that page has loaded).
if (readRaw('fantasyscout:font') === 'ready') document.documentElement.dataset.font = 'ready';
