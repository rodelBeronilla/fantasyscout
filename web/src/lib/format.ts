/** Number and date formatting shared by the pages. */

export function fmt(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  return value.toFixed(digits);
}

export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  return `${(value * 100).toFixed(1)}%`;
}

/** 1st, 2nd, 3rd, 11th, 22nd: a place in a ranking. */
export const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;

export function int(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  return Math.round(value).toLocaleString('en-US');
}

// One formatter per format, built once: toLocaleDateString and its kin with options build a new
// Intl.DateTimeFormat on every call, which cost a slow phone about 0.45 s across the board's first
// rows (#557). The output is the same.
const EASTERN_CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const WHEN = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false });

/** An instant as the Eastern wall clock, "18:45": the report time is published in UTC (#387). */
export function easternClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 16);
  return EASTERN_CLOCK.format(d);
}

export function day(value: string | null | undefined): string {
  if (!value) return '–';
  const d = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return value;
  return DAY.format(d);
}

export function when(value: string | null | undefined): string {
  if (!value) return '–';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return WHEN.format(d) + ' UTC';
}

export const CATEGORY_LABELS: Record<string, string> = {
  z_points: 'PTS',
  z_rebounds_total: 'REB',
  z_assists: 'AST',
  z_steals: 'STL',
  z_blocks: 'BLK',
  z_three_pointers_made: '3PM',
  z_field_goal_pct: 'FG%',
  z_free_throw_pct: 'FT%',
  z_turnovers: 'TO',
};

export const CATEGORIES = Object.keys(CATEGORY_LABELS);

/** Each category in a sentence: "steals is the swing category". */
export const CATEGORY_WORDS: Record<string, string> = {
  z_points: 'points',
  z_rebounds_total: 'rebounds',
  z_assists: 'assists',
  z_steals: 'steals',
  z_blocks: 'blocks',
  z_three_pointers_made: 'threes',
  z_field_goal_pct: 'FG%',
  z_free_throw_pct: 'FT%',
  z_turnovers: 'turnovers',
};

/** The season after this one: 2026 -> 2027, 2025-26 -> 2026-27. */
export function nextSeason(season: string | null | undefined): string | null {
  if (!season) return null;
  const y = /^(\d{4})$/.exec(season);
  if (y) return String(Number(y[1]) + 1);
  const span = /^(\d{4})-(\d{2})$/.exec(season);
  if (span) return `${Number(span[1]) + 1}-${String((Number(span[2]) + 1) % 100).padStart(2, '0')}`;
  return null;
}

/** Who posted a betting line and when (#462): "DraftKings, as of Nov 1, 2026"; null without a provider. */
export function lineSource(provider: string | null | undefined, asOf: string | null | undefined): string | null {
  if (!provider) return null;
  return asOf ? `${provider}, as of ${day(asOf)}` : provider;
}

