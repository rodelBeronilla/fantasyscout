/** Base path of the app without a trailing slash: empty at the root, "/sub" if ever mounted under one. */
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

/** Prefix a site-relative path with the base path. */
export function href(path: string): string {
  return `${BASE}/${path.replace(/^\//, '')}`;
}

/** Build identity shown in every footer. Set PUBLIC_BUILD_ID in CI to the short git SHA. */
export const BUILD_ID: string = import.meta.env.PUBLIC_BUILD_ID ?? 'local';

export const REPO_URL = 'https://github.com/rodelBeronilla/fantasyscout';

export const LEAGUES = [
  { id: 'wnba', label: 'WNBA' },
  { id: 'nba', label: 'NBA' },
] as const;
