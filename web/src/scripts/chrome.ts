// The page chrome: league toggle, theme toggle, and the footer's data-as-of and build id.
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

const toggle = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
toggle?.addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme
    ? root.dataset.theme === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  root.dataset.theme = next;
  try {
    window.localStorage.setItem('fantasyscout.theme', next);
  } catch {
    // ignore
  }
});

void getLatest().then((latest) => {
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
