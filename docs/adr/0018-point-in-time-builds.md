# 0018. Point-in-time builds

Date: 2026-11-07
Status: Accepted

## Context

The methodology overhaul (#751) requires every parameter to pass an out-of-sample, walk-forward backtest. That means the lakehouse must be rebuildable as it stood on any past day.

The `as_of` var moved only the schedule's cut-offs (games remaining, the next seven days). Every model still read every game, report, snapshot and news item. An "as of" build was not a picture of the past.

The existing backtests escaped this because `notebooks/replay.py` re-implements the projection in Python. That replay doesn't cover availability, the rest-of-season factor or injury charges, so only part of the pipeline could be tested.

## Decision

A build with `point_in_time: true` and `as_of: <date>` sees the world at the start of that Eastern day. The `known_before`, `current_only` and `is_final` macros (`dbt/macros/point_in_time.sql`) apply the cut where each source is typed:

- **Events** are cut by when they happened. This covers box scores and game logs (`team_game_box`, which carries `games` with it, and `fct_player_game`), shots, play-by-play, tracking, officials and lineups. A backfill lands old games today, so the ingest date says nothing about when a game was played.
- **Snapshots of the world** are cut by when they were observed:
  - official injury reports, by publication time; `is_latest` is then the newest report known by then;
  - ESPN injury statuses, news, the fantasy market, lines and standings, by observation date;
  - roster snapshots, through `latest_snapshot(..., observed=true)`;
  - transactions, by their date;
  - props, by snapshot time.

  For past seasons nothing was observed, so these are honestly absent rather than borrowed from today.
- **Sources that keep only their newest file** (Sleeper's trending list) are empty.
- **A game is played** only if it fell before `as_of`, whatever its status says now (`is_final`).
- **Identity reference data is not cut:** names, ids, team abbreviations, positions and the published schedule.

`as_of` alone keeps its older meaning, the run's date that tests pin. The cut needs both vars:

    dbt build --full-refresh --vars '{as_of: 2025-01-15, point_in_time: true}'

**Guard.** An `on-run-start` hook (`guard_point_in_time`) reads the global vars once per run. A point-in-time build must have an `as_of`, must run on DuckDB (so a backtest can never replace the production lakehouse) and must be a `--full-refresh` (so no incremental model keeps rows from after the date). The hook reads only global vars, so a unit test that pins `point_in_time` for its own case compiles on any target, including the nightly Databricks build.

**Proof in CI.** `ops/point_in_time_check.py` rebuilds the sample from scratch twice:

- **As of its first game day:** no dated table (22 of them) may hold a row on or after the date, and a newest-only source must be empty.
- **As of the day after its last game:** still no row from after the date, and every event table must keep every earlier row the full build has. An over-cut fails too, such as a game log cut by the day a backfill landed it.

A dated table or column missing from the build is a failure. Tables the sample leaves empty are named in the output, since they prove nothing.

Unit tests pin both sides of the cut in `fct_player_game`: with `point_in_time` only earlier games stay, and with `as_of` alone every game stays.

## Consequences

- The walk-forward harness (#751) can rebuild the lakehouse at any checkpoint with dbt itself. The Python replay then becomes a second implementation with a parity check, rather than the only way to backtest.
- Point-in-time builds of past seasons have no injury statuses, market, lines or standings, because none were observed then. Features that need them can be backtested only from the day ingestion of each began. The Methodology page says so per feature.
- A new dated source must be cut where it is typed, and added to the check's table list.
