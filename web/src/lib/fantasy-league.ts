/**
 * The manager's own league (settings, teams and rosters), kept in this browser per league.
 * Storage can be missing or blocked, so every read and write is guarded and the defaults
 * (the league the published values assume) apply.
 */
import { useCallback, useEffect, useState } from 'react';
import { normalizeSlots, type Slots } from './lineup';

import { accountStatus, loadSaved, saveSoon } from './account';
import type { League } from './data';
import { CATEGORIES } from './format';
import { readRaw, removeRaw, storageKey, writeRaw } from './storage';

export type Scoring = 'cats9' | 'cats8' | 'points';
/** Rotisserie ranks season totals against every team; head-to-head plays one opponent a week. */
export type Format = 'roto' | 'h2h';

/** Stats a points league scores, read from the projected per-game line. */
export const POINT_STATS = [
  { key: 'points', label: 'PTS', column: 'proj_points_pg' },
  { key: 'rebounds', label: 'REB', column: 'proj_rebounds_total_pg' },
  { key: 'assists', label: 'AST', column: 'proj_assists_pg' },
  { key: 'steals', label: 'STL', column: 'proj_steals_pg' },
  { key: 'blocks', label: 'BLK', column: 'proj_blocks_pg' },
  { key: 'threes', label: '3PM', column: 'proj_three_pointers_made_pg' },
  { key: 'turnovers', label: 'TO', column: 'proj_turnovers_pg' },
  { key: 'fgm', label: 'FGM', column: 'proj_fgm_pg' },
  { key: 'fga', label: 'FGA', column: 'proj_fga_pg' },
  { key: 'ftm', label: 'FTM', column: 'proj_ftm_pg' },
  { key: 'fta', label: 'FTA', column: 'proj_fta_pg' },
] as const;

type PointKey = (typeof POINT_STATS)[number]['key'];
export type PointWeights = Record<PointKey, number>;

/** The default points scoring of the two big hosts, as the starting point to edit. */
export const POINT_PRESETS: Record<string, { label: string; weights: PointWeights }> = {
  espn: {
    label: 'ESPN points',
    weights: { points: 1, rebounds: 1, assists: 2, steals: 4, blocks: 4, threes: 1, turnovers: -2, fgm: 2, fga: -1, ftm: 1, fta: -1 },
  },
  yahoo: {
    label: 'Yahoo points',
    weights: { points: 1, rebounds: 1.2, assists: 1.5, steals: 3, blocks: 3, threes: 0, turnovers: -1, fgm: 0, fga: 0, ftm: 0, fta: 0 },
  },
};

export interface LeagueSettings {
  teams: number;
  rosterSpots: number;
  scoring: Scoring;
  weights: PointWeights;
  format: Format;
  /** Categories the manager gives up on (a categories league): every page values players without them (#661). */
  punts: string[];
  /** The starting lineup's slots (#735): what the weekly planner fills each day. */
  lineup: Slots;
}

interface Pick {
  team: number;
  player: string;
}

/** The league: its settings, its teams in draft order, their rosters and a draft log. */
export interface LeagueSetup extends LeagueSettings {
  names: string[];
  rosters: string[][];
  /** The manager's own team, by index. */
  mine: number;
  /** Players on an injured-list slot (IL, IL+): owned, but not taking a roster spot. */
  il: string[];
  drafting: boolean;
  picks: Pick[];
  /** The team the manager faces this week in a head-to-head league, by index; null until chosen. */
  opponent: number | null;
}

/** The league the published values assume (dbt var `fantasy`). */
export const DEFAULT_SETTINGS: Record<League, LeagueSettings> = {
  // Yahoo's standard NBA lineup (PG, SG, G, SF, PF, F, C, C, Util, Util) folded into G, F, C and Util
  nba: { teams: 12, rosterSpots: 13, scoring: 'cats9', weights: POINT_PRESETS['espn']!.weights, format: 'roto', punts: [], lineup: { G: 3, F: 3, C: 2, UTIL: 2 } },
  wnba: { teams: 10, rosterSpots: 10, scoring: 'cats9', weights: POINT_PRESETS['espn']!.weights, format: 'roto', punts: [], lineup: { G: 2, F: 2, C: 1, UTIL: 2 } },
};

/**
 * The categories the league's values count: all nine, less turnovers in an 8-category league,
 * less the manager's punts. Empty for a points league.
 */
export function keptCategories(s: { scoring: Scoring; punts: string[] }): string[] {
  if (s.scoring === 'points') return [];
  return CATEGORIES.filter((c) => !s.punts.includes(c) && !(s.scoring === 'cats8' && c === 'z_turnovers'));
}

/** Each kept category's weight in value: 1, a punted one left out. Empty for a points league. */
export function categoryWeights(s: { scoring: Scoring; punts: string[] }): Record<string, number> {
  return Object.fromEntries(keptCategories(s).map((c) => [c, 1]));
}

/** A player's (or a team's) categories summed with the weights; a category without a weight counts 0. */
export function weightedSum(values: Record<string, number> | undefined, weights: Record<string, number>): number {
  if (!values) return 0;
  let s = 0;
  for (const c in weights) s += (weights[c] ?? 0) * (values[c] ?? 0);
  return s;
}

/** Whether the settings are the league's defaults, the ones the published values assume. */
export function isDefaultSettings(s: LeagueSettings, d: LeagueSettings): boolean {
  return (
    s.teams === d.teams &&
    s.rosterSpots === d.rosterSpots &&
    s.scoring === d.scoring &&
    s.format === d.format &&
    s.punts.length === 0 &&
    JSON.stringify(s.weights) === JSON.stringify(d.weights)
  );
}

export const MIN_TEAMS = 4;
export const MAX_TEAMS = 20;

const defaultName = (i: number) => `Team ${i + 1}`;

/** Sizes the teams, rosters and draft log to the number of teams, keeping what fits. */
export function normalize(raw: Partial<LeagueSetup>, fallback: LeagueSettings): LeagueSetup {
  const teams = Math.min(MAX_TEAMS, Math.max(MIN_TEAMS, Math.round(raw.teams ?? fallback.teams)));
  const names = Array.from({ length: teams }, (_, i) => (raw.names?.[i] ?? '').trim() || defaultName(i));
  const seen = new Set<string>();
  const rosters = Array.from({ length: teams }, (_, i) =>
    (raw.rosters?.[i] ?? []).filter((id) => typeof id === 'string' && !seen.has(id) && !!seen.add(id)),
  );
  const il = (raw.il ?? []).filter((id, i, all) => typeof id === 'string' && seen.has(id) && all.indexOf(id) === i);
  const mine = Math.min(teams - 1, Math.max(0, raw.mine ?? 0));
  const picks = (raw.picks ?? []).filter((p) => p.team < teams && rosters[p.team]?.includes(p.player));
  // The opponent is another team in the league, or not chosen.
  const opponent = typeof raw.opponent === 'number' && Number.isInteger(raw.opponent) && raw.opponent >= 0 && raw.opponent < teams && raw.opponent !== mine ? raw.opponent : null;
  return {
    teams,
    rosterSpots: Math.min(20, Math.max(6, Math.round(raw.rosterSpots ?? fallback.rosterSpots))),
    scoring: raw.scoring ?? fallback.scoring,
    weights: { ...fallback.weights, ...raw.weights },
    format: raw.format === 'h2h' || raw.format === 'roto' ? raw.format : fallback.format,
    // known categories only, once each, in the board's order
    punts: CATEGORIES.filter((c) => (Array.isArray(raw.punts) ? raw.punts : fallback.punts).includes(c)),
    lineup: normalizeSlots(raw.lineup, fallback.lineup),
    names,
    rosters,
    mine,
    il,
    drafting: raw.drafting ?? false,
    picks,
    opponent,
  };
}

/** Which team holds each rostered player. */
export function owners(setup: LeagueSetup): Map<string, number> {
  const out = new Map<string, number>();
  setup.rosters.forEach((roster, team) => roster.forEach((id) => out.set(id, team)));
  return out;
}

/** Puts a player on a team (or on no team), taking them off any other. */
export function assign(setup: LeagueSetup, player: string, team: number | null): LeagueSetup {
  const rosters = setup.rosters.map((r, i) => (i === team ? [...r.filter((id) => id !== player), player] : r.filter((id) => id !== player)));
  const il = team === null ? setup.il.filter((id) => id !== player) : setup.il;
  return { ...setup, rosters, il, picks: setup.picks.filter((p) => p.player !== player) };
}

/** Moves a rostered player onto or off the injured list. */
export function toggleIl(setup: LeagueSetup, player: string): LeagueSetup {
  const on = setup.il.includes(player);
  return { ...setup, il: on ? setup.il.filter((id) => id !== player) : [...setup.il, player] };
}

/** The pick a snake draft is on: round and pick within it (from 1), and the team on the clock. */
export function onTheClock(setup: LeagueSetup): { overall: number; round: number; pick: number; team: number } {
  const n = setup.picks.length;
  const round = Math.floor(n / setup.teams);
  const slot = n % setup.teams;
  return { overall: n + 1, round: round + 1, pick: slot + 1, team: round % 2 === 0 ? slot : setup.teams - 1 - slot };
}

export function draftPick(setup: LeagueSetup, player: string): LeagueSetup {
  const { team } = onTheClock(setup);
  const next = assign(setup, player, team);
  return { ...next, picks: [...next.picks, { team, player }] };
}

export function undoPick(setup: LeagueSetup): LeagueSetup {
  const last = setup.picks.at(-1);
  if (!last) return setup;
  const rosters = setup.rosters.map((r, i) => (i === last.team ? r.filter((id) => id !== last.player) : r));
  return { ...setup, rosters, il: setup.il.filter((id) => id !== last.player), picks: setup.picks.slice(0, -1) };
}

/**
 * The version of the stored object. Raise it with every change to what is stored and add the step
 * to `migrate`; an object without a version is the shape the League page first wrote.
 *
 * 1: the first League page (teams, names, rosters, mine, picks); the board's Mine marks lived
 *    under their own key and joined the manager's team on first read.
 * 2: the injured list (`il`) and the point-scoring weights.
 * 3: the league format (`format`: roto or head-to-head) and this week's opponent (`opponent`).
 * 4: the punted categories (`punts`), which until then were a view setting on the board.
 * 5: the focus categories (`focus`).
 * 6: focus categories withdrawn (#706); the field is dropped.
 */
export const SETUP_VERSION = 6;

interface StoredSetup extends LeagueSetup {
  version: number;
  /** When this browser last saved it (ms since the epoch); between it and the account's copy, the newer wins (#684). */
  savedAt?: number;
}

/** What an older build left under its own keys, for the migrations that read it. */
export interface LegacyStorage {
  /** `fantasyscout:marks:<league>` from before the League page: the players marked Mine on the board. */
  marks?: string[];
}

/**
 * The stored object of any version, brought to the current shape. Each step takes the object from
 * one version to the next, so a browser that skipped versions walks every step; `normalize`
 * then sizes and cleans it as it always has. An object from a newer build than this one keeps
 * what this build understands.
 */
export function migrate(raw: unknown, fallback: LeagueSettings, legacy: LegacyStorage = {}): LeagueSetup {
  let value: Partial<StoredSetup> = raw && typeof raw === 'object' ? (raw as Partial<StoredSetup>) : {};
  const version = typeof value.version === 'number' && value.version >= 1 ? value.version : 1;
  if (version === 1) {
    // 1 -> 2: the injured list arrives empty; the weights take the league's preset. (The next step,
    // when there is one, follows here and reads the object as version 2.)
    value = { ...value, il: Array.isArray(value.il) ? value.il : [], weights: { ...fallback.weights, ...value.weights } };
  }
  if (version <= 2) {
    // 2 -> 3: every league so far was rotisserie, with no opponent to face.
    value = { ...value, format: fallback.format, opponent: null };
  }
  if (version <= 3) {
    // 3 -> 4: no league had punts; the board's own punts stayed in its URL.
    value = { ...value, punts: [] };
  }
  if (version <= 4) {
    // 4 -> 5: no league had a focus.
    value = { ...value, focus: [] } as typeof value;
  }
  if (version <= 5) {
    // 5 -> 6: focus categories were withdrawn (#706); the field goes.
    const rest: Record<string, unknown> = { ...value };
    delete rest['focus'];
    value = rest as typeof value;
  }
  const setup = normalize(value, fallback);
  if (legacy.marks?.length) {
    // The board's Mine marks join the manager's team, once.
    setup.rosters[setup.mine] = [...new Set([...(setup.rosters[setup.mine] ?? []), ...legacy.marks])];
  }
  return normalize(setup, fallback);
}

const setupKey = (league: League) => storageKey('league', league);
const marksKey = (league: League) => storageKey('marks', league);

function parseJson(text: string | null): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function load(league: League): LeagueSetup {
  const fallback = DEFAULT_SETTINGS[league];
  const stored = parseJson(readRaw(setupKey(league)));
  const marks = parseJson(readRaw(marksKey(league))) as { mine?: unknown } | undefined;
  const legacy: LegacyStorage = {
    marks: Array.isArray(marks?.mine) ? marks.mine.filter((id): id is string => typeof id === 'string') : undefined,
  };
  const setup = migrate(stored, fallback, legacy);
  if (legacy.marks || (stored && (stored as { version?: unknown }).version !== SETUP_VERSION)) {
    // migrated: write the current shape back and retire the old key (a migration is not an edit,
    // so the time it was saved stays)
    save(league, setup, savedAt(league));
    removeRaw(marksKey(league));
  }
  return setup;
}

/** When this browser last saved the league's setup, or 0 when it never has. */
function savedAt(league: League): number {
  const stored = parseJson(readRaw(setupKey(league))) as { savedAt?: unknown } | undefined;
  return typeof stored?.savedAt === 'number' ? stored.savedAt : 0;
}

function save(league: League, setup: LeagueSetup, at = Date.now()): void {
  const stored: StoredSetup = { ...setup, version: SETUP_VERSION, savedAt: at };
  writeRaw(setupKey(league), JSON.stringify(stored));
}

/** What the account is sent: the stored object as this browser holds it, and when it was saved. */
function storedForAccount(league: League): { setup: unknown; savedAt: number } | null {
  const stored = parseJson(readRaw(setupKey(league)));
  return stored && typeof stored === 'object' ? { setup: stored, savedAt: savedAt(league) } : null;
}

const synced = new Map<League, Promise<LeagueSetup | null>>();

/**
 * Brings this browser and the account into line once per page (#684): the account's copy when it
 * is newer, which is then this browser's too; otherwise this browser's copy goes to the account.
 * Resolves to the setup to show when the account's copy won, or null.
 */
function syncWithAccount(league: League): Promise<LeagueSetup | null> {
  let pending = synced.get(league);
  if (!pending) {
    pending = (async () => {
      if (!(await accountStatus()).signedIn) return null;
      const remote = await loadSaved(league);
      const local = savedAt(league);
      if (remote && (remote.savedAt ?? 0) > local) {
        const setup = migrate(remote.setup, DEFAULT_SETTINGS[league]);
        save(league, setup, remote.savedAt ?? Date.now());
        return setup;
      }
      if (local > (remote?.savedAt ?? 0)) saveSoon(league, () => storedForAccount(league), 0);
      return null;
    })();
    synced.set(league, pending);
  }
  return pending;
}

/**
 * The league for this browser, and for the manager's account when signed in (#684). Another tab
 * changing it (the League page during a draft, say) updates this one too.
 */
export function useLeague(league: League): [LeagueSetup, (change: (current: LeagueSetup) => LeagueSetup) => void] {
  const [setup, setSetup] = useState<LeagueSetup>(() => load(league));
  useEffect(() => {
    let live = true;
    setSetup(load(league));
    // signed in to an account: its copy, when newer, replaces this browser's (#684)
    void syncWithAccount(league).then((remote) => {
      if (live && remote) setSetup(remote);
    });
    const onStorage = (e: StorageEvent) => {
      if (e.key === setupKey(league)) setSetup(load(league));
    };
    window.addEventListener('storage', onStorage);
    return () => {
      live = false;
      window.removeEventListener('storage', onStorage);
    };
  }, [league]);
  const update = useCallback(
    (change: (current: LeagueSetup) => LeagueSetup) =>
      setSetup((current) => {
        const next = normalize(change(current), DEFAULT_SETTINGS[league]);
        save(league, next);
        // and to the account, once the edits pause
        saveSoon(league, () => storedForAccount(league));
        return next;
      }),
    [league],
  );
  return [setup, update];
}

/** A name reduced for matching: no accents, punctuation or suffixes, lower case. */
export function nameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s-]/g, '')
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !['jr', 'sr', 'ii', 'iii', 'iv'].includes(w))
    .join(' ');
}

/**
 * Matches pasted lines (one player each, as any fantasy host lists them) to players. A line may
 * carry extra text such as a team or position; the longest player name it contains wins. A long
 * name a host shortens to an initial ("N. Alexander-Walker") matches the one player whose surname
 * fits and whose first name starts with that initial (#519).
 */
export function matchNames(text: string, players: { player_id: string; full_name: string | null }[]): { matched: string[]; unmatched: string[] } {
  const byKey = new Map<string, string>();
  for (const p of players) if (p.full_name) byKey.set(nameKey(p.full_name), p.player_id);
  const keys = [...byKey.keys()].sort((a, b) => b.length - a.length);
  // A long name a host shortens to an initial ("N. Alexander-Walker"): one player per alias, or none when two share it.
  const byAlias = new Map<string, string | null>();
  for (const p of players) {
    const parts = p.full_name ? nameKey(p.full_name).split(' ') : [];
    if (parts.length < 2) continue;
    const alias = `${parts[0]!.charAt(0)} ${parts.slice(1).join(' ')}`;
    byAlias.set(alias, byAlias.has(alias) ? null : p.player_id);
  }
  const aliases = [...byAlias.keys()].sort((a, b) => b.length - a.length);
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const k = nameKey(line);
    const key = byKey.has(k) ? k : keys.find((candidate) => ` ${k} `.includes(` ${candidate} `));
    let id = key ? byKey.get(key) : undefined;
    if (!id) {
      const alias = byAlias.has(k) ? k : aliases.find((candidate) => ` ${k} `.includes(` ${candidate} `));
      if (alias) id = byAlias.get(alias) ?? undefined;
    }
    if (id && !matched.includes(id)) matched.push(id);
    else if (!id) unmatched.push(line);
  }
  return { matched, unmatched };
}
