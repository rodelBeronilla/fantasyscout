import { CATEGORIES, CATEGORY_LABELS } from './format';
import { POSITION_LETTERS, type PositionLetter } from './players';

/**
 * The board's view, punts and filters as query parameters (#461), so a reload keeps them and a
 * copied link reproduces them. Only what differs from the default is written; other parameters
 * (?league=) are kept. Values that do not parse are dropped, never guessed.
 */
const BOARD_VIEWS = ['value', 'season', 'last20', 'recent', 'projected', 'pergame'] as const;
export type BoardView = (typeof BOARD_VIEWS)[number];
const AVAILABILITIES = ['all', 'no_out', 'healthy'] as const;
export type BoardAvailability = (typeof AVAILABILITIES)[number];

export type BoardFilters = {
  view: BoardView;
  punts: Set<string>;
  restOfSeason: boolean;
  countGames: boolean;
  team: string;
  positions: Set<PositionLetter>;
  minGames: number;
  minMinutes: number;
  availability: BoardAvailability;
  rookiesOnly: boolean;
  movedOnly: boolean;
  watchOnly: boolean;
};

export const DEFAULT_FILTERS: BoardFilters = {
  view: 'value',
  punts: new Set(),
  restOfSeason: false,
  countGames: true,
  team: '',
  positions: new Set(),
  minGames: 0,
  minMinutes: 0,
  availability: 'all',
  rookiesOnly: false,
  movedOnly: false,
  watchOnly: false,
};

const KEYS = ['view', 'punt', 'ros', 'games', 'team', 'pos', 'gp', 'mpg', 'avail', 'rookies', 'moved', 'watch'];

// A punt by its short name: pts, reb, ast, stl, blk, 3pm, fg, ft, to.
const short = (c: string) => (CATEGORY_LABELS[c] ?? c).toLowerCase().replace('%', '');
const BY_SHORT = new Map(CATEGORIES.map((c) => [short(c), c]));

const count = (v: string | null) => {
  const n = v === null ? NaN : Number(v);
  return Number.isInteger(n) && n > 0 && n <= 82 ? n : 0;
};

export function readBoardFilters(search: string): BoardFilters {
  const p = new URLSearchParams(search);
  const view = p.get('view');
  const avail = p.get('avail');
  const team = (p.get('team') ?? '').toUpperCase();
  return {
    view: (BOARD_VIEWS as readonly string[]).includes(view ?? '') ? (view as BoardView) : 'value',
    punts: new Set(
      (p.get('punt') ?? '')
        .split('-')
        .map((s) => BY_SHORT.get(s.toLowerCase()))
        .filter((c): c is string => !!c),
    ),
    restOfSeason: p.get('ros') === '1',
    countGames: p.get('games') !== '0',
    team: /^[A-Z]{2,4}$/.test(team) ? team : '',
    positions: new Set(POSITION_LETTERS.filter((l) => (p.get('pos') ?? '').toUpperCase().includes(l))),
    minGames: count(p.get('gp')),
    minMinutes: count(p.get('mpg')),
    availability: (AVAILABILITIES as readonly string[]).includes(avail ?? '') ? (avail as BoardAvailability) : 'all',
    rookiesOnly: p.get('rookies') === '1',
    movedOnly: p.get('moved') === '1',
    watchOnly: p.get('watch') === '1',
  };
}

/** The query string for these filters, on top of the other parameters in `search`. */
export function writeBoardFilters(search: string, f: BoardFilters): string {
  const p = new URLSearchParams(search);
  for (const k of KEYS) p.delete(k);
  if (f.view !== 'value') p.set('view', f.view);
  if (f.punts.size) p.set('punt', CATEGORIES.filter((c) => f.punts.has(c)).map(short).join('-'));
  if (f.restOfSeason) p.set('ros', '1');
  if (!f.countGames) p.set('games', '0');
  if (f.team) p.set('team', f.team);
  if (f.positions.size) p.set('pos', POSITION_LETTERS.filter((l) => f.positions.has(l)).join('').toLowerCase());
  if (f.minGames) p.set('gp', String(f.minGames));
  if (f.minMinutes) p.set('mpg', String(f.minMinutes));
  if (f.availability !== 'all') p.set('avail', f.availability);
  if (f.rookiesOnly) p.set('rookies', '1');
  if (f.movedOnly) p.set('moved', '1');
  if (f.watchOnly) p.set('watch', '1');
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}
