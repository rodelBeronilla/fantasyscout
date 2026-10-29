/**
 * The manager's own league (settings, teams and rosters), kept in this browser per league.
 * Storage can be missing or blocked, so every read and write is guarded and the defaults
 * (the league the published values assume) apply.
 */
import { useCallback, useEffect, useState } from 'react';

import type { League } from './data';

export type Scoring = 'cats9' | 'cats8' | 'points';

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

export type PointKey = (typeof POINT_STATS)[number]['key'];
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
}

export interface Pick {
  team: number;
  player: string;
}

/** The league: its settings, its teams in draft order, their rosters and a draft log. */
export interface LeagueSetup extends LeagueSettings {
  names: string[];
  rosters: string[][];
  /** The manager's own team, by index. */
  mine: number;
  drafting: boolean;
  picks: Pick[];
}

/** The league the published values assume (dbt var `fantasy`). */
export const DEFAULT_SETTINGS: Record<League, LeagueSettings> = {
  nba: { teams: 12, rosterSpots: 13, scoring: 'cats9', weights: POINT_PRESETS['espn']!.weights },
  wnba: { teams: 10, rosterSpots: 10, scoring: 'cats9', weights: POINT_PRESETS['espn']!.weights },
};

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
  const mine = Math.min(teams - 1, Math.max(0, raw.mine ?? 0));
  const picks = (raw.picks ?? []).filter((p) => p.team < teams && rosters[p.team]?.includes(p.player));
  return {
    teams,
    rosterSpots: Math.min(20, Math.max(6, Math.round(raw.rosterSpots ?? fallback.rosterSpots))),
    scoring: raw.scoring ?? fallback.scoring,
    weights: { ...fallback.weights, ...raw.weights },
    names,
    rosters,
    mine,
    drafting: raw.drafting ?? false,
    picks,
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
  return { ...setup, rosters, picks: setup.picks.filter((p) => p.player !== player) };
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
  return { ...setup, rosters, picks: setup.picks.slice(0, -1) };
}

const storageKey = (league: League) => `fantasyscout:league:${league}`;

function load(league: League): LeagueSetup {
  const fallback = DEFAULT_SETTINGS[league];
  let raw: Partial<LeagueSetup> = {};
  try {
    const text = window.localStorage.getItem(storageKey(league));
    if (text) raw = JSON.parse(text) as Partial<LeagueSetup>;
    // Players marked Mine on the board before the League page existed join the manager's team.
    const oldKey = `fantasyscout:marks:${league}`;
    const old = window.localStorage.getItem(oldKey);
    if (old) {
      const mine = (JSON.parse(old) as { mine?: string[] }).mine ?? [];
      const setup = normalize(raw, fallback);
      setup.rosters[setup.mine] = [...new Set([...(setup.rosters[setup.mine] ?? []), ...mine])];
      raw = setup;
      window.localStorage.setItem(storageKey(league), JSON.stringify(raw));
      window.localStorage.removeItem(oldKey);
    }
  } catch {
    // storage unavailable or unreadable: the defaults apply
  }
  return normalize(raw, fallback);
}

function save(league: League, setup: LeagueSetup): void {
  try {
    window.localStorage.setItem(storageKey(league), JSON.stringify(setup));
  } catch {
    // storage unavailable: the league lasts for this page view
  }
}

/**
 * The league for this browser. Another tab changing it (the League page during a draft, say)
 * updates this one too.
 */
export function useLeague(league: League): [LeagueSetup, (change: (current: LeagueSetup) => LeagueSetup) => void] {
  const [setup, setSetup] = useState<LeagueSetup>(() => load(league));
  useEffect(() => {
    setSetup(load(league));
    const onStorage = (e: StorageEvent) => {
      if (e.key === storageKey(league)) setSetup(load(league));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [league]);
  const update = useCallback(
    (change: (current: LeagueSetup) => LeagueSetup) =>
      setSetup((current) => {
        const next = normalize(change(current), DEFAULT_SETTINGS[league]);
        save(league, next);
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
 * carry extra text such as a team or position; the longest player name it contains wins.
 */
export function matchNames(text: string, players: { player_id: string; full_name: string | null }[]): { matched: string[]; unmatched: string[] } {
  const byKey = new Map<string, string>();
  for (const p of players) if (p.full_name) byKey.set(nameKey(p.full_name), p.player_id);
  const keys = [...byKey.keys()].sort((a, b) => b.length - a.length);
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const k = nameKey(line);
    const key = byKey.has(k) ? k : keys.find((candidate) => ` ${k} `.includes(` ${candidate} `));
    const id = key ? byKey.get(key) : undefined;
    if (id && !matched.includes(id)) matched.push(id);
    else if (!id) unmatched.push(line);
  }
  return { matched, unmatched };
}
