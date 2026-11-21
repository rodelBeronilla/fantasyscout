"""S1 (#1079): the games a player actually plays in the week.

    uv run python -m ops.s1_games_played export --league nba --seasons 2021-22 2022-23 2023-24 \
        --full-db dbt/fantasyscout.duckdb --out s1-games/
    uv run python -m ops.s1_games_played check closeness-nba-2020-21/ ... --games s1-games/
    uv run python -m ops.s1_games_played fit closeness-nba-2020-21/ ... --games s1-games/
    uv run python -m ops.s1_games_played judge closeness-nba-2023-24/ ... --games s1-games/ \
        --s0 s0.json --out s1.json

The hypothesis, declared on #1079 before any run: the games a player plays in the week can be
predicted better than the projection-week counts them (the team's games, none when he is listed
out or doubtful) from the Monday's injury listing and his own history of sitting the second night
of a back-to-back. The harness is S0's (#1077, ops.week_yardstick): the same weekly point-in-time
exports, the same population (the top 130 on the board among players with a game), the same
scoring, the projection-week as the baseline.

Two readings, recorded on #1079 before any judged season was read:

- the injury listing has no history to fit on (gold.fct_injury_status starts in late October
  2026, the official listing in NBA 2023-24), so the study keeps the projection's listing rule
  as it is and fits only the rest pattern;
- FG% and FT% are scored at the real attempts, so games cannot move them: the improvement bar
  applies to the seven counting categories, and all nine are held to "no worse than the noise".

The rest pattern, as of the Monday (or the season's first game day), nothing from that day on:

- a back-to-back pair is a night his team played followed by another the next day; it counts
  when he played the first night, and he *sat* it when he did not play the second. Regular-season
  games, both nights before the Monday, this season and the ``HISTORY`` seasons before it;
- his share sat: each pair weighted ``decay`` to the power of the seasons back, shrunk toward the
  Monday's population's pooled share by ``k`` pairs;
- his week: each of his team's games from the Monday to Sunday counts 1, a second night counts
  1 - share; a player listed out or doubtful counts none. Where his team (that of his latest game
  before the Monday) does not give the board's games this week, the board's count stands.

``k`` and ``decay`` are chosen per league on the tuning seasons only (``fit``: the lowest RMSE of
games played over the tuning weeks, ties to the earlier grid point) and frozen in ``FROZEN``
before ``judge`` reads a judged season. ``judge`` refuses every other season.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from ops import week_yardstick as wy
from ops.closeness_backtest import LISTED_OUT
from ops.matchup import LINE
from ops.standings import CATS
from ops.standings_backtest import JUDGED, STATS, TUNING
from ops.walk_forward import LOCKED

# def: the seasons before this one a player's rest pattern reads: the two a judged season's
# build mirrors (#1079)
HISTORY = 2
# def: the grid the fit chooses from, declared before any run (#1079); k = inf is the population's
# share for everyone
KS = (0.0, 1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0, float("inf"))
DECAYS = (1.0, 0.5, 0.25)
# the games the board counts in a week (mart_board's games_this_week): a back-to-back's first
# night may be any of them
GAME_TYPES = ("regular", "play_in", "playoffs")
# the seven counting categories games played can move; FG% and FT% are scored at the real attempts
TARGETS = ("PTS", "REB", "AST", "STL", "BLK", "3PM", "TO")
# fit: chosen on the tuning seasons by ``fit`` and frozen here before any judged season was read
FROZEN: dict[str, dict[str, float]] = {}


# ---- the export, on the runner ---------------------------------------------------------------


def export(full_db: Path, league: str, seasons: list[str], out: Path) -> None:
    """Every regular-season game row (who played, for which team, on which day) and every team's
    schedule, for the seasons given, from the full build. Public box-score facts only."""
    import duckdb

    out.mkdir(parents=True, exist_ok=True)
    with duckdb.connect(str(full_db), read_only=True) as full:
        games = full.execute(
            """
            select season, game_date, player_id, team_id, played
            from gold.fct_player_game
            where league = $league and season in (select unnest($seasons))
                and substr(game_id, 3, 1) = '2'
            order by game_date, player_id
            """,
            {"league": league, "seasons": seasons},
        ).fetchdf()
        schedule = full.execute(
            """
            select distinct season, team_id, game_date_est as game_date, game_type
            from silver.schedule_team_games
            where league = $league and season in (select unnest($seasons))
                and not coalesce(if_necessary, false)
            order by game_date, team_id
            """,
            {"league": league, "seasons": seasons},
        ).fetchdf()
    games.to_csv(out / "games.csv", index=False)
    schedule.to_csv(out / "schedule.csv", index=False)
    meta = {"league": league, "seasons": seasons}
    (out / "meta.json").write_text(json.dumps(meta) + "\n", encoding="utf-8")
    print(f"{league} {seasons}: {len(games)} game rows, {len(schedule)} team games")


# ---- the inputs, as of a day -----------------------------------------------------------------


@dataclass(frozen=True)
class History:
    """One league's exported game rows and schedules (any number of folders)."""

    seasons: list[str]  # oldest first
    games: pd.DataFrame  # season, game_date, player_id, team_id, played
    schedule: pd.DataFrame  # season, team_id, game_date, game_type
    team_days: dict[str, frozenset[date]]  # each team's game days, of the types the board counts


def read_history(folders: list[Path]) -> tuple[str, History]:
    leagues, games, schedule = set(), [], []
    for folder in folders:
        meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
        leagues.add(meta["league"])
        ids = {"player_id": str, "team_id": str, "season": str}
        g = pd.read_csv(folder / "games.csv", dtype=ids)
        s = pd.read_csv(folder / "schedule.csv", dtype={"team_id": str, "season": str})
        games.append(g)
        schedule.append(s)
    if len(leagues) != 1:
        raise SystemExit(f"one league at a time, not {sorted(leagues)}")
    g = pd.concat(games).drop_duplicates()
    s = pd.concat(schedule).drop_duplicates()
    g["game_date"] = pd.to_datetime(g["game_date"]).dt.date
    s["game_date"] = pd.to_datetime(s["game_date"]).dt.date
    g["played"] = g["played"].astype(str).str.lower().isin(("true", "1"))
    seasons = sorted(set(g["season"]) | set(s["season"]))
    counted = s[s["game_type"].isin(GAME_TYPES)]
    team_days = {str(t): frozenset(d) for t, d in counted.groupby("team_id")["game_date"]}
    return leagues.pop(), History(
        seasons, g.reset_index(drop=True), s.reset_index(drop=True), team_days
    )


def cut(h: History, as_of: date) -> History:
    """The history with every game row on or after ``as_of`` deleted: what the leak check
    recomputes the inputs from. The schedule is published in advance and stays (ADR 0018)."""
    games = h.games[h.games["game_date"] < as_of].reset_index(drop=True)
    return History(h.seasons, games, h.schedule, h.team_days)


def pairs(h: History) -> pd.DataFrame:
    """Every back-to-back pair a player played the first night of: season, player_id, the second
    night's date, and whether he sat it."""
    team_days = pd.DataFrame(
        [(t, d) for t, days in h.team_days.items() for d in days], columns=["team_id", "game_date"]
    )
    played = h.games[h.games["played"]]
    first = played[["season", "player_id", "team_id", "game_date"]].copy()
    first["night2"] = first["game_date"] + timedelta(days=1)
    second_day = team_days.rename(columns={"game_date": "night2"})
    out = first.merge(second_day, on=["team_id", "night2"], how="inner")
    on_night2 = played[["player_id", "game_date"]].drop_duplicates()
    on_night2 = on_night2.rename(columns={"game_date": "night2"}).assign(played2=True)
    out = out.merge(on_night2, on=["player_id", "night2"], how="left")
    out["sat"] = out["played2"].isna()
    return out[["season", "player_id", "night2", "sat"]].drop_duplicates(
        subset=["player_id", "night2"]
    )


@dataclass(frozen=True)
class Inputs:
    """Per player, as of a day: his weighted back-to-back pairs and those he sat (this season and
    the ``HISTORY`` before it), and his team (that of his latest game before the day)."""

    n: dict[str, float]
    sat: dict[str, float]
    team: dict[str, str]


def inputs(h: History, b2b: pd.DataFrame, season: str, as_of: date, decay: float) -> Inputs:
    idx = h.seasons.index(season)
    back = {s: idx - i for i, s in enumerate(h.seasons) if 0 <= idx - i <= HISTORY}
    p = b2b[(b2b["night2"] < as_of) & b2b["season"].isin(back.keys())]
    w = p["season"].map(lambda s: decay ** back[s])
    n = w.groupby(p["player_id"]).sum()
    sat = (w * p["sat"]).groupby(p["player_id"]).sum()
    g = h.games[(h.games["game_date"] < as_of) & h.games["season"].isin(back.keys())]
    last = g.sort_values(["game_date", "team_id"]).groupby("player_id")["team_id"].last()
    return Inputs(
        n={k: float(v) for k, v in n.items()},
        sat={k: float(v) for k, v in sat.items()},
        team={k: str(v) for k, v in last.items()},
    )


def week_games(h: History, team: str, as_of: date) -> tuple[int, int]:
    """His team's games from ``as_of`` to that week's Sunday, as the board counts them, and how
    many of them are the second night of a back-to-back."""
    on = h.team_days.get(team, frozenset())
    sunday = as_of - timedelta(days=as_of.weekday()) + timedelta(days=6)
    week = [d for d in on if as_of <= d <= sunday]
    return len(week), sum(1 for d in week if d - timedelta(days=1) in on)


def shares(inp: Inputs, players: list[str], k: float) -> np.ndarray:
    """Each player's share of second nights sat, shrunk toward the players' pooled share."""
    n = np.array([inp.n.get(p, 0.0) for p in players])
    s = np.array([inp.sat.get(p, 0.0) for p in players])
    pooled = float(s.sum() / n.sum()) if n.sum() > 0 else 0.0
    if np.isinf(k):
        return np.full(len(players), pooled)
    out: np.ndarray = np.where(n + k > 0, (s + k * pooled) / np.where(n + k > 0, n + k, 1), pooled)
    return out


def predicted_games(
    h: History,
    inp: Inputs,
    players: list[str],
    scheduled: np.ndarray,
    listed: np.ndarray,
    as_of: date,
    k: float,
) -> np.ndarray:
    """The study's games for each player: the board's count less his share sat on each second
    night; none when listed out or doubtful, as the projection does."""
    share = shares(inp, players, k)
    out = scheduled.astype(float).copy()
    for i, pid in enumerate(players):
        team = inp.team.get(pid)
        if team is None:
            continue
        games, second = week_games(h, team, as_of)
        if games == int(scheduled[i]):
            out[i] = games - second * share[i]
    return np.where(listed, 0.0, out)


# ---- a season's weeks, S0's population -------------------------------------------------------


@dataclass(frozen=True)
class Monday:
    """One Monday's population, as S0 takes it, with what the study needs beside it."""

    as_of: date
    players: list[str]
    scheduled: np.ndarray  # the board's games this week
    listed: np.ndarray  # listed out or doubtful
    line: np.ndarray  # [P, 11] the projection's per-game line
    real: np.ndarray  # [P, 11] the real week's totals
    games: np.ndarray  # the real games played
    proj: np.ndarray  # [P, 9] S0's projection-week, as ops.week_yardstick loads it


def load(folder: Path) -> tuple[str, str, list[Monday]]:
    """A season's Mondays from a weekly export folder (ops.closeness_backtest export), with S0's
    population; the projection-week is checked against ops.week_yardstick's own loading."""
    league, season, s0_weeks = wy.load(folder)
    meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
    weeks_df = pd.read_csv(folder / "weeks.csv", parse_dates=["week"], dtype={"player_id": str})
    weeks_df["week"] = weeks_df["week"].dt.date
    out = []
    for text, s0 in zip(meta["weeks"], s0_weeks, strict=True):
        as_of = date.fromisoformat(text)
        monday = as_of - timedelta(days=as_of.weekday())
        df = pd.read_csv(folder / f"players-{text}.csv", dtype={"player_id": str})
        ids = {pid: i for i, pid in enumerate(df["player_id"])}
        x = np.zeros((len(df), len(STATS)))
        g = np.zeros(len(df))
        rows = weeks_df[(weeks_df["week"] == monday) & weeks_df["player_id"].isin(ids.keys())]
        for r in rows.itertuples(index=False):
            x[ids[r.player_id]] = [getattr(r, s) for s in STATS]
            g[ids[r.player_id]] = float(r.games)
        scheduled = df["games_this_week"].astype(float).fillna(0).to_numpy()
        listed = df["injury_group"].isin(LISTED_OUT).to_numpy()
        value = df[list(CATS)].astype(float).fillna(0).to_numpy().sum(axis=1)
        keep = wy.population(value, scheduled)
        line = df[list(LINE)].astype(float).fillna(0).to_numpy()[keep]
        card = np.where(listed[keep], 0.0, scheduled[keep])
        proj = wy.category_weeks(line, card, x[keep])
        if not np.allclose(proj, s0.proj):
            raise SystemExit(f"{as_of}: the population differs from S0's")
        out.append(
            Monday(
                as_of=as_of,
                players=[str(p) for p in df["player_id"].to_numpy()[keep]],
                scheduled=scheduled[keep],
                listed=listed[keep],
                line=line,
                real=x[keep],
                games=g[keep],
                proj=s0.proj,
            )
        )
    return league, season, out


def study_weeks(
    h: History,
    b2b: pd.DataFrame,
    season: str,
    mondays: list[Monday],
    k: float,
    decay: float,
    cache: dict[tuple[date, float], Inputs] | None = None,
) -> list[tuple[Monday, np.ndarray]]:
    """Each Monday with the study's predicted games for its population."""
    cache = {} if cache is None else cache
    out = []
    for m in mondays:
        key = (m.as_of, decay)
        if key not in cache:
            cache[key] = inputs(h, b2b, season, m.as_of, decay)
        inp = cache[key]
        out.append((m, predicted_games(h, inp, m.players, m.scheduled, m.listed, m.as_of, k)))
    return out


def games_rmse(weeks: list[tuple[Monday, np.ndarray]], *, projection: bool = False) -> float:
    err = np.concatenate(
        [(np.where(m.listed, 0.0, m.scheduled) if projection else g) - m.games for m, g in weeks]
    )
    return float(np.sqrt(np.mean(err**2)))


# ---- the leak check, the fit and the judgement -----------------------------------------------


def leak_check(h: History, season: str, mondays: list[Monday]) -> int:
    """Every Monday's inputs and predicted games, recomputed from the history with every game row
    from that Monday on deleted, must be the same. Returns the Mondays checked; raises on a
    difference."""
    b2b = pairs(h)
    for m in mondays:
        short = cut(h, m.as_of)
        short_b2b = pairs(short)
        for decay in DECAYS:
            a = inputs(h, b2b, season, m.as_of, decay)
            b = inputs(short, short_b2b, season, m.as_of, decay)
            if a != b:
                raise SystemExit(f"{season} {m.as_of}: the inputs saw the future (decay {decay})")
            for k in KS:
                ga = predicted_games(h, a, m.players, m.scheduled, m.listed, m.as_of, k)
                gb = predicted_games(short, b, m.players, m.scheduled, m.listed, m.as_of, k)
                if not np.array_equal(ga, gb):
                    raise SystemExit(f"{season} {m.as_of}: the games saw the future (k {k})")
    return len(mondays)


def _seasons(folders: list[Path], allowed: dict[str, set[str]], what: str) -> list[Any]:
    out = []
    for folder in folders:
        league, season, mondays = load(folder)
        if season == LOCKED[league] or season not in allowed[league]:
            raise SystemExit(f"{league} {season} is not a {what} season (#1079)")
        out.append((league, season, mondays))
    if len({lg for lg, _, _ in out}) != 1:
        raise SystemExit("one league at a time")
    return out


def fit(h: History, seasons: list[Any]) -> dict[str, Any]:
    """Every grid point's RMSE of games played over the tuning weeks; the lowest wins."""
    b2b = pairs(h)
    grid = []
    cache: dict[tuple[date, float], Inputs] = {}
    for decay in DECAYS:
        for k in KS:
            weeks = [w for _, s, ms in seasons for w in study_weeks(h, b2b, s, ms, k, decay, cache)]
            grid.append({"k": k, "decay": decay, "games_rmse": games_rmse(weeks)})
    best = min(grid, key=lambda r: round(r["games_rmse"], 12))
    weeks = [w for _, s, ms in seasons for w in study_weeks(h, b2b, s, ms, 0.0, 1.0)]
    return {
        "league": seasons[0][0],
        "seasons": sorted(s for _, s, _ in seasons),
        "weeks": len(weeks),
        "player_weeks": int(sum(len(m.players) for m, _ in weeks)),
        "projection_games_rmse": games_rmse(weeks, projection=True),
        "grid": grid,
        "pick": {"k": best["k"], "decay": best["decay"]},
    }


def judge(
    h: History, seasons: list[Any], s0: dict[str, Any], k: float, decay: float
) -> dict[str, Any]:
    """The study's week against the projection-week, S0's paired bootstrap at seed 0, and S0's
    bar per category."""
    league = seasons[0][0]
    b2b = pairs(h)
    weeks = [w for _, s, ms in seasons for w in study_weeks(h, b2b, s, ms, k, decay)]
    paired = [
        wy.Week(
            as_of=m.as_of,
            # S0's judge reports proj - naive: here the study minus the projection
            proj=wy.category_weeks(m.line, g, m.real),
            naive=m.proj,
            real=wy.real_weeks(m.real),
        )
        for m, g in weeks
    ]
    cats = wy.judge(paired, seeds=1)
    noise = {c["category"]: c for c in s0[league]["categories"]}
    rows, fails = [], []
    for c in cats:
        n = float(noise[c.category]["noise"])
        bar = n / 4
        row = {
            "category": c.category,
            "rmse_study": c.rmse_projection,
            "rmse_projection": c.rmse_naive,
            "diff": c.diff,
            "diff_low": c.diff_low,
            "diff_high": c.diff_high,
            "s0_noise": n,
            "bar": -bar,
            "target": c.category in TARGETS,
        }
        if c.category in TARGETS and not (c.diff <= -bar and c.diff_high < 0):
            fails.append(f"{c.category}: {c.diff:+.4f} ({c.diff_high:+.4f} high), bar {-bar:+.4f}")
        if c.diff > n:
            fails.append(f"{c.category}: worse by {c.diff:+.4f}, more than its noise {n:.4f}")
        rows.append(row)
    return {
        "league": league,
        "seasons": sorted(s for _, s, _ in seasons),
        "weeks": len(weeks),
        "player_weeks": int(sum(len(m.players) for m, _ in weeks)),
        "settings": {"k": k, "decay": decay},
        "games_rmse": {
            "study": games_rmse(weeks),
            "projection": games_rmse(weeks, projection=True),
        },
        "games_mean": {
            "study": float(np.mean(np.concatenate([g for _, g in weeks]))),
            "projection": float(
                np.mean(np.concatenate([np.where(m.listed, 0.0, m.scheduled) for m, _ in weeks]))
            ),
            "real": float(np.mean(np.concatenate([m.games for m, _ in weeks]))),
        },
        "categories": rows,
        "pass": not fails,
        "fails": fails,
    }


def table(res: dict[str, Any]) -> str:
    g = res["games_rmse"]
    head = (
        f"### {res['league'].upper()}, judged seasons {', '.join(res['seasons'])}: "
        f"{res['weeks']} weeks, {res['player_weeks']} player-weeks; k {res['settings']['k']}, "
        f"decay {res['settings']['decay']}\n\nGames played RMSE: study {g['study']:.4f}, "
        f"projection {g['projection']:.4f}\n\n"
    )
    rows = [
        "| Category | RMSE study | RMSE projection | Study - projection (95%) | S0 noise | Bar |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for c in res["categories"]:
        bar = f"{c['bar']:+.4f}" if c["target"] else f"no worse than {c['s0_noise']:.4f}"
        rows.append(
            f"| {c['category']} | {c['rmse_study']:.3f} | {c['rmse_projection']:.3f} "
            f"| {c['diff']:+.4f} ({c['diff_low']:+.4f} to {c['diff_high']:+.4f}) "
            f"| {c['s0_noise']:.4f} | {bar} |"
        )
    verdict = "PASS" if res["pass"] else "FAIL:\n  " + "\n  ".join(res["fails"])
    return head + "\n".join(rows) + "\n\n" + verdict + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ops.s1_games_played")
    sub = parser.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export", help="game rows and schedules from the full build (the runner)")
    e.add_argument("--league", choices=("nba", "wnba"), required=True)
    e.add_argument("--seasons", nargs="+", required=True)
    e.add_argument("--full-db", type=Path, required=True)
    e.add_argument("--out", type=Path, required=True)
    for name, text in (
        ("check", "the leak check over every Monday of the seasons given"),
        ("fit", "choose k and the decay on the tuning seasons"),
        ("judge", "the judgement on the judged seasons, with the frozen settings"),
    ):
        p = sub.add_parser(name, help=text)
        p.add_argument("folders", nargs="+", type=Path)
        p.add_argument("--games", nargs="+", type=Path, required=True)
        p.add_argument("--out", type=Path)
        if name == "judge":
            p.add_argument("--s0", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.cmd == "export":
        if LOCKED[args.league] in args.seasons:
            print(f"{args.league} {LOCKED[args.league]} is locked (#751)", file=sys.stderr)
            return 2
        export(args.full_db, args.league, args.seasons, args.out)
        return 0
    league, h = read_history(args.games)
    result: dict[str, Any]
    if args.cmd == "check":
        allowed = {lg: TUNING[lg] | JUDGED[lg] for lg in TUNING}
        seasons = _seasons(args.folders, allowed, "tuning or judged")
        total = sum(leak_check(h, s, ms) for _, s, ms in seasons)
        result = {"league": league, "mondays_checked": total, "leak": False}
        print(f"{league}: {total} Mondays, inputs identical with every later game row deleted")
    elif args.cmd == "fit":
        seasons = _seasons(args.folders, TUNING, "tuning")
        result = fit(h, seasons)
        for r in result["grid"]:
            print(f"k {r['k']:>6} decay {r['decay']:.2f}: games RMSE {r['games_rmse']:.5f}")
        print(f"projection: {result['projection_games_rmse']:.5f}; pick {result['pick']}")
    else:
        if league not in FROZEN:
            print(f"{league}: no frozen settings; fit on the tuning seasons first", file=sys.stderr)
            return 2
        seasons = _seasons(args.folders, JUDGED, "judged")
        s0 = json.loads(args.s0.read_text(encoding="utf-8"))
        result = judge(h, seasons, s0, FROZEN[league]["k"], FROZEN[league]["decay"])
        print(table(result))
    if args.out:
        args.out.write_text(json.dumps(result, indent=1, default=str) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
