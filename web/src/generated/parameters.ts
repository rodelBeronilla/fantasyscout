// Generated from methodology/parameters.yml by `uv run python -m ops.parameters`; do not edit (#765).

/** Every registered parameter's value, by id. */
export const PARAMS = {
  "scale.teams": {
    "nba": 12,
    "wnba": 10
  },
  "scale.roster_spots": {
    "nba": 13,
    "wnba": 10
  },
  "projection.fantasy_recency": [
    1.0,
    0.25,
    0.08
  ],
  "projection.prior_games": {
    "nba": 3,
    "wnba": 5
  },
  "projection.minutes_recency": {
    "nba": [
      1.0,
      0.25,
      0.08
    ],
    "wnba": [
      1.0,
      0.06,
      0.02
    ]
  },
  "projection.durability_games": {
    "nba": 10,
    "wnba": 60
  },
  "projection.typical_share": 0.8,
  "projection.team_change": 0.25,
  "projection.recent_minutes": 0.5,
  "projection.return_ramp": {
    "min_games_missed": 3,
    "per_game_missed": 0.01,
    "max_cut": 0.5,
    "games_back": 2
  },
  "projection.rest_risk": {
    "nba": {
      "extra_sit_out": 0.29,
      "min_minutes": 28
    },
    "wnba": {
      "extra_sit_out": 0.0,
      "min_minutes": 28
    }
  },
  "projection.market_prior": {
    "leagues": [
      "nba"
    ],
    "weight": 0.45,
    "fade_games": 20
  },
  "projection.calibration_min_listings": 300,
  "projection.regular_season_games": {
    "nba": 82
  },
  "matchup.weights": {
    "nba": {
      "defense": 0.21,
      "pace": 0.08
    },
    "wnba": {
      "defense": 0.14,
      "pace": 0.06
    },
    "prior_games": 10
  },
  "standings.game_spread": {
    "nba": {
      "z_points": 1.14,
      "z_rebounds_total": 1.1,
      "z_assists": 1.03,
      "z_steals": 3.12,
      "z_blocks": 1.77,
      "z_three_pointers_made": 1.61,
      "z_turnovers": 1.63,
      "z_field_goal_pct": 2.85,
      "z_free_throw_pct": 2.67
    },
    "wnba": {
      "z_points": 1.13,
      "z_rebounds_total": 1.05,
      "z_assists": 1.07,
      "z_steals": 2.47,
      "z_blocks": 1.62,
      "z_three_pointers_made": 1.43,
      "z_turnovers": 1.82,
      "z_field_goal_pct": 2.69,
      "z_free_throw_pct": 2.83
    }
  },
  "standings.games_per_week": {
    "nba": 3.3,
    "wnba": 2.6
  },
  "standings.rival_min_share": 0.5,
  "standings.spread_scale": {
    "nba": 2.0,
    "wnba": 2.0
  },
  "standings.projection_spread": {
    "nba": 0.8,
    "wnba": 0.8
  },
  "fit.thirds": {
    "weak": 1.5,
    "middle": 1.0,
    "strong": 0.5
  },
  "matchup.closeness": 0.05,
  "trade.value_limits": {
    "bad": -0.15,
    "terrible": -0.3
  },
  "trade.market_limits": {
    "bad": -0.2,
    "terrible": -0.35
  },
  "trade.category_limits": {
    "bad": 2,
    "terrible": 5
  },
  "trade.disagreement": 0.35,
  "trade.even": {
    "value": 0.1,
    "market": 0.15
  },
  "trade.category_change": 0.02,
  "trade.chance_bands": {
    "conceding": 0.25,
    "locked": 0.75
  },
  "trade.meaningful_gain": 0.05,
  "trade.suggest": {
    "tolerance": 0.15,
    "min_gain": 0.05
  },
  "trade.search": {
    "max_add": 3,
    "max_add_both": 2,
    "candidates": 8,
    "pool": 16,
    "per_partner": 3
  },
  "roster.starter_share": 0.6,
  "roster.bench_size": 2,
  "roster.min_gain": 0.5,
  "roster.candidates": 25,
  "buysell.min_swing": 1,
  "il.min_games": 3,
  "injury.box_score_regular": {
    "min_minutes": 20,
    "recent_games": 10
  },
  "injury.recovery_min_spells": 30,
  "blowout.spread": 10,
  "blowout.minutes_per_5_points": {
    "nba": 0.73,
    "wnba": 0.37
  },
  "auction.budget": 200,
  "auction.min_bid": 1,
  "backtest.checkpoints": [
    0.0,
    0.1,
    0.25,
    0.5
  ],
  "backtest.min_games": 10,
  "backtest.bootstrap": 1000,
  "backtest.standings_leagues": 200,
  "backtest.standings_draft_choice": 5
} as const;

/** Every registered parameter, for the Methodology page. */
export const PARAMETERS = [
  {
    "id": "scale.teams",
    "kind": "model",
    "status": "convention",
    "what": "Teams in the default league: replacement level is this many players after the pool. A league's own setup replaces it in the browser.",
    "evidence": "the common platform default",
    "validation": 754,
    "dbt": "fantasy.*.teams",
    "value": {
      "nba": 12,
      "wnba": 10
    }
  },
  {
    "id": "scale.roster_spots",
    "kind": "model",
    "status": "convention",
    "what": "Roster spots per team in the default league: the pool is teams x roster spots.",
    "evidence": "the common platform default",
    "validation": 754,
    "dbt": "fantasy.*.roster_spots",
    "value": {
      "nba": 13,
      "wnba": 10
    }
  },
  {
    "id": "projection.fantasy_recency",
    "kind": "model",
    "status": "measured",
    "what": "Weights of the current season and the two before it in per-minute production.",
    "evidence": "ADR 0009: in-sample grid; out of sample [1, 0.5, 0.25] made no difference",
    "validation": 754,
    "dbt": "fantasy_recency",
    "value": [
      1.0,
      0.25,
      0.08
    ]
  },
  {
    "id": "projection.prior_games",
    "kind": "model",
    "status": "measured",
    "what": "Games of a replacement-level player every projection starts from; a past season's line is shrunk by the same before it sets that season's value scale (ADR 0019).",
    "evidence": "ADR 0009",
    "validation": 754,
    "dbt": "fantasy.*.prior_games",
    "value": {
      "nba": 3,
      "wnba": 5
    }
  },
  {
    "id": "projection.minutes_recency",
    "kind": "model",
    "status": "measured",
    "what": "Weights of the current season and the two before it in minutes per game.",
    "evidence": "ADR 0009",
    "validation": 754,
    "dbt": "fantasy.*.minutes_recency",
    "value": {
      "nba": [
        1.0,
        0.25,
        0.08
      ],
      "wnba": [
        1.0,
        0.06,
        0.02
      ]
    }
  },
  {
    "id": "projection.durability_games",
    "kind": "model",
    "status": "measured",
    "what": "Games that regress the share of team games played toward typical_share.",
    "evidence": "ADR 0009 (WNBA: every value from 5 to 120 scored within a tenth)",
    "validation": 754,
    "dbt": "fantasy.*.durability_games",
    "value": {
      "nba": 10,
      "wnba": 60
    }
  },
  {
    "id": "projection.typical_share",
    "kind": "model",
    "status": "assumed",
    "what": "The share of team games a player is regressed toward.",
    "evidence": "none: no fit shown",
    "validation": 754,
    "dbt": "fantasy_durability.typical_share",
    "value": 0.8
  },
  {
    "id": "projection.team_change",
    "kind": "model",
    "status": "measured",
    "what": "The share of its minutes weight a past season spent mostly on another team keeps.",
    "evidence": "ADR 0009",
    "validation": 754,
    "dbt": "fantasy_team_change",
    "value": 0.25
  },
  {
    "id": "projection.recent_minutes",
    "kind": "model",
    "status": "measured",
    "what": "Weight of the last five games in projected minutes, in season.",
    "evidence": "ADR 0009 (next-ten-game minutes error 3.98 to 3.44 NBA)",
    "validation": 754,
    "dbt": "fantasy_recent_minutes",
    "value": 0.5
  },
  {
    "id": "projection.return_ramp",
    "kind": "model",
    "status": "measured",
    "what": "Minutes cut for a player back from three or more straight games missed.",
    "evidence": "ADR 0009 (grid, out of sample)",
    "validation": 754,
    "dbt": "fantasy_return_ramp",
    "value": {
      "min_games_missed": 3,
      "per_game_missed": 0.01,
      "max_cut": 0.5,
      "games_back": 2
    }
  },
  {
    "id": "projection.rest_risk",
    "kind": "model",
    "status": "measured",
    "what": "Extra share of games a regular sits on a team with nothing to play for.",
    "evidence": "ADR 0010, notebook 03 (NBA +29 points, 22 to 36). The 28-minute cut was not optimised",
    "validation": 754,
    "dbt": "fantasy_rest_risk",
    "value": {
      "nba": {
        "extra_sit_out": 0.29,
        "min_minutes": 28
      },
      "wnba": {
        "extra_sit_out": 0.0,
        "min_minutes": 28
      }
    }
  },
  {
    "id": "projection.market_prior",
    "kind": "model",
    "status": "measured",
    "what": "In the leagues listed: the weight a player's value per game gives the board's value of his rank in ESPN's draft order, falling linearly to nothing by fade_games games of the season being played.",
    "evidence": "ADR 0020: fitted on NBA 2020-21 to 2022-23 (runs 42456036003, 42456038211, 42456040262); judged out of sample on 2023-24 and 2024-25 (runs 42458451893, 42458454350): preseason RMSE -0.165 and -0.218, Spearman +0.029 and +0.028, top pool +4.5 and +3.8 points, nothing measurable at half way. The WNBA has no past market to test on, so it is off there",
    "validation": 832,
    "dbt": "market_prior",
    "value": {
      "leagues": [
        "nba"
      ],
      "weight": 0.45,
      "fade_games": 20
    }
  },
  {
    "id": "projection.calibration_min_listings",
    "kind": "model",
    "status": "assumed",
    "what": "Listings a league needs before its own injury history replaces the NBA's.",
    "evidence": "none",
    "validation": 763,
    "dbt": "calibration_min_listings",
    "value": 300
  },
  {
    "id": "projection.regular_season_games",
    "kind": "model",
    "status": "arithmetic",
    "what": "Regular-season games per NBA team while the schedule lists Cup placeholders.",
    "evidence": "the league's format",
    "validation": 754,
    "dbt": "regular_season_games",
    "value": {
      "nba": 82
    }
  },
  {
    "id": "matchup.weights",
    "kind": "model",
    "status": "measured",
    "what": "Value per game per standard deviation of the opponent's defence and the pace.",
    "evidence": "ADR 0009 (replay); notebook 03 re-checks against the betting line",
    "validation": 762,
    "dbt": "fantasy_matchup",
    "value": {
      "nba": {
        "defense": 0.21,
        "pace": 0.08
      },
      "wnba": {
        "defense": 0.14,
        "pace": 0.06
      },
      "prior_games": 10
    }
  },
  {
    "id": "standings.game_spread",
    "kind": "model",
    "status": "measured",
    "what": "One game's standard deviation of a player's output per category, in board z units.",
    "evidence": "ADR 0015 (an ad hoc lakehouse query; no notebook reproduces it yet)",
    "validation": 755,
    "value": {
      "nba": {
        "z_points": 1.14,
        "z_rebounds_total": 1.1,
        "z_assists": 1.03,
        "z_steals": 3.12,
        "z_blocks": 1.77,
        "z_three_pointers_made": 1.61,
        "z_turnovers": 1.63,
        "z_field_goal_pct": 2.85,
        "z_free_throw_pct": 2.67
      },
      "wnba": {
        "z_points": 1.13,
        "z_rebounds_total": 1.05,
        "z_assists": 1.07,
        "z_steals": 2.47,
        "z_blocks": 1.62,
        "z_three_pointers_made": 1.43,
        "z_turnovers": 1.82,
        "z_field_goal_pct": 2.69,
        "z_free_throw_pct": 2.83
      }
    }
  },
  {
    "id": "standings.games_per_week",
    "kind": "model",
    "status": "arithmetic",
    "what": "Games a team plays in a fantasy week: a season's games over its weeks.",
    "evidence": "the schedules",
    "validation": 755,
    "value": {
      "nba": 3.3,
      "wnba": 2.6
    }
  },
  {
    "id": "standings.rival_min_share",
    "kind": "threshold",
    "status": "assumed",
    "what": "Share of a roster a team needs entered before it counts as a rival in the standings.",
    "evidence": "none",
    "validation": 755,
    "value": 0.5
  },
  {
    "id": "standings.spread_scale",
    "kind": "model",
    "status": "measured",
    "what": "Multiplies the games' spread of the gap between two teams, in both formats: what the measured per-game spreads miss (a projection's own error over a week, games that are not independent).",
    "evidence": "ops.standings_backtest fit on the tuning seasons, the lowest head-to-head log loss on a grid of 0.5 to 2.0: NBA 2020-21 to 2022-23 (runs 42466140329, 42468833908, 42466144841), log loss 0.693 at 1 to 0.629; WNBA 2021 to 2023 (runs 42468836211, 42466314090, 42466316345), 0.689 to 0.640. Both sit at the grid's edge",
    "validation": 755,
    "value": {
      "nba": 2.0,
      "wnba": 2.0
    }
  },
  {
    "id": "standings.projection_spread",
    "kind": "model",
    "status": "measured",
    "what": "A projection's own error per category and player, added to a rotisserie season's spread.",
    "evidence": "ops.standings_backtest fit on the same tuning seasons with the spread scale fixed, grid 0 to 1.5: rotisserie log loss NBA 0.569 at the assumed 0.3 to 0.518, WNBA 0.587 to 0.565",
    "validation": 755,
    "value": {
      "nba": 0.8,
      "wnba": 0.8
    }
  },
  {
    "id": "fit.thirds",
    "kind": "model",
    "status": "assumed",
    "what": "Category weights for the weakest, middle and strongest thirds, when no rival roster is in.",
    "evidence": "none",
    "validation": 755,
    "value": {
      "weak": 1.5,
      "middle": 1.0,
      "strong": 0.5
    }
  },
  {
    "id": "matchup.closeness",
    "kind": "threshold",
    "status": "assumed",
    "what": "A weekly category within this share is called too close.",
    "evidence": "none",
    "validation": 755,
    "value": 0.05
  },
  {
    "id": "trade.value_limits",
    "kind": "threshold",
    "status": "assumed",
    "what": "Value lens: the share given away that makes a trade bad or terrible.",
    "evidence": "none (one anecdote, #692)",
    "validation": 756,
    "value": {
      "bad": -0.15,
      "terrible": -0.3
    }
  },
  {
    "id": "trade.market_limits",
    "kind": "threshold",
    "status": "assumed",
    "what": "Market lens: the share given away that makes a trade bad or terrible.",
    "evidence": "none",
    "validation": 756,
    "value": {
      "bad": -0.2,
      "terrible": -0.35
    }
  },
  {
    "id": "trade.category_limits",
    "kind": "threshold",
    "status": "assumed",
    "what": "Category lens: expected categories lost that make a trade bad or terrible.",
    "evidence": "none",
    "validation": 756,
    "value": {
      "bad": 2,
      "terrible": 5
    }
  },
  {
    "id": "trade.disagreement",
    "kind": "threshold",
    "status": "assumed",
    "what": "Gap between the value and market lenses that is called a disagreement.",
    "evidence": "none",
    "validation": 756,
    "value": 0.35
  },
  {
    "id": "trade.even",
    "kind": "threshold",
    "status": "assumed",
    "what": "The band within which each lens calls a trade even.",
    "evidence": "none",
    "validation": 756,
    "value": {
      "value": 0.1,
      "market": 0.15
    }
  },
  {
    "id": "trade.category_change",
    "kind": "threshold",
    "status": "assumed",
    "what": "A category's win chance must move this much to be listed as up or down.",
    "evidence": "none",
    "validation": 756,
    "value": 0.02
  },
  {
    "id": "trade.chance_bands",
    "kind": "threshold",
    "status": "assumed",
    "what": "Win chances below or above which a category is conceded or locked.",
    "evidence": "none",
    "validation": 756,
    "value": {
      "conceding": 0.25,
      "locked": 0.75
    }
  },
  {
    "id": "trade.meaningful_gain",
    "kind": "threshold",
    "status": "assumed",
    "what": "Expected categories a trade must add to count (per rival in rotisserie).",
    "evidence": "none",
    "validation": 756,
    "value": 0.05
  },
  {
    "id": "trade.suggest",
    "kind": "threshold",
    "status": "assumed",
    "what": "Suggestions: how far from even a package may be, and the least it must gain.",
    "evidence": "none",
    "validation": 756,
    "value": {
      "tolerance": 0.15,
      "min_gain": 0.05
    }
  },
  {
    "id": "trade.search",
    "kind": "search",
    "status": "assumed",
    "what": "How many players a suggestion adds (fewer when both sides are already set), and how many it and the finder try.",
    "evidence": "none",
    "validation": 756,
    "value": {
      "max_add": 3,
      "max_add_both": 2,
      "candidates": 8,
      "pool": 16,
      "per_partner": 3
    }
  },
  {
    "id": "roster.starter_share",
    "kind": "threshold",
    "status": "assumed",
    "what": "Share of roster spots counted as starters: a player ranked inside teams x this is never dropped.",
    "evidence": "none",
    "validation": 757,
    "value": 0.6
  },
  {
    "id": "roster.bench_size",
    "kind": "threshold",
    "status": "assumed",
    "what": "The lowest-valued players a week's form may drop.",
    "evidence": "none",
    "validation": 757,
    "value": 2
  },
  {
    "id": "roster.min_gain",
    "kind": "threshold",
    "status": "assumed",
    "what": "Value a swap must gain. Applied to week and rest-of-season values, which are in different units.",
    "evidence": "none",
    "validation": 757,
    "value": 0.5
  },
  {
    "id": "roster.candidates",
    "kind": "search",
    "status": "assumed",
    "what": "Free agents, best first, a review considers.",
    "evidence": "none",
    "validation": 757,
    "value": 25
  },
  {
    "id": "buysell.min_swing",
    "kind": "threshold",
    "status": "assumed",
    "what": "Value per game between last-ten form and the projection that counts as a swing.",
    "evidence": "none (and the two sides are on different pools, #767)",
    "validation": 758,
    "value": 1
  },
  {
    "id": "il.min_games",
    "kind": "threshold",
    "status": "assumed",
    "what": "Games a player is expected to miss before an IL move is suggested.",
    "evidence": "none (its input is calibrated, ADR 0010)",
    "validation": 763,
    "value": 3
  },
  {
    "id": "injury.box_score_regular",
    "kind": "threshold",
    "status": "assumed",
    "what": "Who counts as a regular for a box-score absence spell: played the team's previous game and averaged these minutes over these games.",
    "evidence": "none; a regular rarely sits by the coach's choice",
    "validation": 770,
    "dbt": "absence_spells",
    "value": {
      "min_minutes": 20,
      "recent_games": 10
    }
  },
  {
    "id": "injury.recovery_min_spells",
    "kind": "threshold",
    "status": "assumed",
    "what": "Injury spells a body part, or a body part and kind, needs for its own recovery curve.",
    "evidence": "none; a common floor for a Kaplan-Meier median that is not one or two spells",
    "validation": 770,
    "dbt": "recovery_min_spells",
    "value": 30
  },
  {
    "id": "blowout.spread",
    "kind": "threshold",
    "status": "assumed",
    "what": "Point spread from which a starter's next game is flagged lopsided.",
    "evidence": "none",
    "validation": 762,
    "value": 10
  },
  {
    "id": "blowout.minutes_per_5_points",
    "kind": "model",
    "status": "measured",
    "what": "Minutes a starter loses per five points of spread.",
    "evidence": "ADR 0012, notebook 03",
    "validation": 762,
    "value": {
      "nba": 0.73,
      "wnba": 0.37
    }
  },
  {
    "id": "auction.budget",
    "kind": "model",
    "status": "convention",
    "what": "Dollars per team: the Yahoo and ESPN default.",
    "evidence": "platform default",
    "validation": 760,
    "value": 200
  },
  {
    "id": "auction.min_bid",
    "kind": "model",
    "status": "convention",
    "what": "The least a roster spot costs.",
    "evidence": "platform default",
    "validation": 760,
    "value": 1
  },
  {
    "id": "backtest.checkpoints",
    "kind": "search",
    "status": "convention",
    "what": "Where a season is cut for a backtest: the first game day and these shares of the way to the last.",
    "evidence": "ADR 0003's checkpoints (before a season, a tenth, a quarter and half way in)",
    "validation": 769,
    "value": [
      0.0,
      0.1,
      0.25,
      0.5
    ]
  },
  {
    "id": "backtest.min_games",
    "kind": "threshold",
    "status": "assumed",
    "what": "Games a player must play after a checkpoint to be judged: fewer and the realized value is mostly noise.",
    "evidence": "none; an evaluation choice, not a model one",
    "validation": 769,
    "value": 10
  },
  {
    "id": "backtest.bootstrap",
    "kind": "search",
    "status": "convention",
    "what": "Resamples of players behind the interval of the board's error minus the naive manager's.",
    "evidence": "a common size for a 95% percentile interval",
    "validation": 769,
    "value": 1000
  },
  {
    "id": "backtest.standings_leagues",
    "kind": "search",
    "status": "convention",
    "what": "Simulated leagues drafted at each checkpoint to judge the standings model (#755).",
    "evidence": "an evaluation choice: more leagues average over more rosters, not over more games",
    "validation": 755,
    "value": 200
  },
  {
    "id": "backtest.standings_draft_choice",
    "kind": "search",
    "status": "convention",
    "what": "A simulated draft's pick is drawn at random from this many of the best players left, so the leagues differ.",
    "evidence": "an evaluation choice, not a model one",
    "validation": 755,
    "value": 5
  }
] as const;
