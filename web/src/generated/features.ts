// Generated from methodology/features.yml by `uv run python -m ops.parameters`; do not edit (#947).

/** A page: its name, and its address when it has one of its own. */
export interface Page {
  readonly label: string;
  readonly path?: string;
}

/** A feature and the verdict on it (methodology/features.yml explains each field). */
export interface Feature {
  readonly id: string;
  readonly what: string;
  readonly page: string;
  readonly verdict: 'validated' | 'failed' | 'open' | 'data';
  readonly switch?: string;
  readonly shown?: 'shown' | 'badged' | 'hidden';
  readonly adr?: number;
  readonly issue?: number;
  readonly parameters: readonly string[];
  readonly next: string;
  readonly dates?: readonly string[];
  readonly bar?: string;
}

/** The pages a feature lives on. */
export const PAGES: Readonly<Record<string, Page>> = {
  "rankings": {
    "label": "Rankings",
    "path": "/"
  },
  "player": {
    "label": "Player page"
  },
  "team": {
    "label": "My Team",
    "path": "/team/"
  },
  "pickups": {
    "label": "Pickups",
    "path": "/streamers/"
  },
  "trade": {
    "label": "Trade",
    "path": "/trade/"
  },
  "league": {
    "label": "League",
    "path": "/league/"
  },
  "draft": {
    "label": "Draft",
    "path": "/draft/"
  },
  "site": {
    "label": "Every page"
  }
};

/** The file of each ADR a feature names, by number, in docs/adr. */
export const ADR_FILES: Readonly<Record<string, string>> = {
  "11": "0011-streamers-sort.md",
  "19": "0019-one-value-scale.md",
  "20": "0020-preseason-market-prior.md",
  "21": "0021-standings-model-validated.md",
  "23": "0023-trade-page-judged.md",
  "24": "0024-roster-review-judged.md",
  "25": "0025-playoff-odds-judged.md",
  "26": "0026-matchup-card-chances-judged.md",
  "27": "0027-buy-low-sell-high-judged.md",
  "31": "0031-board-value-validated-in-season.md"
};

/** Every feature the site shows or hides, and its verdict: the Methodology table. */
export const FEATURES: readonly Feature[] = [
  {
    "id": "board-value",
    "what": "Value per game in season: each player's projected value above a replacement-level pickup in your league",
    "page": "rankings",
    "verdict": "validated",
    "shown": "shown",
    "adr": 31,
    "issue": 754,
    "parameters": [
      "projection.fantasy_recency",
      "projection.prior_games",
      "projection.minutes_recency",
      "projection.team_change",
      "projection.recent_minutes",
      "projection.return_ramp",
      "projection.features.pace",
      "projection.features.usage_weight",
      "projection.features.fg_shrink",
      "projection.features.ft_shrink",
      "projection.features.other_team_production",
      "scale.teams",
      "scale.roster_spots"
    ],
    "next": "Re-checked on NBA 2026-27 after its regular season (April 2027) and on WNBA 2027 (September 2027)"
  },
  {
    "id": "market-prior",
    "what": "The market prior: early in an NBA season, value leans on ESPN's draft order, fading over the first 20 games",
    "page": "rankings",
    "verdict": "validated",
    "shown": "shown",
    "adr": 20,
    "issue": 832,
    "parameters": [
      "projection.market_prior"
    ],
    "next": "Its judged seasons are spent; a re-fit is judged on seasons it has not seen (ADR 0020)"
  },
  {
    "id": "matchup-chances",
    "what": "The week's matchup at the week's start: each category's chance of being won",
    "page": "team",
    "verdict": "validated",
    "shown": "shown",
    "adr": 26,
    "issue": 869,
    "parameters": [
      "matchup.game_spread"
    ],
    "next": "With the locked seasons (#769)"
  },
  {
    "id": "drop-rule",
    "what": "Who may be dropped: the roster review's rule that never drops a starter",
    "page": "pickups",
    "verdict": "validated",
    "shown": "shown",
    "adr": 24,
    "issue": 757,
    "parameters": [
      "roster.starter_share"
    ],
    "next": "With the locked seasons (#769)"
  },
  {
    "id": "trade-warning",
    "what": "A trade called bad or terrible",
    "page": "trade",
    "verdict": "validated",
    "shown": "shown",
    "adr": 23,
    "issue": 756,
    "parameters": [
      "trade.value_limits",
      "trade.market_limits",
      "trade.category_limits"
    ],
    "next": "With the locked seasons (#769)"
  },
  {
    "id": "trade-categories",
    "what": "Each of your categories a trade moves up or down, and those conceded or locked",
    "page": "trade",
    "verdict": "validated",
    "shown": "shown",
    "adr": 23,
    "issue": 756,
    "parameters": [
      "trade.category_change",
      "trade.chance_bands"
    ],
    "next": "With the locked seasons (#769)"
  },
  {
    "id": "buy-low-nba",
    "what": "Buy low in an NBA league: players whose last ten games ran below their projection",
    "page": "trade",
    "verdict": "validated",
    "shown": "shown",
    "adr": 27,
    "issue": 758,
    "parameters": [
      "buysell.min_swing"
    ],
    "next": "With the locked seasons (#769)"
  },
  {
    "id": "playoff-odds",
    "what": "Playoff odds, in categories and points leagues",
    "page": "team",
    "verdict": "failed",
    "switch": "playoffs",
    "adr": 25,
    "issue": 907,
    "parameters": [
      "playoffs.season_share",
      "playoffs.points_spread_share",
      "playoffs.points_season_share"
    ],
    "next": "Season-level: the locked seasons (#769), or NBA 2026-27's end (April 2027)"
  },
  {
    "id": "power-rankings",
    "what": "The projected power order of the league's teams",
    "page": "team",
    "verdict": "failed",
    "switch": "power",
    "adr": 21,
    "issue": 867,
    "parameters": [
      "standings.spread_scale",
      "standings.projection_spread"
    ],
    "next": "Season-level: the locked seasons (#769), or NBA 2026-27's end (April 2027)"
  },
  {
    "id": "too-close",
    "what": "A matchup category called too close to call",
    "page": "team",
    "verdict": "failed",
    "switch": "tooClose",
    "adr": 26,
    "issue": 902,
    "parameters": [
      "matchup.closeness"
    ],
    "next": "Not scheduled: the label needs the owner's definition first (#902)"
  },
  {
    "id": "swaps",
    "what": "The roster review's swaps: add this free agent, drop that player",
    "page": "team",
    "verdict": "failed",
    "switch": "swaps",
    "adr": 24,
    "issue": 895,
    "parameters": [
      "roster.min_gain",
      "roster.bench_size",
      "roster.candidates"
    ],
    "next": "On 2026-27's weeks",
    "dates": [
      "2027-01-18",
      "2027-03-15"
    ],
    "bar": "https://github.com/rodelBeronilla/fantasyscout/issues/895#issuecomment-6735150083"
  },
  {
    "id": "build-your-team",
    "what": "Build your team's trades: the trades My Team suggests",
    "page": "team",
    "verdict": "failed",
    "switch": "build",
    "adr": 23,
    "issue": 886,
    "parameters": [
      "trade.suggest",
      "trade.search"
    ],
    "next": "Season-level: the locked seasons (#769), or NBA 2026-27's end (April 2027)"
  },
  {
    "id": "fit",
    "what": "Fit: value weighted to your team's needs",
    "page": "rankings",
    "verdict": "failed",
    "shown": "badged",
    "adr": 21,
    "issue": 868,
    "parameters": [
      "fit.thirds"
    ],
    "next": "Season-level: after a rework, on the locked seasons (#769)"
  },
  {
    "id": "trade-verdict",
    "what": "The trade verdict's even, fair and favours calls",
    "page": "trade",
    "verdict": "failed",
    "shown": "badged",
    "adr": 23,
    "issue": 886,
    "parameters": [
      "trade.even",
      "trade.meaningful_gain",
      "trade.disagreement"
    ],
    "next": "Season-level: the locked seasons (#769), or NBA 2026-27's end (April 2027)"
  },
  {
    "id": "trade-suggestions",
    "what": "Suggested trades",
    "page": "trade",
    "verdict": "failed",
    "shown": "badged",
    "adr": 23,
    "issue": 887,
    "parameters": [
      "trade.suggest"
    ],
    "next": "Season-level: the locked seasons (#769), or NBA 2026-27's end (April 2027)"
  },
  {
    "id": "trade-finder",
    "what": "The trade finder: trades across your league",
    "page": "trade",
    "verdict": "failed",
    "shown": "badged",
    "adr": 23,
    "issue": 888,
    "parameters": [
      "trade.search"
    ],
    "next": "Season-level: the locked seasons (#769), or NBA 2026-27's end (April 2027)"
  },
  {
    "id": "sell-high",
    "what": "Sell high: players whose last ten games ran above their projection",
    "page": "trade",
    "verdict": "failed",
    "shown": "badged",
    "adr": 27,
    "issue": 903,
    "parameters": [
      "buysell.min_swing"
    ],
    "next": "Season-level: the locked seasons (#769)"
  },
  {
    "id": "preseason-value",
    "what": "Value before the first game, after the last, and early in the season while preseason information still weighs",
    "page": "rankings",
    "verdict": "open",
    "shown": "badged",
    "adr": 31,
    "issue": 754,
    "parameters": [
      "projection.market_prior",
      "backtest.checkpoints"
    ],
    "next": "NBA 2026-27's first game day, judged once its regular season ends (April 2027)"
  },
  {
    "id": "value-totals",
    "what": "Season and rest-of-season value: value per game times the share of games a player is expected to play",
    "page": "rankings",
    "verdict": "open",
    "shown": "badged",
    "adr": 31,
    "issue": 754,
    "parameters": [
      "projection.durability_games",
      "projection.typical_share",
      "projection.rest_risk"
    ],
    "next": "With the board's re-check after NBA 2026-27 (April 2027), under a bar declared on #754 first"
  },
  {
    "id": "midweek-chances",
    "what": "The matchup's chances mid-week, from the score so far",
    "page": "team",
    "verdict": "open",
    "shown": "shown",
    "adr": 26,
    "issue": 950,
    "parameters": [
      "matchup.game_spread"
    ],
    "next": "On 2026-27's weeks",
    "dates": [
      "2027-01-18",
      "2027-03-15"
    ],
    "bar": "https://github.com/rodelBeronilla/fantasyscout/issues/950#issuecomment-6735150995"
  },
  {
    "id": "streams",
    "what": "Stream picks: the free agent to add for the categories you are losing this week",
    "page": "team",
    "verdict": "open",
    "switch": "streams",
    "adr": 26,
    "issue": 902,
    "parameters": [
      "matchup.game_spread"
    ],
    "next": "On 2026-27's weeks",
    "dates": [
      "2027-01-18",
      "2027-03-15"
    ],
    "bar": "https://github.com/rodelBeronilla/fantasyscout/issues/902#issuecomment-6735149425"
  },
  {
    "id": "lineup",
    "what": "The week's lineup plan: who starts each day, who sits a full lineup, and the open slots",
    "page": "team",
    "verdict": "open",
    "switch": "lineup",
    "issue": 759,
    "parameters": [],
    "next": "On 2026-27's weeks",
    "dates": [
      "2027-01-18",
      "2027-03-15"
    ],
    "bar": "https://github.com/rodelBeronilla/fantasyscout/issues/759#issuecomment-6735149779"
  },
  {
    "id": "top-adds",
    "what": "Pickups' \"this week\" ranking presented as advice: Top 3 adds",
    "page": "pickups",
    "verdict": "open",
    "shown": "badged",
    "adr": 11,
    "issue": 762,
    "parameters": [
      "matchup.weights",
      "blowout.spread",
      "blowout.minutes_per_5_points"
    ],
    "next": "On 2026-27's weeks",
    "dates": [
      "2027-01-18",
      "2027-03-15"
    ],
    "bar": "https://github.com/rodelBeronilla/fantasyscout/issues/762#issuecomment-6735150416"
  },
  {
    "id": "minutes",
    "what": "Who takes an out player's minutes, and the pickup that goes with it",
    "page": "team",
    "verdict": "open",
    "switch": "minutes",
    "issue": 763,
    "parameters": [
      "injury.rotation_minutes",
      "injury.min_games_missed"
    ],
    "next": "On 2026-27's weeks",
    "dates": [
      "2027-01-18",
      "2027-03-15"
    ],
    "bar": "https://github.com/rodelBeronilla/fantasyscout/issues/763#issuecomment-6735151667"
  },
  {
    "id": "injury-estimate",
    "what": "The games-missed estimate, and the IL moves made on it",
    "page": "team",
    "verdict": "open",
    "switch": "injuryEstimate",
    "issue": 770,
    "parameters": [
      "projection.calibration_min_listings",
      "il.min_games",
      "injury.box_score_regular",
      "injury.recovery_min_spells"
    ],
    "next": "On 2026-27's weeks",
    "dates": [
      "2027-01-18",
      "2027-03-15"
    ],
    "bar": "https://github.com/rodelBeronilla/fantasyscout/issues/770#issuecomment-6735151942"
  },
  {
    "id": "notes",
    "what": "The one-line AI notes and their calls: start, sit, add, drop, hold",
    "page": "site",
    "verdict": "open",
    "switch": "notes",
    "issue": 951,
    "parameters": [
      "notes.stand_days",
      "notes.late_hours"
    ],
    "next": "On 2026-27's weeks, once each day's calls are kept",
    "dates": [
      "2027-01-18",
      "2027-03-15"
    ],
    "bar": "https://github.com/rodelBeronilla/fantasyscout/issues/951#issuecomment-6735151348"
  },
  {
    "id": "your-categories",
    "what": "Your categories against the whole league, with punts counted",
    "page": "team",
    "verdict": "open",
    "switch": "categories",
    "adr": 21,
    "issue": 938,
    "parameters": [
      "standings.spread_scale",
      "standings.game_spread"
    ],
    "next": "Not scheduled: after the punt rework (#938), under a bar declared first"
  },
  {
    "id": "buy-low-wnba",
    "what": "Buy low in a WNBA league: its lists were too thin to judge",
    "page": "trade",
    "verdict": "open",
    "shown": "badged",
    "adr": 27,
    "issue": 904,
    "parameters": [
      "buysell.min_swing"
    ],
    "next": "Season-level: the locked WNBA 2026 season (#769)"
  },
  {
    "id": "consistency",
    "what": "Consistency: a player's game-to-game range",
    "page": "rankings",
    "verdict": "open",
    "shown": "badged",
    "issue": 761,
    "parameters": [],
    "next": "Season-level: the locked seasons (#769)"
  },
  {
    "id": "auction-values",
    "what": "Draft values and auction prices",
    "page": "draft",
    "verdict": "open",
    "shown": "badged",
    "issue": 760,
    "parameters": [
      "auction.budget",
      "auction.min_bid"
    ],
    "next": "Before the 2027-28 drafts"
  },
  {
    "id": "schedule",
    "what": "Games this week and tonight, games left, and the playoff weeks' game counts, from the league's schedule",
    "page": "team",
    "verdict": "data",
    "shown": "shown",
    "parameters": [
      "standings.games_per_week",
      "projection.regular_season_games"
    ],
    "next": "No check needed"
  },
  {
    "id": "injury-report",
    "what": "The injury report's listing and its own return date",
    "page": "player",
    "verdict": "data",
    "shown": "shown",
    "parameters": [],
    "next": "No check needed"
  },
  {
    "id": "standings",
    "what": "The league's real standings and records",
    "page": "league",
    "verdict": "data",
    "shown": "shown",
    "parameters": [],
    "next": "No check needed"
  },
  {
    "id": "stat-lines",
    "what": "Box scores, recent games, and the season, last-20 and last-10 lines",
    "page": "rankings",
    "verdict": "data",
    "shown": "shown",
    "adr": 19,
    "parameters": [],
    "next": "No check needed"
  }
];
