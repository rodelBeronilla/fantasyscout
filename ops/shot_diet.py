"""S4 (#1082): shot diet before shooting luck, for FG% and 3PM.

    uv run python -m ops.shot_diet export --league nba --full-db dbt/fantasyscout.duckdb --out d/
    uv run python -m ops.shot_diet fit --shots d/ closeness-nba-2020-21/ ... --out fit.json
    uv run python -m ops.shot_diet judge --shots d1/ d2/ --tuning closeness-nba-2020-21/ ...
        --judged closeness-nba-2023-24/ closeness-nba-2024-25/ --out s4.json

The hypothesis, declared on #1082 before any run: a hot or cold fortnight of shooting is mostly
luck; where a player shoots from, and how well he has shot from there over years, predicts next
week's FG% (by attempts) and threes made better than the projection does now.

The study's week, for each player of S0's population (ops.week_yardstick) on each Monday:

- **FG%:** the sum over zones of his recent share of attempts from the zone times his long-run
  accuracy from it, shrunk toward the league's accuracy from that zone by ``k`` attempts. Scored as
  S0 scores it: that rate at the week's real attempts, the error in makes.
- **3PM:** the projection's attempts per game times the same sum over the three-point zones alone,
  times the games the projection-week counts (none for a player listed out or doubtful).
- **The other seven categories** are the projection-week's, unchanged.
- A player with no shot in the window before the Monday keeps the projection's line.

Every input is as of the Monday: only shots from games before that day (``monday_inputs``), from
that season and the two before (``LONG_RUN_SEASONS``). ``check_point_in_time`` proves it on every
Monday of every run: deleting or rewriting every later shot changes no input.

The settings, chosen per league and per category on the tuning seasons only by pooled RMSE
(``fit``), from the short grid below. ``CHOSEN`` holds the choice; it is committed before the
judged seasons are read. ``judge`` then scores it once on the judged seasons with S0's harness and
S0's bar, per league, and refuses the locked season.
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

import duckdb
import numpy as np
import pandas as pd

from ops import week_yardstick as wy
from ops.closeness_backtest import LISTED_OUT, NAIVE
from ops.matchup import LINE
from ops.standings import CATS
from ops.standings_backtest import JUDGED, STATS, TUNING
from ops.walk_forward import LOCKED

# the shot chart's basic zones; an unnamed zone counts as above the break when it was a three and
# as mid-range when it was not
ZONES = (
    "Restricted Area",
    "In The Paint (Non-RA)",
    "Mid-Range",
    "Left Corner 3",
    "Right Corner 3",
    "Above the Break 3",
    "Backcourt",
)
THREE_ZONES = np.array([False, False, False, True, True, True, True])
# def: the zone schemes tried, each a map from the basic zones (no scheme mixes twos and threes)
SCHEMES: dict[str, tuple[int, ...]] = {
    # two-pointers, threes
    "two": (0, 0, 0, 1, 1, 1, 1),
    # at the rim, other twos, threes
    "three": (0, 1, 1, 2, 2, 2, 2),
    # at the rim, the rest of the paint, mid-range, corner threes, threes above the break
    # (heaves from the backcourt with them)
    "five": (0, 1, 2, 3, 3, 4, 4),
}
# def: attempts at the league's accuracy from a zone added to a player's own from it
SHRINK = (25, 50, 100, 200, 400)
# def: the recent diet is the share of attempts by zone over a player's last this many games
RECENT_GAMES = (10, 20)
# def: the long run is the season so far and the two before (the seasons a backtest mirrors)
LONG_RUN_SEASONS = 3
TARGETS = ("FG%", "3PM")
FG = wy.CATEGORIES.index("FG%")
THREES = wy.CATEGORIES.index("3PM")
# the columns of a per-game line (ops.matchup.LINE) the study reads
FGM_PG, FGA_PG, THREES_PG = 7, 8, 5
# STATS' columns for the week's real field goals
REAL_FGA = STATS.index("field_goals_attempted")

# Chosen on the tuning seasons by ``fit`` and committed before any judged season was read (``judge``
# refuses to run without it). The fit read S0's exports (runs 44942094895, 44942100340, 44942105040,
# 44942110202, 44942115669, 44942120406) and the shots of runs 44943358268 and 44949158118. Pooled
# tuning RMSE, the projection's then the study's at its point:
#   NBA   FG% 2.9491 -> 2.9329;  3PM 3.7538 -> 3.7499 (at the grid's edge, k 400)
#   WNBA  FG% 1.8354 -> 1.8164;  3PM 1.7326 -> 1.8076 (worse at every grid point; edge, k 400)
CHOSEN: dict[str, dict[str, dict[str, Any]]] = {
    "nba": {
        "FG%": {"scheme": "two", "k": 100, "games": 20},
        "3PM": {"scheme": "five", "k": 400, "games": 20},
    },
    "wnba": {
        "FG%": {"scheme": "two", "k": 100, "games": 20},
        "3PM": {"scheme": "two", "k": 400, "games": 20},
    },
}


# ---- export ----------------------------------------------------------------------------------


def export(full_db: Path, league: str, out: Path) -> None:
    """Every regular-season shot in the build, by season, player, day and zone, and each season's
    coverage: the shots' field-goal attempts against the box scores'."""
    out.mkdir(parents=True, exist_ok=True)
    with duckdb.connect(str(full_db), read_only=True) as con:
        shots = con.execute(
            """
            select season, player_id, game_date, coalesce(shot_zone_basic, '') as zone, is_three,
                count(*) as fga, sum(shot_made::int) as fgm
            from gold.fct_shot
            where league = $league and substr(game_id, 3, 1) = '2' and player_id is not null
            group by all
            order by season, game_date, player_id, zone
            """,
            {"league": league},
        ).fetchdf()
        coverage = con.execute(
            """
            with shot as (
                select season, count(*) as shot_fga, count(distinct game_id) as shot_games
                from gold.fct_shot
                where league = $league and substr(game_id, 3, 1) = '2'
                group by 1
            ),
            box as (
                select season, sum(field_goals_attempted) as box_fga,
                    count(distinct game_id) as box_games
                from gold.fct_player_game
                where league = $league and substr(game_id, 3, 1) = '2' and played
                group by 1
            )
            select coalesce(b.season, s.season) as season, b.box_games, s.shot_games, b.box_fga,
                s.shot_fga
            from box as b full join shot as s on s.season = b.season
            order by 1
            """,
            {"league": league},
        ).fetchdf()
    shots.to_csv(out / "shots.csv.gz", index=False)
    coverage.to_csv(out / "coverage.csv", index=False)
    meta = {"league": league, "seasons": sorted(shots["season"].unique().tolist())}
    (out / "meta.json").write_text(json.dumps(meta) + "\n", encoding="utf-8")
    print(coverage.to_string(index=False))


def load_shots(folder: Path) -> tuple[str, pd.DataFrame, pd.DataFrame]:
    meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
    shots = pd.read_csv(
        folder / "shots.csv.gz", dtype={"player_id": str, "season": str, "zone": str}
    )
    shots["game_date"] = pd.to_datetime(shots["game_date"]).dt.date
    shots["zone"] = shots["zone"].fillna("")
    zone = shots["zone"].map({z: i for i, z in enumerate(ZONES)})
    fallback = np.where(shots["is_three"].astype(bool), ZONES.index("Above the Break 3"), 2)
    shots["z"] = zone.fillna(pd.Series(fallback, index=shots.index)).astype(int)
    coverage = pd.read_csv(folder / "coverage.csv", dtype={"season": str})
    return str(meta["league"]), shots, coverage


# ---- the inputs as of a Monday ---------------------------------------------------------------


def seasons_back(season: str, n: int = LONG_RUN_SEASONS) -> list[str]:
    """The season and the ``n - 1`` before it, newest first: 2023-24 -> 2023-24, 2022-23, ..."""
    start = int(season[:4])
    if "-" in season:
        return [f"{y}-{(y + 1) % 100:02d}" for y in range(start, start - n, -1)]
    return [str(y) for y in range(start, start - n, -1)]


@dataclass(frozen=True)
class Inputs:
    """What the shots before a day say: per player, his long-run makes and attempts by basic zone
    and his attempts by zone over his last games; the league's makes and attempts by zone."""

    ids: dict[str, int]
    made: np.ndarray  # [P, 7]
    att: np.ndarray  # [P, 7]
    recent: dict[int, np.ndarray]  # games -> [P, 7] attempts over the player's last that many
    league_made: np.ndarray  # [7]
    league_att: np.ndarray  # [7]
    newest: date | None  # the latest game day read


def monday_inputs(shots: pd.DataFrame, season: str, as_of: date) -> Inputs:
    """The inputs as of ``as_of``: shots from games strictly before it, of ``season`` and the
    seasons before it in the long run."""
    s = shots[shots["season"].isin(seasons_back(season)) & (shots["game_date"] < as_of)]
    players = sorted(s["player_id"].unique())
    ids = {p: i for i, p in enumerate(players)}
    row = s["player_id"].map(ids).to_numpy()
    z = s["z"].to_numpy()

    def tally(values: np.ndarray, rows: np.ndarray, zones: np.ndarray) -> np.ndarray:
        out = np.zeros((len(players), len(ZONES)))
        np.add.at(out, (rows, zones), values)
        return out

    fga = s["fga"].to_numpy(dtype=float)
    fgm = s["fgm"].to_numpy(dtype=float)
    made, att = tally(fgm, row, z), tally(fga, row, z)
    days = s[["player_id", "game_date"]].drop_duplicates()
    rank = days.groupby("player_id")["game_date"].rank(method="first", ascending=False)
    days = days.assign(rank=rank.to_numpy())
    rank_of = s.merge(days, on=["player_id", "game_date"], how="left")["rank"].to_numpy()
    recent = {g: tally(fga * (rank_of <= g), row, z) for g in RECENT_GAMES}
    return Inputs(
        ids=ids,
        made=made,
        att=att,
        recent=recent,
        league_made=made.sum(axis=0),
        league_att=att.sum(axis=0),
        newest=max(s["game_date"]) if len(s) else None,
    )


def check_point_in_time(shots: pd.DataFrame, season: str, as_of: date) -> Inputs:
    """The inputs as of ``as_of``, proved to see nothing from that day on: the same inputs come
    from the shots with every later row deleted, and with every later row rewritten (each attempt
    made, attempts tripled). Raises if any differs or the newest shot read is not before the day."""
    inp = monday_inputs(shots, season, as_of)
    later = shots["game_date"] >= as_of
    cut = monday_inputs(shots[~later], season, as_of)
    forged = shots.copy()
    forged.loc[later, "fga"] = forged.loc[later, "fga"] * 3
    forged.loc[later, "fgm"] = forged.loc[later, "fga"]
    forged_inp = monday_inputs(forged, season, as_of)
    for other in (cut, forged_inp):
        same = (
            other.ids == inp.ids
            and np.array_equal(other.made, inp.made)
            and np.array_equal(other.att, inp.att)
            and all(np.array_equal(other.recent[g], inp.recent[g]) for g in RECENT_GAMES)
            and other.newest == inp.newest
        )
        if not same:
            msg = f"{season} {as_of}: an input saw a shot from that day or later"
            raise AssertionError(msg)
    if inp.newest is not None and inp.newest >= as_of:
        msg = f"{season} {as_of}: the newest shot read is from {inp.newest}"
        raise AssertionError(msg)
    return inp


# ---- the study's line --------------------------------------------------------------------------


def predict(
    inp: Inputs, ids: list[str], line: np.ndarray, scheme: str, k: float, games: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """For the players ``ids`` with projected per-game lines ``line`` [P, 11]: the study's FG rate
    and threes per game, and whether the shots had anything on him (else the projection's own)."""
    m = np.zeros((len(ZONES), max(SCHEMES[scheme]) + 1))
    m[np.arange(len(ZONES)), SCHEMES[scheme]] = 1.0
    three = (THREE_ZONES.astype(float) @ m) > 0
    rows = np.array([inp.ids.get(p, -1) for p in ids], dtype=int)
    found = rows >= 0
    safe = np.where(found, rows, 0)
    made, att = inp.made[safe] @ m, inp.att[safe] @ m
    recent = inp.recent[games][safe] @ m
    league = np.divide(
        inp.league_made @ m,
        inp.league_att @ m,
        out=np.zeros(m.shape[1]),
        where=inp.league_att @ m > 0,
    )
    acc = (made + k * league) / (att + k)
    total = recent.sum(axis=1)
    has = found & (total > 0)
    share = np.divide(recent, total[:, None], out=np.zeros_like(recent), where=has[:, None])
    proj_rate = np.divide(
        line[:, FGM_PG], line[:, FGA_PG], out=np.zeros(len(line)), where=line[:, FGA_PG] > 0
    )
    fg_rate = np.where(has, (share * acc).sum(axis=1), proj_rate)
    threes = np.where(
        has, line[:, FGA_PG] * (share * acc)[:, three].sum(axis=1), line[:, THREES_PG]
    )
    return fg_rate, threes, has


# ---- S0's weeks, with each player's id ----------------------------------------------------------


@dataclass(frozen=True)
class Monday:
    as_of: date
    ids: list[str]
    line: np.ndarray  # [P, 11] the projected per-game line
    games: np.ndarray  # [P] the games the projection-week counts
    real: np.ndarray  # [P, 11] the real week, STATS order
    base: wy.Week  # the projection-week (proj) and S0's real week, as S0 scores them


def load_weeks(folder: Path) -> tuple[str, str, list[Monday]]:
    """S0's population and projection-week from a weekly export folder, as ops.week_yardstick
    reads it, keeping each player's id. Fails unless it agrees with ``week_yardstick.load``."""
    meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
    weeks_df = pd.read_csv(folder / "weeks.csv", parse_dates=["week"], dtype={"player_id": str})
    weeks_df["week"] = weeks_df["week"].dt.date
    out = []
    for text in meta["weeks"]:
        as_of = date.fromisoformat(text)
        monday = as_of - timedelta(days=as_of.weekday())
        df = pd.read_csv(folder / f"players-{text}.csv", dtype={"player_id": str})
        idx = {pid: i for i, pid in enumerate(df["player_id"])}
        x = np.zeros((len(df), len(STATS)))
        rows = weeks_df[(weeks_df["week"] == monday) & weeks_df["player_id"].isin(idx.keys())]
        for r in rows.itertuples(index=False):
            x[idx[r.player_id]] = [getattr(r, s) for s in STATS]
        scheduled = df["games_this_week"].astype(float).fillna(0).to_numpy()
        listed = df["injury_group"].isin(LISTED_OUT).to_numpy()
        value = df[list(CATS)].astype(float).fillna(0).to_numpy().sum(axis=1)
        keep = wy.population(value, scheduled)
        line = df[list(LINE)].astype(float).fillna(0).to_numpy()[keep]
        naive = df[list(NAIVE)].astype(float).fillna(0).to_numpy()[keep]
        games = np.where(listed[keep], 0.0, scheduled[keep])
        real = x[keep]
        base = wy.Week(
            as_of=as_of,
            proj=wy.category_weeks(line, games, real),
            naive=wy.category_weeks(naive, scheduled[keep], real),
            real=wy.real_weeks(real),
        )
        ids = df["player_id"].to_numpy()[keep].tolist()
        out.append(Monday(as_of, ids, line, games, real, base))
    league, season, s0 = wy.load(folder)
    for mine, theirs in zip(out, s0, strict=True):
        if not (
            mine.as_of == theirs.as_of
            and np.array_equal(mine.base.proj, theirs.proj)
            and np.array_equal(mine.base.naive, theirs.naive)
            and np.array_equal(mine.base.real, theirs.real)
        ):
            msg = f"{folder}: {mine.as_of} differs from ops.week_yardstick's reading"
            raise AssertionError(msg)
    return league, season, out


def study_week(m: Monday, inp: Inputs, setting: dict[str, dict[str, Any]]) -> np.ndarray:
    """The study's nine columns for a Monday: the projection-week's, with FG% and 3PM replaced by
    the study's at the settings chosen for each."""
    out = m.base.proj.copy()
    s = setting["FG%"]
    fg_rate, _, _ = predict(inp, m.ids, m.line, s["scheme"], s["k"], s["games"])
    out[:, FG] = fg_rate * m.real[:, REAL_FGA]
    s = setting["3PM"]
    _, threes, _ = predict(inp, m.ids, m.line, s["scheme"], s["k"], s["games"])
    out[:, THREES] = threes * m.games
    return out


@dataclass
class Season:
    league: str
    season: str
    mondays: list[Monday]
    inputs: list[Inputs]


def read_seasons(folders: list[Path], shots: pd.DataFrame, shots_league: str) -> list[Season]:
    out = []
    for folder in folders:
        league, season, mondays = load_weeks(folder)
        if league != shots_league:
            msg = f"{folder} is {league}; the shots are {shots_league}"
            raise SystemExit(msg)
        inputs = [check_point_in_time(shots, season, m.as_of) for m in mondays]
        print(f"{league} {season}: {len(mondays)} Mondays, every input as of its day", flush=True)
        out.append(Season(league, season, mondays, inputs))
    return out


def coverage_of(seasons: list[Season]) -> dict[str, float]:
    """The share of each season's population player-weeks the shots had anything on."""
    out = {}
    for s in seasons:
        has = [
            predict(inp, m.ids, m.line, "two", 100, RECENT_GAMES[0])[2]
            for m, inp in zip(s.mondays, s.inputs, strict=True)
        ]
        out[s.season] = float(np.concatenate(has).mean())
    return out


# ---- fit on the tuning seasons ----------------------------------------------------------------


def grid() -> list[dict[str, Any]]:
    return [
        {"scheme": sc, "k": k, "games": g}
        for sc, k, g in itertools.product(SCHEMES, SHRINK, RECENT_GAMES)
    ]


def fit(seasons: list[Season]) -> dict[str, Any]:
    """Every grid point's pooled RMSE in FG% and 3PM over the tuning Mondays, the projection's, and
    the point with the lowest in each."""
    base = np.concatenate([m.base.proj - m.base.real for s in seasons for m in s.mondays])
    proj_rmse = np.sqrt(np.mean(base**2, axis=0))
    rows = []
    for point in grid():
        setting = {"FG%": point, "3PM": point}
        err = np.concatenate(
            [
                study_week(m, inp, setting) - m.base.real
                for s in seasons
                for m, inp in zip(s.mondays, s.inputs, strict=True)
            ]
        )
        rmse = np.sqrt(np.mean(err**2, axis=0))
        rows.append({**point, "FG%": float(rmse[FG]), "3PM": float(rmse[THREES])})
    chosen = {
        c: {k: v for k, v in min(rows, key=lambda r: r[c]).items() if k in ("scheme", "k", "games")}
        for c in TARGETS
    }
    return {
        "seasons": [s.season for s in seasons],
        "player_weeks": len(base),
        "projection": {"FG%": float(proj_rmse[FG]), "3PM": float(proj_rmse[THREES])},
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
            highs[c].append(float(hi[wy.CATEGORIES.index(c)]))
    return highs


def judge(tuning: list[wy.Week], judged: list[Season], setting: dict[str, Any]) -> dict[str, Any]:
    """S0's bar from the tuning weeks (the noise, the bootstrap SD of the projection's RMSE, seed
    0), then the study against the projection on the judged weeks: the study in S0's ``proj`` slot
    and the projection in its ``naive`` slot, so each difference is study - projection."""
    s0 = wy.judge(tuning, seeds=1)
    weeks = [
        wy.Week(
            as_of=m.as_of, proj=study_week(m, inp, setting), naive=m.base.proj, real=m.base.real
        )
        for s in judged
        for m, inp in zip(s.mondays, s.inputs, strict=True)
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
    return {
        "judged": [s.season for s in judged],
        "weeks": len(weeks),
        "player_weeks": int(sum(len(w.real) for w in weeks)),
        "setting": setting,
        "shot_coverage": coverage_of(judged),
        "categories": rows,
        "passes": all(r["passes"] for r in rows),
    }


def report(league: str, res: dict[str, Any]) -> str:
    head = (
        f"### {league.upper()}, judged {', '.join(res['judged'])}: {res['weeks']} weeks, "
        f"{res['player_weeks']} player-weeks; {'PASS' if res['passes'] else 'FAIL'}\n\n"
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
        if season == LOCKED[league]:
            msg = f"{league} {season} is locked: no study reads it (#1082)"
            raise SystemExit(msg)
        if season not in allowed:
            msg = f"{league} {season} is not a {what} season ({sorted(allowed)})"
            raise SystemExit(msg)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ops.shot_diet")
    sub = parser.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export", help="every regular-season shot by player, day and zone")
    e.add_argument("--league", required=True, choices=sorted(LOCKED))
    e.add_argument("--full-db", type=Path, required=True)
    e.add_argument("--out", type=Path, required=True)
    f = sub.add_parser("fit", help="the grid on the tuning seasons, one league at a time")
    f.add_argument("folders", nargs="+", type=Path)
    f.add_argument("--shots", type=Path, required=True)
    f.add_argument("--out", type=Path, required=True)
    j = sub.add_parser("judge", help="the chosen setting on the judged seasons, once")
    j.add_argument("--shots", type=Path, nargs="+", required=True)
    j.add_argument("--tuning", type=Path, nargs="+", required=True, help="S0's tuning exports")
    j.add_argument("--judged", type=Path, nargs="+", required=True)
    j.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.cmd == "export":
        export(args.full_db, args.league, args.out)
        return 0
    if args.cmd == "fit":
        league, shots, coverage = load_shots(args.shots)
        _check_folders(args.folders, TUNING[league], "tuning")
        seasons = read_seasons(args.folders, shots, league)
        res = {"league": league, **fit(seasons), "shot_coverage": coverage_of(seasons)}
        res["coverage"] = coverage.to_dict(orient="records")
        args.out.write_text(json.dumps(res, indent=1) + "\n", encoding="utf-8")
        print(coverage.to_string(index=False))
        print(json.dumps({k: res[k] for k in ("projection", "chosen", "shot_coverage")}, indent=1))
        return 0
    if not CHOSEN:
        print(
            "no setting chosen yet: fit on the tuning seasons and commit CHOSEN first",
            file=sys.stderr,
        )
        return 2
    by_league: dict[str, list[tuple[pd.DataFrame, pd.DataFrame]]] = {}
    for folder in args.shots:
        league, shots, coverage = load_shots(folder)
        by_league.setdefault(league, []).append((shots, coverage))
    results: dict[str, Any] = {}
    text = []
    for league in sorted(by_league):
        tuning_folders = [
            p for p in args.tuning if json.loads((p / "meta.json").read_text())["league"] == league
        ]
        judged_folders = [
            p for p in args.judged if json.loads((p / "meta.json").read_text())["league"] == league
        ]
        _check_folders(tuning_folders, TUNING[league], "tuning")
        _check_folders(judged_folders, JUDGED[league], "judged")
        shots = pd.concat([s for s, _ in by_league[league]]).drop_duplicates(
            ["season", "player_id", "game_date", "zone", "is_three"]
        )
        tuning = [w for f in tuning_folders for w in wy.load(f)[2]]
        judged = read_seasons(judged_folders, shots, league)
        res = judge(tuning, judged, CHOSEN[league])
        res["tuning"] = [
            json.loads((f / "meta.json").read_text())["season"] for f in tuning_folders
        ]
        res["coverage"] = [
            row for _, cov in by_league[league] for row in cov.to_dict(orient="records")
        ]
        results[league] = res
        text.append(report(league, res))
    args.out.write_text(json.dumps(results, indent=1) + "\n", encoding="utf-8")
    print("\n".join(text))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
