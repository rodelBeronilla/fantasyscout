// The page chrome: league toggle, theme toggle, and the footer's data-as-of and build id.
import { writeRaw } from '../lib/storage';
import { getLatest } from '../lib/data';
import { currentLeague, leagueHref, rememberLeague } from '../lib/league';
import { href } from '../lib/site';

const league = currentLeague();
rememberLeague(league);
for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-league]')) {
  const id = link.dataset.league as 'wnba' | 'nba';
  link.href = leagueHref(id);
  link.setAttribute('aria-current', id === league ? 'true' : 'false');
}

/** The browser's own bars (theme-color) take the theme's ground. */
function paintBrowserBars(): void {
  const ground = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (ground) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', ground);
}
paintBrowserBars();

const toggle = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
toggle?.addEventListener('click', () => {
  const root = document.documentElement;
  // dark is the site's own look (#963); light is the visitor's choice
  const next = root.dataset.theme === 'light' ? 'dark' : 'light';
  root.dataset.theme = next;
  writeRaw('fantasyscout:theme', next);
  paintBrowserBars();
});

// The typeface (#963): a first visit paints in the fallback, sized to Inter's metrics, and fetches
// Inter only once the page has loaded, painted and gone idle, so the font never delays the content
// or competes with its data. The next page finds it in the cache.
function fetchTypeface(): void {
  const root = document.documentElement;
  if (root.dataset.font === 'ready' || !('fonts' in document)) return;
  void document.fonts
    .load("1em 'Inter Variable'")
    .then((faces) => {
      if (faces.length === 0) return;
      root.dataset.font = 'ready';
      writeRaw('fantasyscout:font', 'ready');
    })
    .catch(() => {
      // the fallback stays; the next page tries again
    });
}
function fetchTypefaceWhenIdle(): void {
  // Safari has no requestIdleCallback: a short wait stands in for it
  const idle = () => {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(fetchTypeface);
    else setTimeout(fetchTypeface, 200);
  };
  // two frames on, the loaded page has painted
  requestAnimationFrame(() => requestAnimationFrame(idle));
}
if (document.readyState === 'complete') fetchTypefaceWhenIdle();
else window.addEventListener('load', fetchTypefaceWhenIdle, { once: true });

void getLatest()
  .catch(() => {
    // The islands explain a failing pointer; the footer only stops claiming there is no build (#460).
    const asOf = document.querySelector('[data-data-as-of]');
    if (asOf) asOf.textContent = 'unavailable';
    return null;
  })
  .then((latest) => {
    if (!latest) return;
    const asOf = document.querySelector('[data-data-as-of]');
    const id = document.querySelector('[data-data-build-id]');
    const link = document.querySelector<HTMLAnchorElement>('[data-data-build-link]');
    if (asOf) {
      asOf.textContent = Object.entries(latest.data_as_of)
        .map(([l, d]) => `${l.toUpperCase()} ${d}`)
        .join(' · ');
    }
    if (id) id.textContent = latest.build_id;
    if (link) link.href = href(`/health/#build-${latest.build_id}`);
  });
