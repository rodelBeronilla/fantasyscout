/**
 * The shapes a Yahoo import keeps in the stored league, and their cleaners (#1123). No imports, so
 * the stored league and the Yahoo pages can both use them without importing each other.
 */
/**
 * Why the weeks' reading stopped at a page (#1063, #1123); none: the page did not answer.
 * 'not-matchup': it answered with a page that is not a matchup page (Yahoo's error page);
 * 'other-week': with another week's matchup page; 'no-totals': with this week's page and no
 * category table the bookmark can read; 'not-shown': with a table that does not show the team.
 */
const STOP_REASONS = ['not-shown', 'not-matchup', 'other-week', 'no-totals'] as const;
type StopReason = (typeof STOP_REASONS)[number];

/** The teams an import is missing, and the league's size where known (#1104). */
export interface TeamsMissing {
  missing: { id: number; name?: string }[];
  of: number | null;
  /** How many teams the import did read: added at the import, not sent by the bookmark. */
  read?: number;
}

/** A well-formed list of the teams an import is missing (#1104), or undefined. */
export function cleanMissing(raw: unknown): TeamsMissing | undefined {
  const x = raw as { missing?: unknown; of?: unknown } | null | undefined;
  if (!x || typeof x !== 'object' || !Array.isArray(x.missing)) return undefined;
  const missing = (x.missing as { id?: unknown; name?: unknown }[])
    .filter((m) => m && typeof m.id === 'number' && Number.isInteger(m.id) && m.id > 0 && m.id <= 30) // def: more teams than a league has
    .slice(0, 30) // def: more teams than a league has
    .map((m) => ({ id: m.id as number, ...(typeof m.name === 'string' && m.name ? { name: m.name.slice(0, 60) } : {}) })); // def: a team's name, at most
  const of = typeof x.of === 'number' && Number.isInteger(x.of) && x.of > 0 && x.of <= 30 ? x.of : null; // def: more teams than a league has
  const read = typeof (x as { read?: unknown }).read === 'number' && Number.isInteger((x as { read: number }).read) ? (x as { read: number }).read : undefined;
  return missing.length ? { missing, of, ...(read !== undefined && read >= 0 && read <= 30 ? { read } : {}) } : undefined; // def: more teams than a league has
}

/** Where an import's reading of the weeks stopped (#1049): its week and its path in the league, and why (#1123). */
export interface WeeksStop {
  week: number;
  page: string;
  why?: StopReason;
  /** The week the page said it shows, when it was another week's (#1123). */
  shows?: number;
  /** Yahoo's settings page did not answer, so the bookmark could not tell whether the playoffs had begun (#1123). */
  noSettings?: boolean;
  /** The asked team's name at the import (#1063). */
  team?: string;
}

/** A stop as read from a payload or a stored copy (#1123): the optional parts only where well formed. */
export function stopDetails(raw: { why?: unknown; shows?: unknown; noSettings?: unknown }): Pick<WeeksStop, 'why' | 'shows' | 'noSettings'> {
  const why = STOP_REASONS.find((r) => r === raw.why);
  const shows = typeof raw.shows === 'number' && Number.isInteger(raw.shows) && raw.shows > 0 && raw.shows <= 30 ? raw.shows : undefined; // def: a season has fewer fantasy weeks
  return { ...(why ? { why } : {}), ...(why === 'other-week' && shows ? { shows } : {}), ...(why === 'not-shown' && raw.noSettings === true ? { noSettings: true } : {}) };
}
