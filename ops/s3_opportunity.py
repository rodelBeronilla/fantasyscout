"""S3 (#1081): opportunity before outcome, for REB, AST, STL and BLK. NBA only.

    uv run python -m ops.s3_opportunity export --league nba --seasons 2018-19 ... 2022-23 \
        --full-db dbt/fantasyscout.duckdb --out s3-chances/
    uv run python -m ops.s3_opportunity fit closeness-nba-2020-21/ ... --chances s3-chances/ \
        --out fit.json
    uv run python -m ops.s3_opportunity judge --chances d1/ d2/ --tuning closeness-nba-2020-21/ ...
        --judged closeness-nba-2023-24/ closeness-nba-2024-25/ --out s3.json

The hypothesis, declared on #1081 before any run: over five to ten games rebounds, assists, steals
and blocks are noisy, while the chances behind them settle sooner; blending a player's recent
chances with his long-run conversion predicts next week's REB, AST, STL and BLK better than the
projection does now. Player tracking is NBA only (gold.fct_player_tracking), so the WNBA is not run.

The chances and their conversions, one pair per target category:

- REB: rebound chances (rebounds he was within 3.5 feet of); rebounds per chance;
- AST: potential assists (passes to a teammate who shot within one dribble); assists per one;
- STL: deflections; steals per deflection;
- BLK: contested shots; blocks per contested shot.

The study's week, for each player of S0's population (ops.week_yardstick) on each Monday, in each
target category: his chances per game over his last ``n`` games with a tracking line for them,
times his long-run conversion (box-score makes over chances, this season and the two before),
shrunk toward the league's conversion over the same games by ``k`` chances, times the games the
projection-week counts (none for a player listed out or doubtful). The other five categories are
the projection-week's, unchanged. A player with no tracking line for a category before the Monday
keeps the projection's line in it. Regular-season games only.

Every input is as of the week's Monday: only games strictly before it, of that season and the two
before (``LONG_RUN_SEASONS``). ``check_point_in_time`` proves it on every Monday of every run:
deleting every game from the Monday on, or rewriting every one of them, changes no input; the same
rewrite from the last game day before the Monday must change the inputs (the positive control).

``n`` and ``k`` are chosen per category on the tuning seasons only, by pooled week RMSE (``fit``;
ties to the earlier grid point), and frozen in ``CHOSEN`` before ``judge`` reads a judged season.
``judge`` scores the frozen choice once on the judged seasons with S0's harness and S0's bar, and
refuses the locked season.

Reported beside the verdict, declared here before any judged season was read, and not part of the
bar:

- **the recency control:** the same week from his box-score makes per game over the same last
  ``n`` games, with no chances in it, so a gain can be told apart from recency alone;
- **at the games played:** both arms' per-game lines times the games he really played, since the
  baseline's games count runs high (#1088); S3 changes no games count, so this is a sensitivity;
- **coverage:** each season's played games with a tracking line, and the share of the
  population's player-weeks the study had a line for;
- **the days:** the export's box scores summed Monday to Sunday against S0's real week.
"""

from __future__ import annotations

import argparse
import itertools
import json
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from ops import week_yardstick as wy
from ops.shot_diet import Monday, load_weeks, seasons_back
from ops.standings_backtest import JUDGED, STATS, TUNING
from ops.walk_forward import LOCKED

LEAGUE = "nba"
# the target categories, each with its box-score column and its tracking chances
PAIRS: dict[str, tuple[str, str]] = {
    "REB": ("reb", "rebound_chances"),
    "AST": ("ast", "potential_assists"),
    "STL": ("stl", "deflections"),
    "BLK": ("blk", "contested_shots"),
}
TARGETS = tuple(PAIRS)
COLUMN = {c: wy.CATEGORIES.index(c) for c in TARGETS}
# STATS' columns for the week's real totals of each target
REAL = {
    "REB": STATS.index("rebounds_total"),
    "AST": STATS.index("assists"),
    "STL": STATS.index("steals"),
    "BLK": STATS.index("blocks"),
}
# def: the recent chances are over a player's last this many games with a tracking line (the
# hypothesis's five to ten, and twenty as the longer reference)
RECENT_GAMES = (5, 10, 20)
# def: chances at the league's conversion added to a player's own
SHRINK = (0, 25, 100, 400)
# def: the long run is the season so far and the two before (the seasons a backtest mirrors)
LONG_RUN_SEASONS = 3

# Chosen on the tuning seasons by ``fit`` and committed before any judged season was read
# (``judge`` refuses to run without it). The fit read S0's NBA exports (runs 44942094895,
# 44942100340, 44942105040) and the chances of run 44971960142 (NBA 2018-19 to 2022-23, every
# game tracked). Pooled tuning week RMSE over 8,840 player-weeks, the projection's then the
# study's at its point:
#   REB 10.3309 -> 10.8250 (worse at every grid point; edges n 20, k 400)
#   AST  7.2185 ->  7.9104 (worse at every grid point; edges n 20, k 400)
#   STL  2.3900 ->  2.5345 (worse at every grid point; edge n 20)
#   BLK  1.9378 ->  1.9109 (edges n 5, k 400; the only target with points below the projection)
CHOSEN: dict[str, dict[str, int]] = {
    "REB": {"n": 20, "k": 400},
    "AST": {"n": 20, "k": 400},
    "STL": {"n": 20, "k": 100},
    "BLK": {"n": 5, "k": 400},
}


# ---- export ----------------------------------------------------------------------------------


def export(full_db: Path, league: str, seasons: list[str], out: Path) -> None:
    """Every regular-season game played in ``seasons``, by player and day: the box score's REB,
    AST, STL and BLK, and the tracking line's chances behind each (null when tracking has none),
    with each season's coverage. Public box-score and tracking facts only."""
    import duckdb

    if league != LEAGUE:
        msg = f"player tracking is NBA only; {league} has none (#1081)"
        raise SystemExit(msg)
    if LOCKED[league] in seasons:
        msg = f"{league} {LOCKED[league]} is locked: no study reads it (#1081)"
        raise SystemExit(msg)
    out.mkdir(parents=True, exist_ok=True)
    with duckdb.connect(str(full_db), read_only=True) as con:
        con.execute(
            """
            create temp table s3 as
            select b.season, b.game_id, b.game_date, b.player_id,
                b.rebounds_total as reb, b.assists as ast, b.steals as stl, b.blocks as blk,
                t.rebound_chances, t.potential_assists, t.deflections, t.contested_shots,
                t.tracking_rebounds, t.tracking_assists, t.player_id is not null as tracked
            from gold.fct_player_game as b
            left join gold.fct_player_tracking as t
                on t.league = b.league and t.game_id = b.game_id and t.player_id = b.player_id
            where b.league = $league and b.season in (select unnest($seasons))
                and substr(b.game_id, 3, 1) = '2' and b.played
            """,
            {"league": league, "seasons": seasons},
        )
        games = con.execute(
            """
            select season, game_date, player_id, reb, ast, stl, blk, rebound_chances,
                potential_assists, deflections, contested_shots
            from s3 order by game_date, player_id
            """
        ).fetchdf()
        coverage = con.execute(
            """
            select season, count(*) as played, sum(tracked::int) as tracked,
                count(rebound_chances) as rebound_chances,
                count(potential_assists) as potential_assists,
                count(deflections) as deflections, count(contested_shots) as contested_shots,
                count(distinct game_id) as games,
                count(distinct case when tracked then game_id end) as games_tracked,
                sum(case when tracking_rebounds is not null then reb end) as box_reb,
                sum(tracking_rebounds) as tracking_reb,
                sum(case when tracking_assists is not null then ast end) as box_ast,
                sum(tracking_assists) as tracking_ast
            from s3 group by 1 order by 1
            """
        ).fetchdf()
    games.to_csv(out / "games.csv.gz", index=False)
    coverage.to_csv(out / "coverage.csv", index=False)
    meta = {"league": league, "seasons": sorted(seasons)}
    (out / "meta.json").write_text(json.dumps(meta) + "\n", encoding="utf-8")
    print(coverage.to_string(index=False))


def load_games(folder: Path) -> tuple[str, pd.DataFrame, pd.DataFrame]:
    meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
    games = pd.read_csv(folder / "games.csv.gz", dtype={"player_id": str, "season": str})
    games["game_date"] = pd.to_datetime(games["game_date"]).dt.date
    coverage = pd.read_csv(folder / "coverage.csv", dtype={"season": str})
    return str(meta["league"]), games, coverage


# ---- the inputs as of a Monday ---------------------------------------------------------------


@dataclass(frozen=True)
class Chances:
    """One category's tallies per player: long-run makes and chances, and over his last games the
    chances, the makes and the number of games."""

    long_made: np.ndarray  # [P]
    long_chances: np.ndarray  # [P]
    recent_chances: dict[int, np.ndarray]  # games -> [P]
    recent_made: dict[int, np.ndarray]  # games -> [P]
    recent_games: dict[int, np.ndarray]  # games -> [P]
    league_made: float
    league_chances: float


@dataclass(frozen=True)
class Inputs:
    ids: dict[str, int]
    by_category: dict[str, Chances]
    newest: date | None  # the latest game day read


def monday_inputs(games: pd.DataFrame, season: str, cut: date) -> Inputs:
    """The inputs as of ``cut``: games strictly before it, of ``season`` and the seasons before
    it in the long run."""
    s = games[games["season"].isin(seasons_back(season, LONG_RUN_SEASONS))]
    s = s[s["game_date"] < cut]
    players = sorted(s["player_id"].unique())
    ids = {p: i for i, p in enumerate(players)}
    out = {}
    for cat, (made_col, chance_col) in PAIRS.items():
        v = s[s[chance_col].notna()]
        row = v["player_id"].map(ids).to_numpy(dtype=int)
        made = v[made_col].to_numpy(dtype=float)
        chances = v[chance_col].to_numpy(dtype=float)
        # a player plays at most one game a day: his games, newest first
        rank = v.groupby("player_id")["game_date"].rank(method="first", ascending=False).to_numpy()

        def tally(values: np.ndarray, rows: np.ndarray = row) -> np.ndarray:
            t = np.zeros(len(players))
            np.add.at(t, rows, values)
            return t

        out[cat] = Chances(
            long_made=tally(made),
            long_chances=tally(chances),
            recent_chances={n: tally(chances * (rank <= n)) for n in RECENT_GAMES},
            recent_made={n: tally(made * (rank <= n)) for n in RECENT_GAMES},
            recent_games={n: tally((rank <= n).astype(float)) for n in RECENT_GAMES},
            league_made=float(made.sum()),
            league_chances=float(chances.sum()),
        )
    return Inputs(ids=ids, by_category=out, newest=max(s["game_date"]) if len(s) else None)


def _same(a: Inputs, b: Inputs) -> bool:
    if a.ids != b.ids or a.newest != b.newest:
        return False
    for cat in TARGETS:
        x, y = a.by_category[cat], b.by_category[cat]
        if not (
            np.array_equal(x.long_made, y.long_made)
            and np.array_equal(x.long_chances, y.long_chances)
            and x.league_made == y.league_made
            and x.league_chances == y.league_chances
            and all(
                np.array_equal(x.recent_chances[n], y.recent_chances[n])
                and np.array_equal(x.recent_made[n], y.recent_made[n])
                and np.array_equal(x.recent_games[n], y.recent_games[n])
                for n in RECENT_GAMES
            )
        ):
            return False
    return True


def forge(games: pd.DataFrame, start: date) -> pd.DataFrame:
    """Every game from ``start`` on rewritten: five times the chances plus three, every chance
    converted, and a game for every player on ``start`` itself."""
    later = games["game_date"] >= start
    forged = games.copy()
    for made_col, chance_col in PAIRS.values():
        forged.loc[later, chance_col] = forged.loc[later, chance_col].fillna(0) * 5 + 3
        forged.loc[later, made_col] = forged.loc[later, chance_col]
    extra = games.drop_duplicates(["season", "player_id"]).assign(game_date=start)
    for made_col, chance_col in PAIRS.values():
        extra[chance_col] = 9.0
        extra[made_col] = 9.0
    return pd.concat([forged, extra], ignore_index=True).drop_duplicates(
        ["season", "player_id", "game_date"], keep="first"
    )


def check_point_in_time(games: pd.DataFrame, season: str, cut: date) -> tuple[Inputs, bool]:
    """The inputs as of ``cut``, proved to see nothing from that day on: the same inputs come from
    the games with every later row deleted, and with every later row rewritten (``forge``). Raises
    if either differs or the newest game read is not before the day. Also the positive control:
    the same rewrite from the last game day before ``cut`` must change the inputs (False when
    there is no earlier game to rewrite)."""
    inp = monday_inputs(games, season, cut)
    later = games["game_date"] >= cut
    for other in (
        monday_inputs(games[~later], season, cut),
        monday_inputs(forge(games, cut), season, cut),
    ):
        if not _same(other, inp):
            msg = f"{season} {cut}: an input saw a game from that day or later"
            raise AssertionError(msg)
    if inp.newest is not None and inp.newest >= cut:
        msg = f"{season} {cut}: the newest game read is from {inp.newest}"
        raise AssertionError(msg)
    if inp.newest is None:
        return inp, False
    control = monday_inputs(forge(games, inp.newest), season, cut)
    if _same(control, inp):
        msg = f"{season} {cut}: the plant from {inp.newest} changed nothing; the check is blind"
        raise AssertionError(msg)
    return inp, True


# ---- the study's line --------------------------------------------------------------------------


def predict(
    inp: Inputs, ids: list[str], cat: str, n: int, k: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """For the players ``ids``, in ``cat``: the study's per-game line (recent chances per game times
    the shrunk long-run conversion), the recency control's (recent makes per game), and whether
    tracking had anything on him before the day."""
    zero = np.zeros(len(ids))
    if not inp.ids:
        return zero, zero.copy(), zero.astype(bool)
    c = inp.by_category[cat]
    rows = np.array([inp.ids.get(p, -1) for p in ids], dtype=int)
    found = rows >= 0
    safe = np.where(found, rows, 0)
    played = np.where(found, c.recent_games[n][safe], 0.0)
    has = found & (played > 0)
    league = c.league_made / c.league_chances if c.league_chances > 0 else 0.0
    made, chances = c.long_made[safe], c.long_chances[safe]
    denom = chances + k
    conv = np.divide(made + k * league, denom, out=np.full(len(ids), league), where=denom > 0)
    per = np.where(has, played, 1.0)
    rate = np.where(has, c.recent_chances[n][safe] / per * conv, 0.0)
    control = np.where(has, c.recent_made[n][safe] / per, 0.0)
    return rate, control, has


def study_lines(
    m: Monday, inp: Inputs, setting: dict[str, dict[str, int]], *, control: bool = False
) -> np.ndarray:
    """The per-game line [P, 4] in each target: the study's (or the recency control's) where
    tracking had a line for him, else the projection's."""
    out = np.zeros((len(m.ids), len(TARGETS)))
    for j, cat in enumerate(TARGETS):
        s = setting[cat]
        rate, recent, has = predict(inp, m.ids, cat, s["n"], s["k"])
        out[:, j] = np.where(has, recent if control else rate, m.line[:, COLUMN[cat]])
    return out


def study_week(
    m: Monday, inp: Inputs, setting: dict[str, dict[str, int]], *, control: bool = False
) -> np.ndarray:
    """The study's nine columns for a Monday: the projection-week's, with each target's per-game
    line (``study_lines``) times the games the projection-week counts."""
    out = m.base.proj.copy()
    lines = study_lines(m, inp, setting, control=control)
    for j, cat in enumerate(TARGETS):
        out[:, COLUMN[cat]] = lines[:, j] * m.games
    return out


# ---- the seasons ------------------------------------------------------------------------------


@dataclass
class Season:
    season: str
    mondays: list[Monday]
    inputs: list[Inputs]
    played: list[np.ndarray]  # [P] games each player really played that week
    controls: int  # Mondays where the positive control changed the inputs
    day_before: int  # of them, Mondays whose last earlier game was the Sunday


def week_monday(as_of: date) -> date:
    return as_of - timedelta(days=as_of.weekday())


def games_played(folder: Path, mondays: list[Monday]) -> list[np.ndarray]:
    """The games each population player really played in each week (S0's weeks.csv)."""
    weeks = pd.read_csv(folder / "weeks.csv", parse_dates=["week"], dtype={"player_id": str})
    weeks["week"] = weeks["week"].dt.date
    games = {(r.player_id, r.week): float(r.games) for r in weeks.itertuples(index=False)}
    return [np.array([games.get((p, week_monday(m.as_of)), 0.0) for p in m.ids]) for m in mondays]


def read_seasons(folders: list[Path], games: pd.DataFrame) -> list[Season]:
    out = []
    for folder in folders:
        league, season, mondays = load_weeks(folder)
        if league != LEAGUE:
            msg = f"{folder} is {league}: player tracking is NBA only (#1081)"
            raise SystemExit(msg)
        inputs, controls, day_before = [], 0, 0
        for m in mondays:
            monday = week_monday(m.as_of)
            inp, changed = check_point_in_time(games, season, monday)
            inputs.append(inp)
            controls += changed
            day_before += inp.newest == monday - timedelta(days=1)
        print(
            f"{league} {season}: {len(mondays)} Mondays, every input as of its Monday; the plant"
            f" from the last earlier game day changed the inputs on {controls}"
            f" ({day_before} of them the Sunday before)",
            flush=True,
        )
        out.append(
            Season(season, mondays, inputs, games_played(folder, mondays), controls, day_before)
        )
    return out


def coverage_of(seasons: list[Season]) -> dict[str, dict[str, float]]:
    """The share of each season's population player-weeks tracking had a line for, per target."""
    out: dict[str, dict[str, float]] = {}
    for s in seasons:
        out[s.season] = {}
        for cat in TARGETS:
            has = [
                predict(inp, m.ids, cat, RECENT_GAMES[0], 0)[2]
                for m, inp in zip(s.mondays, s.inputs, strict=True)
            ]
            out[s.season][cat] = float(np.concatenate(has).mean()) if has else 0.0
    return out


def days_match(seasons: list[Season], games: pd.DataFrame) -> dict[str, Any]:
    """The export's box scores summed Monday to Sunday against S0's real week, for the population's
    player-weeks with a game: how many agree in all four targets."""
    agree = total = 0
    for s in seasons:
        for m, played_games in zip(s.mondays, s.played, strict=True):
            monday = week_monday(m.as_of)
            week = games[
                (games["game_date"] >= monday) & (games["game_date"] < monday + timedelta(days=7))
            ]
            sums = week.groupby("player_id")[[PAIRS[c][0] for c in TARGETS]].sum()
            mine = sums.reindex(m.ids).fillna(0).to_numpy()
            real = m.real[:, [REAL[c] for c in TARGETS]]
            played = played_games > 0
            agree += int((np.abs(mine - real).max(axis=1)[played] < 1e-9).sum())
            total += int(played.sum())
    return {"player_weeks_with_a_game": total, "agree": agree}


# ---- fit on the tuning seasons ----------------------------------------------------------------


def grid() -> list[dict[str, int]]:
    return [{"n": n, "k": k} for n, k in itertools.product(RECENT_GAMES, SHRINK)]


def fit(seasons: list[Season]) -> dict[str, Any]:
    """Every grid point's pooled week RMSE in each target over the tuning Mondays, the
    projection's, and the point with the lowest in each (ties to the earlier point)."""
    base = np.concatenate([m.base.proj - m.base.real for s in seasons for m in s.mondays])
    proj_rmse = np.sqrt(np.mean(base**2, axis=0))
    rows: list[dict[str, float]] = []
    for point in grid():
        setting = {c: point for c in TARGETS}
        err = np.concatenate(
            [
                study_week(m, inp, setting) - m.base.real
                for s in seasons
                for m, inp in zip(s.mondays, s.inputs, strict=True)
            ]
        )
        rmse = np.sqrt(np.mean(err**2, axis=0))
        rows.append({**point, **{c: float(rmse[COLUMN[c]]) for c in TARGETS}})
    chosen = {}
    for c in TARGETS:
        # the first of the lowest: ties go to the earlier grid point
        best = rows[int(np.argmin([r[c] for r in rows]))]
        chosen[c] = {"n": int(best["n"]), "k": int(best["k"])}
    return {
        "seasons": [s.season for s in seasons],
        "player_weeks": len(base),
        "projection": {c: float(proj_rmse[COLUMN[c]]) for c in TARGETS},
        "grid": rows,
        "chosen": chosen,
    }


# ---- judge on the judged seasons ----------------------------------------------------------------


def seed_check(weeks: list[wy.Week], seeds: int = wy.SEEDS) -> dict[str, list[float]]:
    """The 95% interval's upper bound of study - projection in each target, over ``seeds`` seeds
    of the same bootstrap (ADR 0030's check)."""
    highs: dict[str, list[float]] = {c: [] for c in TARGETS}
    for seed in range(seeds):
        rng = np.random.default_rng(seed)
        diffs = []
        for _ in range(wy.RESAMPLES):
            bs, bp = wy._resample(weeks, rng)
            diffs.append(np.sqrt(np.mean(bs**2, axis=0)) - np.sqrt(np.mean(bp**2, axis=0)))
        hi = np.percentile(np.array(diffs), 97.5, axis=0)
        for c in TARGETS:
            highs[c].append(float(hi[COLUMN[c]]))
    return highs


def _compare(weeks: list[wy.Week]) -> dict[str, dict[str, float]]:
    """Per target: RMSE of the ``proj`` slot and the ``naive`` slot, and proj - naive with its 95%
    interval (seed 0)."""
    cats = wy.judge(weeks, seeds=1)
    return {
        c.category: {
            "rmse": c.rmse_projection,
            "rmse_baseline": c.rmse_naive,
            "diff": c.diff,
            "diff_low": c.diff_low,
            "diff_high": c.diff_high,
        }
        for c in cats
        if c.category in TARGETS
    }


def at_played(
    m: Monday, inp: Inputs, setting: dict[str, Any], played: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Both arms' nine columns with each target's per-game line times the games he really played
    (the other five as the projection-week has them)."""
    lines = study_lines(m, inp, setting)
    s, p = m.base.proj.copy(), m.base.proj.copy()
    for j, cat in enumerate(TARGETS):
        col = COLUMN[cat]
        s[:, col] = lines[:, j] * played
        p[:, col] = m.line[:, col] * played
    return s, p


def judge(
    tuning: list[wy.Week], judged: list[Season], setting: dict[str, Any], games: pd.DataFrame
) -> dict[str, Any]:
    """S0's bar from the tuning weeks (the noise, the bootstrap SD of the projection's RMSE, seed
    0), then the study against the projection on the judged weeks: the study in S0's ``proj`` slot
    and the projection in its ``naive`` slot, so each difference is study - projection."""
    s0 = wy.judge(tuning, seeds=1)
    pairs = [
        (m, inp, played)
        for s in judged
        for m, inp, played in zip(s.mondays, s.inputs, s.played, strict=True)
    ]
    studies = [study_week(m, inp, setting) for m, inp, _ in pairs]
    weeks = [
        wy.Week(as_of=m.as_of, proj=st, naive=m.base.proj, real=m.base.real)
        for (m, _, _), st in zip(pairs, studies, strict=True)
    ]
    cats = wy.judge(weeks, seeds=1)
    highs = seed_check(weeks)
    rows = []
    for c, base in zip(cats, s0, strict=True):
        target = c.category in TARGETS
        passed = c.diff <= -base.bar and c.diff_high < 0 if target else c.diff <= base.noise
        rows.append(
            {
                "category": c.category,
                "target": target,
                "rmse_study": c.rmse_projection,
                "rmse_projection": c.rmse_naive,
                "diff": c.diff,
                "diff_low": c.diff_low,
                "diff_high": c.diff_high,
                "s0_noise": base.noise,
                "bar": -base.bar if target else base.noise,
                "passes": bool(passed),
                **(
                    {
                        "seed_high_min": min(highs[c.category]),
                        "seed_high_max": max(highs[c.category]),
                        "seeds_below_zero": sum(h < 0 for h in highs[c.category]),
                    }
                    if target
                    else {}
                ),
            }
        )
    # reported only, not the bar
    control = _compare(
        [
            wy.Week(
                as_of=m.as_of,
                proj=study_week(m, inp, setting, control=True),
                naive=m.base.proj,
                real=m.base.real,
            )
            for m, inp, _ in pairs
        ]
    )
    study_vs_control = _compare(
        [
            wy.Week(
                as_of=m.as_of,
                proj=st,
                naive=study_week(m, inp, setting, control=True),
                real=m.base.real,
            )
            for (m, inp, _), st in zip(pairs, studies, strict=True)
        ]
    )
    played_weeks = []
    for m, inp, played in pairs:
        s, p = at_played(m, inp, setting, played)
        played_weeks.append(wy.Week(as_of=m.as_of, proj=s, naive=p, real=m.base.real))
    counted = float(np.concatenate([m.games for m, _, _ in pairs]).mean()) if pairs else 0.0
    really = float(np.concatenate([p for _, _, p in pairs]).mean()) if pairs else 0.0
    mean_line = {
        c: {
            "study_week": float(np.mean(np.concatenate([st[:, COLUMN[c]] for st in studies]))),
            "projection_week": float(
                np.mean(np.concatenate([m.base.proj[:, COLUMN[c]] for m, _, _ in pairs]))
            ),
            "real_week": float(
                np.mean(np.concatenate([m.base.real[:, COLUMN[c]] for m, _, _ in pairs]))
            ),
        }
        for c in TARGETS
    }
    return {
        "judged": [s.season for s in judged],
        "weeks": len(weeks),
        "weeks_with_players": sum(len(w.real) > 0 for w in weeks),
        "player_weeks": int(sum(len(w.real) for w in weeks)),
        "setting": setting,
        "categories": rows,
        "passes": all(r["passes"] for r in rows),
        "reported_only": {
            "recency_control_minus_projection": control,
            "study_minus_recency_control": study_vs_control,
            "at_games_played_study_minus_projection": _compare(played_weeks),
            "games_counted_per_player_week": counted,
            "games_played_per_player_week": really,
            "mean_week": mean_line,
            "tracking_coverage": coverage_of(judged),
            "days_match": days_match(judged, games),
            "leak_check": {
                s.season: {
                    "mondays": len(s.mondays),
                    "control_changed": s.controls,
                    "sunday_before": s.day_before,
                }
                for s in judged
            },
        },
    }


def report(res: dict[str, Any]) -> str:
    head = (
        f"### NBA, judged {', '.join(res['judged'])}: {res['weeks']} weeks "
        f"({res['weeks_with_players']} with players), {res['player_weeks']} player-weeks; "
        f"{'PASS' if res['passes'] else 'FAIL'}\n\n"
    )
    rows = [
        "| Category | RMSE study | RMSE projection | Study - projection (95%) | S0 noise | Bar "
        "| Passes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in res["categories"]:
        bar = f"<= {r['bar']:+.4f}, interval below 0" if r["target"] else f"<= +{r['bar']:.4f}"
        rows.append(
            f"| {r['category']}{' (target)' if r['target'] else ''} | {r['rmse_study']:.4f} "
            f"| {r['rmse_projection']:.4f} "
            f"| {r['diff']:+.4f} ({r['diff_low']:+.4f} to {r['diff_high']:+.4f}) "
            f"| {r['s0_noise']:.4f} | {bar} | {'yes' if r['passes'] else 'no'} |"
        )
    return head + "\n".join(rows) + "\n"


# ---- command line ------------------------------------------------------------------------------


def _check_folders(folders: list[Path], allowed: set[str], what: str) -> None:
    """Refuse a season before reading any of its numbers: only its meta.json is opened."""
    for f in folders:
        meta = json.loads((f / "meta.json").read_text(encoding="utf-8"))
        league, season = meta["league"], meta["season"]
        if league != LEAGUE:
            msg = f"{league} has no player tracking: S3 is NBA only (#1081)"
            raise SystemExit(msg)
        if season == LOCKED[league]:
            msg = f"{league} {season} is locked: no study reads it (#1081)"
            raise SystemExit(msg)
        if season not in allowed:
            msg = f"{league} {season} is not a {what} season ({sorted(allowed)})"
            raise SystemExit(msg)


def _read_chances(
    folders: list[Path], allowed: set[str]
) -> tuple[pd.DataFrame, list[dict[str, Any]]]:
    """The chances folders, refused if any holds a season the step may not read."""
    frames, coverage = [], []
    for folder in folders:
        meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
        if meta["league"] != LEAGUE:
            msg = f"{folder} is {meta['league']}: S3 is NBA only (#1081)"
            raise SystemExit(msg)
        extra = set(meta["seasons"]) - allowed
        if extra:
            msg = f"{folder} holds {sorted(extra)}, which this step may not read (#1081)"
            raise SystemExit(msg)
        _, g, cov = load_games(folder)
        frames.append(g)
        coverage.extend(cov.to_dict(orient="records"))
    games = pd.concat(frames, ignore_index=True).drop_duplicates(
        ["season", "player_id", "game_date"]
    )
    return games, coverage


def _history(seasons: set[str]) -> set[str]:
    return {b for s in seasons for b in seasons_back(s, LONG_RUN_SEASONS)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ops.s3_opportunity")
    sub = parser.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export", help="every regular-season game played, with its chances")
    e.add_argument("--league", required=True, choices=sorted(LOCKED))
    e.add_argument("--seasons", nargs="+", required=True)
    e.add_argument("--full-db", type=Path, required=True)
    e.add_argument("--out", type=Path, required=True)
    f = sub.add_parser("fit", help="the grid on the tuning seasons")
    f.add_argument("folders", nargs="+", type=Path)
    f.add_argument("--chances", type=Path, nargs="+", required=True)
    f.add_argument("--out", type=Path, required=True)
    j = sub.add_parser("judge", help="the chosen setting on the judged seasons, once")
    j.add_argument("--chances", type=Path, nargs="+", required=True)
    j.add_argument("--tuning", type=Path, nargs="+", required=True, help="S0's tuning exports")
    j.add_argument("--judged", type=Path, nargs="+", required=True)
    j.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.cmd == "export":
        export(args.full_db, args.league, args.seasons, args.out)
        return 0
    if args.cmd == "fit":
        _check_folders(args.folders, TUNING[LEAGUE], "tuning")
        games, coverage = _read_chances(args.chances, _history(TUNING[LEAGUE]))
        seasons = read_seasons(args.folders, games)
        res = {
            "league": LEAGUE,
            **fit(seasons),
            "tracking_coverage": coverage_of(seasons),
            "coverage": coverage,
            "leak_check": {
                s.season: {
                    "mondays": len(s.mondays),
                    "control_changed": s.controls,
                    "sunday_before": s.day_before,
                }
                for s in seasons
            },
        }
        args.out.write_text(json.dumps(res, indent=1) + "\n", encoding="utf-8")
        print(pd.DataFrame(coverage).to_string(index=False))
        print(
            json.dumps({k: res[k] for k in ("projection", "chosen", "tracking_coverage")}, indent=1)
        )
        return 0
    if not CHOSEN:
        print(
            "no setting chosen yet: fit on the tuning seasons and commit CHOSEN first",
            file=sys.stderr,
        )
        return 2
    _check_folders(args.tuning, TUNING[LEAGUE], "tuning")
    _check_folders(args.judged, JUDGED[LEAGUE], "judged")
    games, coverage = _read_chances(args.chances, _history(JUDGED[LEAGUE]))
    tuning = [w for f in args.tuning for w in wy.load(f)[2]]
    judged = read_seasons(args.judged, games)
    res = judge(tuning, judged, CHOSEN, games)
    res["tuning"] = [json.loads((f / "meta.json").read_text())["season"] for f in args.tuning]
    res["coverage"] = coverage
    args.out.write_text(json.dumps(res, indent=1) + "\n", encoding="utf-8")
    print(report(res))
    print(json.dumps(res["reported_only"], indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
