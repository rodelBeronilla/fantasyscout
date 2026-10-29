/**
 * The manager's own league, and their marks on players, kept in this browser per league.
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

/** The league the published values assume (dbt var `fantasy`). */
export const DEFAULT_SETTINGS: Record<League, LeagueSettings> = {
  nba: { teams: 12, rosterSpots: 13, scoring: 'cats9', weights: POINT_PRESETS['espn']!.weights },
  wnba: { teams: 10, rosterSpots: 10, scoring: 'cats9', weights: POINT_PRESETS['espn']!.weights },
};

function load<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<T>) } : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: settings last for this page view
  }
}

export function useLeagueSettings(league: League): [LeagueSettings, (next: LeagueSettings) => void] {
  const key = `fantasyscout:league:${league}`;
  const [settings, setSettings] = useState<LeagueSettings>(() => load(key, DEFAULT_SETTINGS[league]));
  useEffect(() => setSettings(load(key, DEFAULT_SETTINGS[league])), [key, league]);
  const update = useCallback(
    (next: LeagueSettings) => {
      setSettings(next);
      save(key, next);
    },
    [key],
  );
  return [settings, update];
}

export type Mark = 'mine' | 'taken';

/** Players on the manager's team and players taken by others (draft or waivers). */
export function useMarks(league: League): {
  marks: Map<string, Mark>;
  setMark: (id: string, mark: Mark | null) => void;
  clearMarks: (which: Mark) => void;
} {
  const key = `fantasyscout:marks:${league}`;
  const read = useCallback((): Map<string, Mark> => {
    const raw = load<{ mine: string[]; taken: string[] }>(key, { mine: [], taken: [] });
    const m = new Map<string, Mark>();
    for (const id of raw.taken ?? []) m.set(id, 'taken');
    for (const id of raw.mine ?? []) m.set(id, 'mine');
    return m;
  }, [key]);
  const [marks, setMarks] = useState<Map<string, Mark>>(read);
  useEffect(() => setMarks(read()), [read]);
  const persist = (m: Map<string, Mark>) => {
    const mine: string[] = [];
    const taken: string[] = [];
    for (const [id, v] of m) (v === 'mine' ? mine : taken).push(id);
    save(key, { mine: mine.sort(), taken: taken.sort() });
  };
  const setMark = useCallback(
    (id: string, mark: Mark | null) =>
      setMarks((current) => {
        const next = new Map(current);
        if (mark) next.set(id, mark);
        else next.delete(id);
        persist(next);
        return next;
      }),
    [key],
  );
  const clearMarks = useCallback(
    (which: Mark) =>
      setMarks((current) => {
        const next = new Map([...current].filter(([, v]) => v !== which));
        persist(next);
        return next;
      }),
    [key],
  );
  return { marks, setMark, clearMarks };
}
