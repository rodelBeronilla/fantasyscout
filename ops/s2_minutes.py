"""S2 (#1080): a teammate's minutes when a 28-minute player is out.

    uv run python -m ops.s2_minutes export --league nba --season 2020-21 \
        --full-db dbt/fantasyscout.duckdb --out s2-minutes/
    uv run python -m ops.s2_minutes parity s2-nba-2020-21/ closeness-nba-2020-21/
    uv run python -m ops.s2_minutes check s2-nba-2020-21/ ...
    uv run python -m ops.s2_minutes fit s2-nba-2020-21/ s2-nba-2021-22/ s2-nba-2022-23/ \
        --out fit.json
    uv run python -m ops.s2_minutes judge s2-nba-2023-24/ s2-nba-2024-25/ --out s2.json

The hypothesis, declared on #1080 before any run: when a player who averages 28 minutes or more
misses two or more games of the week, his teammates' minutes, and through them their counting
categories, can be predicted better than the projection does now, from past games the team played
without him. The harness is S0's (#1077, ops.week_yardstick): weekly point-in-time builds (ADR
0018), the projection-week as the baseline, the week's error per category, the paired bootstrap.

The population, as read on #1080 before any judged season (the listing does not exist on the
tuning seasons' Mondays, so the absence must be known from the games already missed):

- **the absent player:** on his team on the Monday's board, his latest game played was for that
  team, he averages ``STAR_MINUTES`` or more (his games played this season before the Monday, or
  this season and last when he has played fewer than ``OWN_GAMES``), he did not play in his team's
  last ``MISSED`` regular-season games of this season before the Monday (an absence still going
  on), and his team plays two or more games that week;
- **the population:** each Monday, the players in S0's population or the next 100 on the board
  (the top ``POOL`` by value among players with a game) who are on an absent player's team.

The inputs, from the regular-season box scores strictly before the Monday, this season and last
(the minutes redistribution model's span, gold.mart_minutes_redistribution, #820):

- **with and without:** per absent player and teammate, the teammate's minutes in the team's games
  the absent player played and in those he missed, over the games both were on the team and the
  teammate was there for (played, or sat by the coach as 0), as the model counts them;
- **lineup history:** the teammate is a starter beside him when he started at least half the games
  with him (from the box score's starting position), else a bench player; with no game beside him,
  his share of starts this season;
- **the prior:** each Monday, the league's pooled gain per class (starter or bench) over every
  28-minute player's teammates, each pair weighted by its games without him;
- **what the projection already sees:** the projection blends its season minutes with the last
  five games at ``RECENT_WEIGHT`` (var fantasy_recent_minutes), so a gain already in those games is
  counted once: ``unseen`` is 1 less ``RECENT_WEIGHT`` times the share of the teammate's last five
  games for the team that the absent player missed (1 before his fifth game).

The study's minutes for a teammate: the board's projected minutes plus ``w`` times the sum, over
his team's absent players, of ``unseen`` x the gain shrunk toward the class prior by ``k`` games
without him, kept between 0 and a game's length. A teammate himself absent keeps the projection.
His projected per-game line is scaled by the study's minutes over the projected minutes, so per
minute production, and FG% and FT%, are the projection's. ``w`` covers both the chance the absent
player stays out and what the projection already holds. ``k`` and ``w`` are chosen per league on
the tuning seasons only (``fit``: the lowest RMSE of the week's minutes, ties to the smaller ``w``
then the smaller ``k``) and frozen in ``FROZEN`` with the noise of the projection's RMSE on this
population (S0's recipe, seeds 0 to 19), before ``judge`` reads a judged season. The locked seasons
are refused everywhere.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from ops import week_yardstick as wy
from ops.closeness_backtest import LISTED_OUT, NAIVE
from ops.matchup import LINE
from ops.standings import CATS
from ops.standings_backtest import JUDGED, STATS, TUNING
from ops.walk_forward import LOCKED

# def: the absent player's minutes a game (#1080)
STAR_MINUTES = 28.0
# def: his games played this season before his own season's minutes stand alone (the projection's
# in-season threshold)
OWN_GAMES = 5
# def: his team's latest games of this season he has missed, for the absence to be known on Monday
MISSED = 2
# def: the week's games his team must play: "misses two or more of his team's games that week"
WEEK_GAMES = 2
# def: S0's population (8 teams x 13 spots and the next 26) and the next 100 on the board (#1080)
POOL = wy.POOL + 100
# the projection's weight on the last five games' minutes (var fantasy_recent_minutes) and that
# window (int_player_projection_parts' recent_minutes)
RECENT_WEIGHT = 0.5
RECENT_GAMES = 5
# a starter beside him: started at least this share of the games with him
STARTER_SHARE = 0.5
GAME_MINUTES = {"nba": 48.0, "wnba": 40.0}
# def: the grid the fit chooses from, declared before any run (#1080). k is games without him of
# shrinkage toward the class prior (inf: the prior for everyone); w scales the gain (0: the
# projection).
KS = (0.0, 1.0, 3.0, 10.0, 30.0, float("inf"))
WS = (0.0, 0.25, 0.5, 0.75, 1.0)
# the seven counting categories minutes can move; FG% and FT% are scored at the real attempts
TARGETS = ("PTS", "REB", "AST", "STL", "BLK", "3PM", "TO")
# fit: chosen on the tuning seasons by ``fit`` and frozen here before any judged season was read
# (2026-11-22; Backtest runs 44963295656, 44965084047 and 44968328313 for the NBA, 44966777799,
# 44967227098 and 44967666245 for the WNBA; every board identical to S0's). In both leagues every
# w above 0 raised the week's minutes RMSE at every k, so the pick is w 0, the projection itself:
# NBA 47.600 (68 weeks, 8,813 player-weeks), best w > 0 48.609 (k inf, w 0.25); WNBA 27.759
# (44 weeks, 3,383), best w > 0 29.259 (k 0, w 0.25).
FROZEN: dict[str, dict[str, float]] = {
    "nba": {"k": 0.0, "w": 0.0},
    "wnba": {"k": 0.0, "w": 0.0},
}
# the noise of the projection-week's RMSE on this population, tuning seasons, S0's recipe (1,000
# resamples, seed 0; seeds 0 to 19 in the fit's output): the bar is a quarter of it
NOISE: dict[str, dict[str, float]] = {
    "nba": {
        "PTS": 0.5714,
        "REB": 0.2070,
        "AST": 0.1504,
        "STL": 0.0324,
        "BLK": 0.0374,
        "3PM": 0.0618,
        "TO": 0.0693,
        "FG%": 0.0424,
        "FT%": 0.0224,
    },
    "wnba": {
        "PTS": 0.3471,
        "REB": 0.1419,
        "AST": 0.0986,
        "STL": 0.0382,
        "BLK": 0.0350,
        "3PM": 0.0538,
        "TO": 0.0574,
        "FG%": 0.0477,
        "FT%": 0.0242,
    },
}

GAMES_SQL = """
    select season, game_id, game_date, team_id, player_id,
        coalesce(played, false) as played,
        case when coalesce(played, false) then minutes else 0 end as minutes,
        coalesce(position, '') <> '' as starter,
        lower(coalesce(comment, '')) like '%coach%' as coach
    from gold.fct_player_game
    where league = $league and substr(game_id, 3, 1) = '2'
    order by game_date, game_id, team_id, player_id
"""


# ---- the export, on the runner ---------------------------------------------------------------


def export(full_db: Path, league: str, season: str, out: Path) -> None:
    """The judged season's Mondays as ops.closeness_backtest exports them (a point-in-time build
    each), with each board player's team and projected minutes beside them, and every mirrored
    season's regular-season game rows from the full build. Public box-score facts only."""
    import duckdb

    from ops import closeness_backtest, standings_backtest, walk_forward

    out.mkdir(parents=True, exist_ok=True)
    with duckdb.connect(str(full_db), read_only=True) as full:
        first, last = walk_forward._season_span(full, league, season)
        standings_backtest.export_weeks(full, league, season, first, out)
        games = full.execute(GAMES_SQL, {"league": league}).fetchdf()
    games.to_csv(out / "games.csv", index=False)
    days = closeness_backtest.week_days(first, last)
    meta = {
        "league": league,
        "season": season,
        "weeks": [d.isoformat() for d in days],
        "game_seasons": sorted(str(s) for s in games["season"].unique()),
    }
    (out / "meta.json").write_text(json.dumps(meta) + "\n", encoding="utf-8")
    extra = "select player_id, team_id, proj_minutes_pg from gold.mart_board where league = $league"
    with tempfile.TemporaryDirectory() as tmp:
        for as_of in days:
            db = Path(tmp) / f"week-{as_of.isoformat()}.duckdb"
            walk_forward._build(as_of, db)
            with duckdb.connect(str(db), read_only=True) as cut:
                closeness_backtest.export_week(cut, league, season, as_of, out)
                df = cut.execute(extra, {"league": league}).fetchdf()
                df.to_csv(out / f"s2-{as_of.isoformat()}.csv", index=False)
            db.unlink()
            print(f"{as_of}: the board exported", flush=True)
    print(f"{league} {season}: {len(games)} game rows, {len(days)} Mondays")


# ---- the game rows ---------------------------------------------------------------------------


@dataclass(frozen=True)
class History:
    """One export's regular-season game rows (the seasons the run mirrored)."""

    seasons: list[str]  # oldest first
    games: pd.DataFrame  # season, game_id, game_date, team_id, player_id, played, minutes, ...


def read_games(path: Path) -> History:
    g = pd.read_csv(path, dtype={"season": str, "game_id": str, "team_id": str, "player_id": str})
    g["game_date"] = pd.to_datetime(g["game_date"]).dt.date
    for col in ("played", "starter", "coach"):
        g[col] = g[col].astype(str).str.lower().isin(("true", "1"))
    g["minutes"] = g["minutes"].astype(float).fillna(0.0)
    return History(sorted(set(g["season"])), g.reset_index(drop=True))


def cut(h: History, as_of: date) -> History:
    """The history with every game row on or after ``as_of`` deleted."""
    return History(h.seasons, h.games[h.games["game_date"] < as_of].reset_index(drop=True))


def rewrite(h: History, as_of: date) -> History:
    """The history with every game row on or after ``as_of`` rewritten (who played flipped, the
    minutes turned around, the starters swapped): inputs as of the day must not move."""
    g = h.games.copy()
    late = g["game_date"] >= as_of
    g.loc[late, "played"] = ~g.loc[late, "played"]
    g.loc[late, "minutes"] = np.where(g.loc[late, "played"], 47.0 - g.loc[late, "minutes"], 0.0)
    g.loc[late, "starter"] = ~g.loc[late, "starter"]
    return History(h.seasons, g)


# ---- the inputs, as of a Monday --------------------------------------------------------------


@dataclass(frozen=True)
class Pair:
    """One absent player and one teammate in the population, as of the Monday."""

    absent: str
    teammate: str
    n_with: int  # games the absent player played that the teammate was there for
    n_without: int  # games he missed that the teammate was there for
    gain: float  # minutes without less minutes with (0 when either split is empty)
    starter: bool  # the teammate's class: a starter beside him
    unseen: float  # the share of the gain the projection's last five games do not hold


@dataclass(frozen=True)
class Inputs:
    absent: tuple[str, ...]
    pairs: tuple[Pair, ...]
    prior: tuple[float, float]  # pooled gain: bench, starter


@dataclass(frozen=True)
class Board:
    """The Monday's board, from its point-in-time build: who is on which team, games this week,
    and the population's candidates (the top ``POOL``)."""

    team: dict[str, str]
    games: dict[str, float]
    pool: frozenset[str]


def _window(h: History, season: str, as_of: date) -> pd.DataFrame:
    """This season's and last season's game rows strictly before ``as_of``."""
    idx = h.seasons.index(season)
    keep = set(h.seasons[max(0, idx - 1) : idx + 1])
    g = h.games
    return g[(g["game_date"] < as_of) & g["season"].isin(keep)]


def _minutes_a_game(g: pd.DataFrame, season: str) -> dict[str, float]:
    """Each player's minutes per game played: this season's, or this season and last together
    before his ``OWN_GAMES``th game of this one."""
    played = g[g["played"]]
    cur = played[played["season"] == season].groupby("player_id")["minutes"].agg(["mean", "count"])
    both = played.groupby("player_id")["minutes"].mean()
    out = {str(p): float(m) for p, m in both.items()}
    for p, r in cur.iterrows():
        if r["count"] >= OWN_GAMES:
            out[str(p)] = float(r["mean"])
    return out


@dataclass(frozen=True)
class _Team:
    """A team's games in the window and every player with a row for it: on the team (his stint),
    played, minutes, there for it (played or sat by the coach) and started, game x player."""

    games: pd.DataFrame  # season, game_id, game_date, in order
    players: list[str]
    col: dict[str, int]
    on: np.ndarray
    played: np.ndarray
    minutes: np.ndarray
    there: np.ndarray
    starter: np.ndarray


def _teams(g: pd.DataFrame, as_of: date) -> dict[str, _Team]:
    """Every team's matrices. A player is on a team from his first game listed with it in a
    season to his last, or on to the day when it is his latest team that season (the model's
    stint rule)."""
    order = g.sort_values(["game_date", "game_id"])
    latest = order.groupby(["season", "player_id"])["team_id"].last()
    out = {}
    for team, rows in g.groupby("team_id"):
        games = (
            rows[["season", "game_id", "game_date"]]
            .drop_duplicates("game_id")
            .sort_values(["game_date", "game_id"])
            .reset_index(drop=True)
        )
        gi = {gid: i for i, gid in enumerate(games["game_id"])}
        players = sorted(set(rows["player_id"]))
        col = {p: j for j, p in enumerate(players)}
        shape = (len(games), len(players))
        on = np.zeros(shape, bool)
        played = np.zeros(shape, bool)
        minutes = np.zeros(shape)
        there = np.zeros(shape, bool)
        starter = np.zeros(shape, bool)
        r = rows["game_id"].map(gi).to_numpy()
        c = rows["player_id"].map(col).to_numpy()
        played[r, c] = rows["played"].to_numpy()
        minutes[r, c] = rows["minutes"].to_numpy()
        there[r, c] = rows["played"].to_numpy() | rows["coach"].to_numpy()
        starter[r, c] = rows["starter"].to_numpy() & rows["played"].to_numpy()
        days = games["game_date"].to_numpy()
        seasons = games["season"].to_numpy()
        span = rows.groupby(["season", "player_id"])["game_date"].agg(["min", "max"])
        for (season, pid), s in span.iterrows():
            end = as_of if latest.get((season, pid)) == team else s["max"]
            on[:, col[pid]] = (seasons == season) & (days >= s["min"]) & (days <= end)
        out[str(team)] = _Team(games, players, col, on, played, minutes, there, starter)
    return out


def _splits(t: _Team, ia: int) -> tuple[np.ndarray, ...]:
    """Every column's games with and without the player in column ``ia``, its minutes in each and
    its share of starts in the games with him."""
    there = t.on & t.there & t.on[:, ia][:, None]
    w = there & t.played[:, ia][:, None]
    wo = there & ~t.played[:, ia][:, None]
    n_w, n_wo = w.sum(0), wo.sum(0)
    m_w = np.divide((t.minutes * w).sum(0), n_w, out=np.zeros(len(n_w)), where=n_w > 0)
    m_wo = np.divide((t.minutes * wo).sum(0), n_wo, out=np.zeros(len(n_wo)), where=n_wo > 0)
    start = np.divide((t.starter * w).sum(0), n_w, out=np.full(len(n_w), np.nan), where=n_w > 0)
    return n_w, n_wo, m_w, m_wo, start


def inputs(h: History, season: str, as_of: date, board: Board) -> Inputs:
    """The absent players, their pairs with the population and the class priors, from the game
    rows strictly before ``as_of`` and the Monday's board."""
    g = _window(h, season, as_of)
    mpg = _minutes_a_game(g, season)
    order = g[g["played"]].sort_values(["game_date", "game_id"])
    last_team = {str(p): str(t) for p, t in order.groupby("player_id")["team_id"].last().items()}
    cur = g[g["season"] == season]
    starts = cur[cur["played"]].groupby("player_id")["starter"].mean()
    teams = _teams(g, as_of)

    def missed_latest(pid: str, team: str) -> bool:
        t = teams.get(team)
        if t is None:
            return False
        idx = np.flatnonzero(t.games["season"].to_numpy() == season)
        if len(idx) < MISSED:
            return False
        latest = idx[-MISSED:]
        return pid not in t.col or not t.played[latest, t.col[pid]].any()

    absent = sorted(
        pid
        for pid, team in board.team.items()
        if mpg.get(pid, 0.0) >= STAR_MINUTES
        and last_team.get(pid) == team
        and board.games.get(pid, 0.0) >= WEEK_GAMES
        and missed_latest(pid, team)
    )

    # the class priors: every 28-minute player's teammates on his latest team
    sums = np.zeros(2)
    weights = np.zeros(2)
    for pid, m in mpg.items():
        team = last_team.get(pid)
        if m < STAR_MINUTES or team not in teams:
            continue
        t = teams[team]
        n_w, n_wo, m_w, m_wo, start = _splits(t, t.col[pid])
        ok = (n_w > 0) & (n_wo > 0)
        ok[t.col[pid]] = False
        cls = (np.nan_to_num(start) >= STARTER_SHARE).astype(int)
        for c in (0, 1):
            sel = ok & (cls == c)
            sums[c] += float((n_wo[sel] * (m_wo[sel] - m_w[sel])).sum())
            weights[c] += float(n_wo[sel].sum())
    prior = tuple(float(s / w) if w > 0 else 0.0 for s, w in zip(sums, weights, strict=True))

    pairs = []
    for a in absent:
        team = board.team[a]
        t = teams[team]
        ia = t.col[a]
        n_w, n_wo, m_w, m_wo, start = _splits(t, ia)
        for j in sorted(board.pool):
            if j == a or board.team.get(j) != team:
                continue
            ij = t.col.get(j)
            if ij is None or n_w[ij] == 0 or n_wo[ij] == 0:
                nw = 0 if ij is None else int(n_w[ij])
                nwo, gain = 0, 0.0
            else:
                nw, nwo, gain = int(n_w[ij]), int(n_wo[ij]), float(m_wo[ij] - m_w[ij])
            if ij is not None and not np.isnan(start[ij]):
                is_starter = bool(start[ij] >= STARTER_SHARE)
            else:
                is_starter = bool(starts.get(j, 0.0) >= STARTER_SHARE)
            unseen = 1.0
            if ij is not None:
                mine = np.flatnonzero(
                    (t.games["season"].to_numpy() == season)
                    & t.played[:, ij]
                    & (t.minutes[:, ij] > 0)
                )[-RECENT_GAMES:]
                if len(mine) >= RECENT_GAMES:
                    unseen = 1.0 - RECENT_WEIGHT * float(np.mean(~t.played[mine, ia]))
            pairs.append(Pair(a, j, nw, nwo, gain, is_starter, unseen))
    return Inputs(tuple(absent), tuple(pairs), (prior[0], prior[1]))


def gains(inp: Inputs, players: list[str], k: float) -> np.ndarray:
    """Each player's gain in minutes a game at shrinkage ``k``, before ``w``: the sum over his
    team's absent players of the unseen share of the shrunk gain; none for an absent player."""
    out = dict.fromkeys(players, 0.0)
    for p in inp.pairs:
        if p.teammate in inp.absent or p.teammate not in out:
            continue
        prior = inp.prior[int(p.starter)]
        if np.isinf(k) or p.n_without + k == 0:
            g = prior
        else:
            g = (p.n_without * p.gain + k * prior) / (p.n_without + k)
        out[p.teammate] += p.unseen * g
    return np.array([out[p] for p in players])


# ---- a season's Mondays ----------------------------------------------------------------------


@dataclass(frozen=True)
class Monday:
    """One Monday's population, with what the projection and the study need."""

    as_of: date
    players: list[str]
    line: np.ndarray  # [P, 11] the projection's per-game line
    naive: np.ndarray  # [P, 11] the season so far per game (S0's naive manager, for the noise)
    card: np.ndarray  # [P] games counted: none when listed out or doubtful
    scheduled: np.ndarray  # [P] the board's games this week
    real: np.ndarray  # [P, 11] the real week's totals
    proj_minutes: np.ndarray  # [P] the board's projected minutes a game
    real_minutes: np.ndarray  # [P] the real week's minutes
    gain: dict[float, np.ndarray]  # k -> [P] gain before w
    absent: tuple[str, ...]


def _board_day(folder: Path, text: str) -> pd.DataFrame:
    df = pd.read_csv(folder / f"players-{text}.csv", dtype={"player_id": str})
    extra = pd.read_csv(folder / f"s2-{text}.csv", dtype={"player_id": str, "team_id": str})
    if len(extra) != len(df) or set(extra["player_id"]) != set(df["player_id"]):
        raise SystemExit(f"{folder} {text}: the two board files list different players")
    return df.merge(extra, on="player_id", how="left", validate="one_to_one")


def load(
    folder: Path,
    inputs_fn: Callable[[History, str, date, Board], Inputs] = inputs,
) -> tuple[str, str, History, list[tuple[Monday, Board]]]:
    """A season's Mondays from an S2 export folder, each with the population and its gains."""
    meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
    league, season = meta["league"], meta["season"]
    h = read_games(folder / "games.csv")
    weeks_df = pd.read_csv(folder / "weeks.csv", parse_dates=["week"], dtype={"player_id": str})
    weeks_df["week"] = weeks_df["week"].dt.date
    out = []
    for text in meta["weeks"]:
        as_of = date.fromisoformat(text)
        monday = as_of - timedelta(days=as_of.weekday())
        df = _board_day(folder, text)
        scheduled = df["games_this_week"].astype(float).fillna(0).to_numpy()
        value = df[list(CATS)].astype(float).fillna(0).to_numpy().sum(axis=1)
        keep = wy.population(value, scheduled, POOL)
        ids = [str(p) for p in df["player_id"]]
        board = Board(
            team={p: str(t) for p, t in zip(ids, df["team_id"], strict=True) if isinstance(t, str)},
            games=dict(zip(ids, scheduled.tolist(), strict=True)),
            pool=frozenset(ids[i] for i in keep),
        )
        inp = inputs_fn(h, season, as_of, board)
        # a teammate of an absent player: on his team, not himself (another absent one counts)
        rows = [
            i
            for i in keep
            if any(board.team[a] == board.team.get(ids[i]) and a != ids[i] for a in inp.absent)
        ]
        players = [ids[i] for i in rows]
        x = np.zeros((len(rows), len(STATS)))
        pos = {p: n for n, p in enumerate(players)}
        week = weeks_df[(weeks_df["week"] == monday) & weeks_df["player_id"].isin(pos.keys())]
        for r in week.itertuples(index=False):
            x[pos[r.player_id]] = [getattr(r, s) for s in STATS]
        g = h.games
        in_week = g[(g["game_date"] >= monday) & (g["game_date"] <= monday + timedelta(days=6))]
        mins = in_week.groupby("player_id")["minutes"].sum()
        listed = df["injury_group"].isin(LISTED_OUT).to_numpy()[rows]
        sched = scheduled[rows]
        out.append(
            (
                Monday(
                    as_of=as_of,
                    players=players,
                    line=df[list(LINE)].astype(float).fillna(0).to_numpy()[rows],
                    naive=df[list(NAIVE)].astype(float).fillna(0).to_numpy()[rows],
                    card=np.where(listed, 0.0, sched),
                    scheduled=sched,
                    real=x,
                    proj_minutes=df["proj_minutes_pg"].astype(float).fillna(0).to_numpy()[rows],
                    real_minutes=np.array([float(mins.get(p, 0.0)) for p in players]),
                    gain={k: gains(inp, players, k) for k in KS},
                    absent=inp.absent,
                ),
                board,
            )
        )
    return league, season, h, out


def study_minutes(m: Monday, league: str, k: float, w: float) -> np.ndarray:
    """The study's minutes a game: the projection's plus w x the gain, within a game's length."""
    return np.clip(m.proj_minutes + w * m.gain[k], 0.0, GAME_MINUTES[league])


def study_line(m: Monday, league: str, k: float, w: float) -> np.ndarray:
    """The projected per-game line at the study's minutes: every stat scaled by the minutes."""
    new = study_minutes(m, league, k, w)
    factor = np.divide(new, m.proj_minutes, out=np.ones(len(new)), where=m.proj_minutes > 0)
    out: np.ndarray = m.line * factor[:, None]
    return out


def minutes_rmse(
    weeks: list[tuple[str, Monday]], k: float, w: float, *, projection: bool = False
) -> float:
    err = np.concatenate(
        [
            (m.proj_minutes if projection else study_minutes(m, lg, k, w)) * m.card - m.real_minutes
            for lg, m in weeks
        ]
    )
    return float(np.sqrt(np.mean(err**2))) if len(err) else float("nan")


def _paired(weeks: list[tuple[str, Monday]], k: float, w: float) -> list[wy.Week]:
    """S0's weeks with the study as its projection and the projection as its naive manager."""
    return [
        wy.Week(
            as_of=m.as_of,
            proj=wy.category_weeks(study_line(m, lg, k, w), m.card, m.real),
            naive=wy.category_weeks(m.line, m.card, m.real),
            real=wy.real_weeks(m.real),
        )
        for lg, m in weeks
        if len(m.players)
    ]


def _baseline(weeks: list[tuple[str, Monday]]) -> list[wy.Week]:
    """S0's own weeks on this population: the projection-week against the naive-week."""
    return [
        wy.Week(
            as_of=m.as_of,
            proj=wy.category_weeks(m.line, m.card, m.real),
            naive=wy.category_weeks(m.naive, m.scheduled, m.real),
            real=wy.real_weeks(m.real),
        )
        for _, m in weeks
        if len(m.players)
    ]


# ---- the leak check, the fit and the judgement -----------------------------------------------


def leak_check(
    h: History,
    season: str,
    mondays: list[tuple[Monday, Board]],
    inputs_fn: Callable[[History, str, date, Board], Inputs] = inputs,
) -> int:
    """Every Monday's inputs and gains, recomputed from the game rows with every row from that
    Monday on deleted, and again with them rewritten, must be the same. Returns the Mondays
    checked; raises on a difference."""
    for m, board in mondays:
        full = inputs_fn(h, season, m.as_of, board)
        for other in (cut(h, m.as_of), rewrite(h, m.as_of)):
            alt = inputs_fn(other, season, m.as_of, board)
            if alt != full:
                raise SystemExit(f"{season} {m.as_of}: the inputs saw the future")
            for k in KS:
                if not np.array_equal(gains(full, m.players, k), gains(alt, m.players, k)):
                    raise SystemExit(f"{season} {m.as_of}: the gains saw the future (k {k})")
    return len(mondays)


def _seasons(
    folders: list[Path], allowed: dict[str, set[str]], what: str
) -> list[tuple[str, str, History, list[tuple[Monday, Board]]]]:
    out = []
    for folder in folders:
        meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
        league, season = meta["league"], meta["season"]
        if season == LOCKED[league] or season not in allowed[league]:
            raise SystemExit(f"{league} {season} is not a {what} season (#1080)")
        if LOCKED[league] in meta.get("game_seasons", []):
            raise SystemExit(f"{folder}: holds the locked season {LOCKED[league]}")
        out.append(load(folder))
    if len({lg for lg, _, _, _ in out}) != 1:
        raise SystemExit("one league at a time")
    return out


def _flat(seasons: list[Any]) -> list[tuple[str, Monday]]:
    return [(lg, m) for lg, _, _, ms in seasons for m, _ in ms]


def describe(weeks: list[tuple[str, Monday]]) -> dict[str, Any]:
    pop = [m for _, m in weeks if len(m.players)]
    return {
        "mondays": len(weeks),
        "weeks": len(pop),
        "player_weeks": int(sum(len(m.players) for m in pop)),
        "absent_player_weeks": int(sum(len(m.absent) for _, m in weeks)),
    }


def fit(seasons: list[Any], noise_seeds: int = wy.SEEDS) -> dict[str, Any]:
    """Every grid point's RMSE of the week's minutes over the tuning weeks, the pick, the
    categories at the pick, and the noise of the projection's RMSE on this population."""
    weeks = _flat(seasons)
    grid = [{"k": k, "w": w, "minutes_rmse": minutes_rmse(weeks, k, w)} for w in WS for k in KS]
    best = min(grid, key=lambda r: (round(r["minutes_rmse"], 9), r["w"], r["k"]))
    base = wy.judge(_baseline(weeks), seeds=noise_seeds)
    at_pick = wy.judge(_paired(weeks, best["k"], best["w"]), seeds=1)
    return {
        "league": seasons[0][0],
        "seasons": sorted(s for _, s, _, _ in seasons),
        **describe(weeks),
        "projection_minutes_rmse": minutes_rmse(weeks, 0.0, 0.0, projection=True),
        "grid": grid,
        "pick": {"k": best["k"], "w": best["w"]},
        "noise": {c.category: c.noise for c in base},
        "noise_range": {c.category: [c.seed_noise_min, c.seed_noise_max] for c in base},
        "baseline": [c.__dict__ for c in base],
        "at_pick": [c.__dict__ for c in at_pick],
    }


def apply_bar(
    cats: list[wy.Category], noise: dict[str, float]
) -> tuple[list[dict[str, Any]], list[str]]:
    """S0's bar per category, on this population's noise (``cats`` from ops.week_yardstick.judge
    with the study as its projection and the projection as its naive): in each target category
    the study's RMSE is lower by at least a quarter of the noise with the 95% interval below zero,
    and no category is worse by more than its noise."""
    rows, fails = [], []
    for c in cats:
        n = float(noise[c.category])
        bar = n / 4
        rows.append(
            {
                "category": c.category,
                "rmse_study": c.rmse_projection,
                "rmse_projection": c.rmse_naive,
                "diff": c.diff,
                "diff_low": c.diff_low,
                "diff_high": c.diff_high,
                "noise": n,
                "bar": -bar,
                "target": c.category in TARGETS,
            }
        )
        if c.category in TARGETS and not (c.diff <= -bar and c.diff_high < 0):
            fails.append(f"{c.category}: {c.diff:+.4f} ({c.diff_high:+.4f} high), bar {-bar:+.4f}")
        if c.diff > n:
            fails.append(f"{c.category}: worse by {c.diff:+.4f}, more than its noise {n:.4f}")
    return rows, fails


def judge(seasons: list[Any], k: float, w: float, noise: dict[str, float]) -> dict[str, Any]:
    """The study's week against the projection-week, S0's paired bootstrap at seed 0, and the bar
    per category on this population's noise."""
    weeks = _flat(seasons)
    rows, fails = apply_bar(wy.judge(_paired(weeks, k, w), seeds=1), noise)
    return {
        "league": seasons[0][0],
        "seasons": sorted(s for _, s, _, _ in seasons),
        **describe(weeks),
        "settings": {"k": k, "w": w},
        "minutes_rmse": {
            "study": minutes_rmse(weeks, k, w),
            "projection": minutes_rmse(weeks, k, w, projection=True),
        },
        "categories": rows,
        "pass": not fails,
        "fails": fails,
    }


def table(res: dict[str, Any]) -> str:
    mr = res["minutes_rmse"]
    head = (
        f"### {res['league'].upper()}, judged seasons {', '.join(res['seasons'])}: "
        f"{res['weeks']} weeks, {res['player_weeks']} player-weeks; k {res['settings']['k']}, "
        f"w {res['settings']['w']}\n\nWeek minutes RMSE: study {mr['study']:.3f}, "
        f"projection {mr['projection']:.3f}\n\n"
    )
    rows = [
        "| Category | RMSE study | RMSE projection | Study - projection (95%) | Noise | Bar |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for c in res["categories"]:
        bar = f"{c['bar']:+.4f}" if c["target"] else f"no worse than {c['noise']:.4f}"
        rows.append(
            f"| {c['category']} | {c['rmse_study']:.3f} | {c['rmse_projection']:.3f} "
            f"| {c['diff']:+.4f} ({c['diff_low']:+.4f} to {c['diff_high']:+.4f}) "
            f"| {c['noise']:.4f} | {bar} |"
        )
    verdict = "PASS" if res["pass"] else "FAIL:\n  " + "\n  ".join(res["fails"])
    return head + "\n".join(rows) + "\n\n" + verdict + "\n"


def parity(mine: Path, theirs: Path) -> int:
    """My export's boards against another weekly export of the same season (S0's or S1's): the
    same Mondays, players and columns, values within 1e-9. Returns the Mondays compared."""
    a = json.loads((mine / "meta.json").read_text(encoding="utf-8"))
    b = json.loads((theirs / "meta.json").read_text(encoding="utf-8"))
    if (a["league"], a["season"], a["weeks"]) != (b["league"], b["season"], b["weeks"]):
        raise SystemExit("not the same season's Mondays")
    for text in a["weeks"]:
        x = pd.read_csv(mine / f"players-{text}.csv", dtype={"player_id": str})
        y = pd.read_csv(theirs / f"players-{text}.csv", dtype={"player_id": str})
        x, y = x.sort_values("player_id").reset_index(drop=True), y.sort_values("player_id")
        y = y.reset_index(drop=True)[list(x.columns)]
        pd.testing.assert_frame_equal(x, y, check_exact=False, rtol=0, atol=1e-9)
    key = ["week", "player_id"]
    wa = pd.read_csv(mine / "weeks.csv", dtype={"player_id": str}).sort_values(key)
    wb = pd.read_csv(theirs / "weeks.csv", dtype={"player_id": str}).sort_values(key)
    pd.testing.assert_frame_equal(wa.reset_index(drop=True), wb.reset_index(drop=True))
    return len(a["weeks"])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ops.s2_minutes")
    sub = parser.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export", help="the boards and game rows from the build (the runner)")
    e.add_argument("--league", choices=("nba", "wnba"), required=True)
    e.add_argument("--season", required=True)
    e.add_argument("--full-db", type=Path, required=True)
    e.add_argument("--out", type=Path, required=True)
    p = sub.add_parser("parity", help="an export's boards against another export of the season")
    p.add_argument("mine", type=Path)
    p.add_argument("theirs", type=Path)
    for name, text in (
        ("check", "the leak check over every Monday of the seasons given"),
        ("fit", "choose k and w on the tuning seasons, and the noise on this population"),
        ("judge", "the judgement on the judged seasons, with the frozen settings"),
    ):
        q = sub.add_parser(name, help=text)
        q.add_argument("folders", nargs="+", type=Path)
        q.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    if args.cmd == "export":
        if args.season == LOCKED[args.league]:
            print(f"{args.league} {args.season} is locked (#751)", file=sys.stderr)
            return 2
        export(args.full_db, args.league, args.season, args.out)
        return 0
    if args.cmd == "parity":
        print(f"{parity(args.mine, args.theirs)} Mondays: the boards are the same")
        return 0
    result: dict[str, Any]
    if args.cmd == "check":
        allowed = {lg: TUNING[lg] | JUDGED[lg] for lg in TUNING}
        seasons = _seasons(args.folders, allowed, "tuning or judged")
        total = sum(leak_check(h, s, ms) for _, s, h, ms in seasons)
        result = {"league": seasons[0][0], "mondays_checked": total, "leak": False}
        print(f"{seasons[0][0]}: {total} Mondays, inputs identical with every later row deleted")
    elif args.cmd == "fit":
        seasons = _seasons(args.folders, TUNING, "tuning")
        result = fit(seasons)
        for r in result["grid"]:
            print(f"k {r['k']:>5} w {r['w']:.2f}: week minutes RMSE {r['minutes_rmse']:.4f}")
        print(
            f"projection: {result['projection_minutes_rmse']:.4f}; pick {result['pick']}; "
            f"{result['weeks']} weeks, {result['player_weeks']} player-weeks"
        )
        for c in result["at_pick"]:
            print(f"{c['category']}: study {c['rmse_projection']:.4f} vs {c['rmse_naive']:.4f}")
        print("noise:", {c: round(v, 4) for c, v in result["noise"].items()})
    else:
        seasons = _seasons(args.folders, JUDGED, "judged")
        league = seasons[0][0]
        if league not in FROZEN or league not in NOISE:
            print(f"{league}: no frozen settings; fit on the tuning seasons first", file=sys.stderr)
            return 2
        result = judge(seasons, FROZEN[league]["k"], FROZEN[league]["w"], NOISE[league])
        print(table(result))
    if args.out:
        args.out.write_text(json.dumps(result, indent=1, default=str) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
