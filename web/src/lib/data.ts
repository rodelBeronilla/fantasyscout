/**
 * The data client: every page reads the current build through `latest.json`, then the files
 * under `builds/<build_id>/` (ADR 0006). The pointer is cached by the Worker for a minute and
 * here for the life of the page; build files are immutable, so the browser may cache them for
 * a year.
 */
import { href } from './site';

export type League = 'wnba' | 'nba';

export interface Latest {
  build_id: string;
  manifest: string;
  created_at: string;
  data_as_of: Partial<Record<League, string>>;
  rolled_back_from?: string;
}

export interface ManifestFile {
  bytes: number;
  sha256: string;
  rows?: number;
}

export interface Manifest extends Latest {
  engine: string;
  git_sha: string;
  gate: { passed: boolean; reason: string; run_id: string; run_at: string } | null;
  check_counts: Record<string, number>;
  tables: Record<string, { rows: number; files: string[] }>;
  files: Record<string, ManifestFile>;
  players: { count: number; prefix: string };
}

let latestPromise: Promise<Latest | null> | undefined;

export function dataHref(path: string): string {
  return href(`/data/${path}`);
}

/**
 * The pointer could not be read for a reason other than "no build yet": the Worker or the network
 * failed. The next call fetches again; nothing remembers the failure.
 */
export class DataUnavailableError extends Error {
  constructor(public readonly status?: number) {
    super(
      status
        ? `The data is temporarily unavailable (HTTP ${status}).`
        : 'The data is temporarily unavailable (the connection failed).',
    );
  }
}

/**
 * The current build pointer, or null when no build has been published yet (a 404). Any other
 * failure throws DataUnavailableError and is not memoised, so a later island, or a reload, asks
 * again rather than reading "no build" for the life of the page.
 */
export function getLatest(): Promise<Latest | null> {
  // No cache override: the preload in the page head fetched the pointer already, and the Worker
  // serves it with a minute's cache, which is the staleness the site accepts (ADR 0006).
  latestPromise ??= fetch(dataHref('latest.json'))
    .then((r) => {
      if (r.status === 404) return null;
      if (!r.ok) throw new DataUnavailableError(r.status);
      return r.json() as Promise<Latest>;
    })
    .catch((e: unknown) => {
      latestPromise = undefined;
      throw e instanceof DataUnavailableError ? e : new DataUnavailableError();
    });
  return latestPromise;
}

export function buildHref(latest: Latest, path: string): string {
  return dataHref(`builds/${latest.build_id}/${path}`);
}

export async function getManifest(): Promise<Manifest | null> {
  const latest = await getLatest();
  if (!latest) return null;
  const r = await fetch(dataHref(latest.manifest));
  return r.ok ? ((await r.json()) as Manifest) : null;
}

export class NoBuildError extends Error {
  constructor() {
    super('No data build has been published yet.');
  }
}

/** A JSON file of the current build. Throws NoBuildError before the first export. */
export async function fetchBuildJson<T>(path: string): Promise<T> {
  const latest = await getLatest();
  if (!latest) throw new NoBuildError();
  const r = await fetch(buildHref(latest, path));
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** Rows from a column-wise file, `{column: [values]}` (#535). */
export function inflate<T>(columns: Record<string, unknown[]>): T[] {
  const keys = Object.keys(columns);
  const n = keys.length ? (columns[keys[0]!]?.length ?? 0) : 0;
  const out = new Array<T>(n);
  for (let i = 0; i < n; i++) {
    const row: Record<string, unknown> = {};
    for (const k of keys) row[k] = columns[k]![i];
    out[i] = row as T;
  }
  return out;
}

/**
 * A page's rows from the current build (`board/nba`, `streamers/wnba`): the column-wise copy at the
 * stable address the page head preloads (`/data/current/<path>.columns.json`, #436 and #535), a
 * third of the row file's size. A build from before the column files, or a server with no Worker
 * (the dev server), falls back to the pointer and the build's row file.
 */
export async function fetchPageRows<T>(path: string): Promise<T[]> {
  try {
    const r = await fetch(dataHref(`current/${path}.columns.json`));
    if (r.ok && (r.headers.get('content-type') ?? '').includes('json')) return inflate<T>((await r.json()) as Record<string, unknown[]>);
  } catch {
    // fall through to the pointer
  }
  return fetchBuildJson<T[]>(`${path}.json`);
}

/** The first rows of a page are on screen: the mark the deploy's slow-phone budget reads (#436). */
export function markFirstRow(): void {
  try {
    if (typeof performance !== 'undefined' && performance.getEntriesByName('fs:first-row').length === 0) performance.mark('fs:first-row');
  } catch {
    // marks are a measurement aid only
  }
}

/** Absolute URL of a build file, for DuckDB-WASM's httpfs. */
export function absoluteBuildUrl(latest: Latest, path: string): string {
  return new URL(buildHref(latest, path), window.location.origin).toString();
}
