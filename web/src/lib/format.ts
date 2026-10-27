/** Number and date formatting shared by the pages. */

export function fmt(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  return value.toFixed(digits);
}

export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  return `${(value * 100).toFixed(1)}%`;
}

export function signed(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  const text = value.toFixed(digits);
  return value > 0 ? `+${text}` : text;
}

export function int(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  return Math.round(value).toLocaleString('en-US');
}

export function day(value: string | null | undefined): string {
  if (!value) return '–';
  const d = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function when(value: string | null | undefined): string {
  if (!value) return '–';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    hour12: false,
  }) + ' UTC';
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
