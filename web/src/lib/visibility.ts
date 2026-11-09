/**
 * What My Team shows: only advice that has passed its out-of-sample check, plus plain facts and
 * arithmetic on them (the schedule, games, scores, real standings, injury listings). A part that
 * failed its check, or has not been judged yet, stays off the page until a season judges it.
 * Each entry names the issue that would bring it back.
 */
export const MY_TEAM_SHOWS = {
  /** Playoff odds: their calibration failed (ADR 0025, ADR 0028); points leagues too (ADR 0029). Back with #907 and #913. */
  playoffs: false,
  /** The projected power order: failed in the NBA (ADR 0021). Back with #867. */
  power: false,
  /** "Your categories" against the whole league: its season aggregate is being reworked to count punts. Back with the punts fix. */
  categories: false,
  /** The swaps the roster review suggests: failed (ADR 0024). Back with #895. */
  swaps: false,
  /** Build your team's trades: the trade verdict, suggestions and finder failed (ADR 0023). Back with #886 to #888. */
  build: false,
  /** Who takes an out player's minutes: not judged yet. Back with #763. */
  minutes: false,
  /** The one-line AI notes and their calls: not judged. Back with #879's follow-up. */
  notes: false,
  /** Stream picks and the categories they chase: not judged (ADR 0026). Back with #902. */
  streams: false,
  /** The "too close" band: its fit was degenerate (ADR 0026). Back with #902. */
  tooClose: false,
  /**
   * The games-missed estimate and the IL threshold on it: not judged (#770, #763). Until then the
   * IL moves follow the injury report's listing and show only the report's own return date.
   */
  injuryEstimate: false,
  /** The week's lineup plan, who sits a full lineup and the open slots to stream: not judged. Back with #759. */
  lineup: false,
} as const;
