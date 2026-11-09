/**
 * What the site shows (#936, rule 1): only advice that has passed its out-of-sample check, plus
 * plain facts and arithmetic on them (the schedule, games, scores, real standings, injury
 * listings). A ranking presented as advice ("Top 3 adds", "Start", "Trade for") is a call and
 * needs a passed check; the same numbers in a labelled, sortable table are data and may show.
 *
 * One switch per call that failed its check or has not been judged. Each names its ADR or issue
 * and when it can be judged again:
 * - week-level calls are judged on 2026-27's completed weeks, at about week 10 (mid-January) and
 *   week 20 (mid-March); a pass turns the switch on, a fail reworks or removes the call;
 * - season-level calls wait for the pooled judge on the locked seasons (NBA 2025-26, WNBA 2026,
 *   #907) or the end of 2026-27.
 * The pages and the e2e tests read the switches, so a call comes back by flipping one.
 */
export const SHOWS = {
  // Rankings, and every page that values a player

  /** Fit, the value weighted to the team's needs, and its sort: failed (ADR 0021, #868). Season-level: back only after a rework passes on the locked seasons. */
  fit: false,
  /** The consistency columns and the player page's game range: not judged (#761). Season-level: judged with the locked seasons. */
  consistency: false,
  /** The draft room, the Draft page and Rankings' draft mode: off in season; the auction values are not judged (#760). Back before the 2027-28 drafts. */
  draft: false,

  // AI notes

  /** The scouting notes page and the one-line AI notes and their calls ("Start", "Sit"), on every page: not judged (#879's follow-up). Week-level: judged at weeks 10 and 20. */
  notes: false,
  /** "Explain this trade" (AI, ADR 0017): it explains the trade verdict, which failed (#886). Back with the verdict. */
  explainTrade: false,

  // Injuries

  /**
   * The games-missed estimate, the share of games a player is expected to play, and the IL
   * threshold on it: not judged (#770, #763). Until then the pages show the injury report's
   * listing and its own return date only. Season-level: judged with the locked seasons.
   */
  injuryEstimate: false,

  // Trade

  /** The verdict's "even", "fair" and "favours" calls, and the win-win objective: failed (ADR 0023, #886). The bad and terrible warning passed and stays. Season-level: the locked seasons. */
  tradeVerdict: false,
  /** Suggested trades, and the players worth about the same: failed (ADR 0023, #887). Season-level: the locked seasons. */
  tradeSuggestions: false,
  /** The trade finder: its partners lose, and win-win failed (ADR 0023, #888). Season-level: the locked seasons. */
  tradeFinder: false,
  /** Sell high: failed (#903). Season-level: the locked seasons. */
  sellHigh: false,
  /** Buy low in an NBA league: passed (ADR 0027). */
  buyLowNba: true,
  /** Buy low in a WNBA league: failed (#904). Season-level: the locked WNBA 2026 season. */
  buyLowWnba: false,
  /** Trade chips and targets for a punt build: rework or remove (#896). Season-level: the locked seasons. */
  tradeChips: false,

  // Pickups and My Team

  /** Pickups' "Top 3 adds" call: the window value's ranking presented as advice is not judged (#762). Week-level: judged at weeks 10 and 20. The table stays, as data. */
  topAdds: false,
  /** The paired swaps, "Add X, drop Y" with Apply, on Pickups and My Team: failed (ADR 0024, #895). Only the drop rule passed. Week-level: judged at weeks 10 and 20. */
  swaps: false,
  /** Playoff odds: their calibration failed (ADR 0025, ADR 0028); points leagues too (ADR 0029). Season-level: back with #907 and #913. */
  playoffs: false,
  /** The projected power order: failed in the NBA (ADR 0021). Season-level: back with #867. */
  power: false,
  /** "Your categories" against the whole league: its season aggregate is being reworked to count punts. Back with the punts fix. */
  categories: false,
  /** Build your team's trades: the trade verdict, suggestions and finder failed (ADR 0023). Season-level: back with #886 to #888. */
  build: false,
  /** Who takes an out player's minutes: not judged (#763). Season-level: the locked seasons. */
  minutes: false,
  /** Stream picks and the categories they chase: not judged (ADR 0026). Week-level: back with #902 at weeks 10 and 20. */
  streams: false,
  /** The "too close" band: its fit was degenerate (ADR 0026). Week-level: back with #902 at weeks 10 and 20. */
  tooClose: false,
  /** The week's lineup plan, who sits a full lineup and the open slots to stream: not judged (#759). Week-level: judged at weeks 10 and 20. */
  lineup: false,
} as const;

/** Whether buy low shows in this league: it passed in the NBA (ADR 0027) and failed in the WNBA (#904). */
export const showsBuyLow = (league: 'nba' | 'wnba'): boolean => (league === 'nba' ? SHOWS.buyLowNba : SHOWS.buyLowWnba);
