/**
 * A per-league watchlist of player ids, kept in this browser only. Storage can be missing or
 * blocked (private windows, previews), so every read and write is guarded and the list simply
 * starts empty.
 */
import { useCallback, useEffect, useState } from 'react';

import type { League } from './data';

const key = (league: League) => `fantasyscout:watchlist:${league}`;

function read(league: League): Set<string> {
  try {
    const raw = window.localStorage.getItem(key(league));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function write(league: League, ids: Set<string>): void {
  try {
    window.localStorage.setItem(key(league), JSON.stringify([...ids].sort()));
  } catch {
    // storage unavailable: the list lives for this page view only
  }
}

export function useWatchlist(league: League): { watched: Set<string>; toggleWatched: (id: string) => void } {
  const [watched, setWatched] = useState<Set<string>>(() => read(league));

  useEffect(() => {
    setWatched(read(league));
    // Another tab (the board and the streamers page share the list) changed it.
    const onStorage = (e: StorageEvent) => {
      if (e.key === key(league)) setWatched(read(league));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [league]);

  const toggleWatched = useCallback(
    (id: string) => {
      setWatched((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        write(league, next);
        return next;
      });
    },
    [league],
  );

  return { watched, toggleWatched };
}
