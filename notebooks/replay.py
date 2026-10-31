"""The board's projection, replayed as of any date from the player-game facts alone.

``mart_player_projection`` and ``mart_board`` project and value every rostered player from all
the games in the build. To ask how good that projection is, the notebooks need it as a manager
would have seen it on an earlier day, using only the games before that day. This module
re-implements both models in pandas, point in time:

- per-minute production, counted by minutes played times the season's recency weight;
- minutes per game, counted by games played times the league's minutes recency weight, with a
  past season spent mostly on another team down-weighted (``fantasy_team_change``);
- in season, projected minutes blended with the last five games for the current team
  (``fantasy_recent_minutes``), and cut for a player still out or just back from three or more
  team games missed (``fantasy_return_ramp``);
- ``prior_games`` games of a replacement-level line, from the latest complete season;
- the games share, regressed toward a typical share by ``durability_games`` games;
- value above replacement scored in two pool passes, as ``mart_board`` does.

Every setting is read from ``dbt/dbt_project.yml`` (``load_settings``), so the replay follows the
project when a setting changes. ``tests/test_replay.py`` pins the arithmetic on small frames, and
the backtest notebook compares a replay as of the build's date with ``mart_player_projection``.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import yaml

ROOT = Path(__file__).resolve().parent.parent
PROJECT_FILE = ROOT / "dbt" / "dbt_project.yml"

# Box-score columns a replay reads from fct_player_game (read only these: the table is large).
GAME_COLUMNS = (
    "league",
    "season",
    "game_id",
    "game_date",
    "player_id",
    "team_id",
    "position",
    "minutes",
    "played",
    "points",
    "rebounds_total",
    "assists",
    "steals",
    "blocks",
    "three_pointers_made",
    "three_pointers_attempted",
    "turnovers",
    "field_goals_made",
    "field_goals_attempted",
    "free_throws_made",
    "free_throws_attempted",
)
COUNTING = (
    "points",
    "rebounds_total",
    "assists",
    "steals",
    "blocks",
    "three_pointers_made",
    "turnovers",
)
# Projected per-game production: the counting categories plus makes and attempts.
PRODUCTION = (*COUNTING, "fgm", "fga", "ftm", "fta")
BOX = {
    "fgm": "field_goals_made",
    "fga": "field_goals_attempted",
    "ftm": "free_throws_made",
    "fta": "free_throws_attempted",
}
CATEGORIES = (*COUNTING, "field_goal_pct", "free_throw_pct")
# mart_category_zscores ranks its pool by total minutes: the top 180 NBA and 90 WNBA players.
ZSCORE_POOL = {"nba": 180, "wnba": 90}
# Seasons replayed to choose the board's settings (ADR 0003, "Settings chosen by backtest" and
# the minutes and games addendum). Results on them are in-sample; every other season is not.
TUNING_SEASONS = {
    "nba": frozenset({"2024-25", "2025-26"}),
    "wnba": frozenset({"2021", "2022", "2023", "2024", "2025", "2026"}),
}
# Seasons the return ramp (fantasy_return_ramp) was chosen on, by next-five and next-ten-game
# minutes (ADR 0003, the return ramp addendum); later seasons test it out of sample.
RAMP_FIT_SEASONS = {
    "nba": frozenset({"2023-24", "2024-25"}),
    "wnba": frozenset({"2018", "2019", "2020", "2021", "2022", "2023", "2024"}),
}
CHECKPOINTS = (("preseason", 0.0), ("a tenth in", 0.1), ("a quarter in", 0.25), ("half way", 0.5))
TOP_N = {"nba": 50, "wnba": 30}


@dataclass(frozen=True)
class Settings:
    """One league's fantasy settings, as dbt_project.yml sets them."""

    league: str
    teams: int
    roster_spots: int
    prior_games: float
    minutes_recency: tuple[float, ...]
    durability_games: float
    recency: tuple[float, ...]
    typical_share: float
    team_change: float
    recent_minutes: float
    # fantasy_return_ramp: minutes cut per team game missed, the most cut, the games back it
    # lasts, and the shortest absence it applies to (0 per game: no ramp)
    ramp_per_game: float = 0.0
    ramp_max: float = 0.0
    ramp_games: int = 2
    ramp_min_missed: int = 3

    @property
    def pool_size(self) -> int:
        return self.teams * self.roster_spots


def load_settings(path: Path = PROJECT_FILE) -> dict[str, Settings]:
    """The fantasy vars of the dbt project, per league."""
    project = yaml.safe_load(path.read_text(encoding="utf-8"))
    v = project["vars"]
    out = {}
    for league, s in v["fantasy"].items():
        out[league] = Settings(
            league=league,
            teams=int(s["teams"]),
            roster_spots=int(s["roster_spots"]),
            prior_games=float(s["prior_games"]),
            minutes_recency=tuple(float(w) for w in s["minutes_recency"]),
            durability_games=float(s["durability_games"]),
            recency=tuple(float(w) for w in v["fantasy_recency"]),
            typical_share=float(v["fantasy_durability"]["typical_share"]),
            team_change=float(v["fantasy_team_change"]),
            recent_minutes=float(v["fantasy_recent_minutes"]),
            ramp_per_game=float(v["fantasy_return_ramp"]["per_game_missed"]),
            ramp_max=float(v["fantasy_return_ramp"]["max_cut"]),
            ramp_games=int(v["fantasy_return_ramp"]["games_back"]),
            ramp_min_missed=int(v["fantasy_return_ramp"]["min_games_missed"]),
        )
    return out


def is_in_sample(league: str, season: str) -> bool:
    return season in TUNING_SEASONS.get(league, frozenset())


def prepare(games: pd.DataFrame) -> pd.DataFrame:
    """Normalise fct_player_game rows: types, played, regular season, starts."""
    g = games.copy()
    g["game_date"] = pd.to_datetime(g["game_date"])
    g["minutes"] = pd.to_numeric(g["minutes"], errors="coerce")
    g["played"] = g["played"].astype("boolean").fillna(False).astype(bool) & (
        g["minutes"].fillna(0) > 0
    )
    g["regular"] = g["game_id"].astype(str).str[2] == "2"
    if "position" in g:
        g["started"] = g["position"].fillna("").astype(str).str.strip() != ""
    for s, col in BOX.items():
        g[s] = pd.to_numeric(g[col], errors="coerce")
    for c in COUNTING:
        g[c] = pd.to_numeric(g[c], errors="coerce")
    return g


def lines(rows: pd.DataFrame) -> pd.DataFrame:
    """Per-player per-game lines over played rows, as mart_category_zscores' windows build them."""
    p = rows[rows["played"]]
    if p.empty:
        return pd.DataFrame(
            columns=[
                "games",
                "total_minutes",
                "minutes_pg",
                *[f"{s}_pg" for s in PRODUCTION],
                "fgm",
                "fga",
                "ftm",
                "fta",
            ]
        )
    grouped = p.groupby("player_id")
    out = pd.DataFrame({"games": grouped.size()})
    out["total_minutes"] = grouped["minutes"].sum()
    out["minutes_pg"] = grouped["minutes"].mean()
    for c in COUNTING:
        out[f"{c}_pg"] = grouped[c].mean()
    for s in BOX:
        out[s] = grouped[s].sum(min_count=1).fillna(0)
    # fgm_pg = field goal pct x attempts per game (0 without attempts), as the projection reads it
    out["fga_pg"] = grouped["fga"].mean()
    out["fta_pg"] = grouped["fta"].mean()
    out["fgm_pg"] = np.where(out["fga"] > 0, out["fgm"] / out["games"], 0.0)
    out["ftm_pg"] = np.where(out["fta"] > 0, out["ftm"] / out["games"], 0.0)
    return out


def category_z(window: pd.DataFrame, pool_size: int) -> pd.DataFrame:
    """mart_category_zscores for one window: z per category over the top players by total minutes."""
    w = window.copy()
    if w.empty:
        w["z_total"] = []
        return w
    order = w.reset_index().sort_values(["total_minutes", "player_id"], ascending=[False, True])
    rank = pd.Series(np.arange(1, len(w) + 1), index=order["player_id"].to_numpy())
    pool = rank.reindex(w.index) <= pool_size
    total = pd.Series(0.0, index=w.index)
    for c in COUNTING:
        x = w[f"{c}_pg"]
        sd = x[pool].std()
        z = (x - x[pool].mean()) / sd if sd and sd > 0 else x * np.nan
        z = -z if c == "turnovers" else z
        w[f"z_{c}"] = z
        total += z.fillna(0)
    for name, made, att, att_pg in (
        ("field_goal_pct", "fgm", "fga", "fga_pg"),
        ("free_throw_pct", "ftm", "fta", "fta_pg"),
    ):
        pool_pct = (
            w.loc[pool, made].sum() / w.loc[pool, att].sum() if w.loc[pool, att].sum() else np.nan
        )
        pct = w[made] / w[att].replace(0, np.nan)
        impact = (pct - pool_pct) * w[att_pg]
        sd = impact[pool].std()
        z = impact / sd if sd and sd > 0 else impact * np.nan
        w[f"z_{name}"] = z
        total += z.fillna(0)
    w["z_total"] = total
    w["in_pool"] = pool
    return w


def _rank(key: pd.Series, ids: pd.Index, eligible: pd.Series | None = None) -> pd.Series:
    """row_number() over (order by key desc, player_id); ineligible rows rank after the rest."""
    frame = pd.DataFrame({"key": key.to_numpy(), "player_id": ids.to_numpy()})
    frame["ineligible"] = 0 if eligible is None else (~eligible.to_numpy()).astype(int)
    frame["key"] = frame["key"].fillna(-np.inf)
    order = frame.sort_values(["ineligible", "key", "player_id"], ascending=[True, False, True])
    rank = np.empty(len(frame), dtype=int)
    rank[order.index.to_numpy()] = np.arange(1, len(frame) + 1)
    return pd.Series(rank, index=ids)


def score(
    proj: pd.DataFrame,
    settings: Settings,
    *,
    first_pass: pd.Series | None = None,
    eligible: pd.Series | None = None,
) -> pd.DataFrame:
    """Value above replacement per category, as mart_board scores the projected lines.

    ``proj`` is indexed by player_id with proj_<stat>_pg columns (and games_share for value_total).
    The first pass ranks by ``first_pass`` (projected minutes per game by default); a player not
    ``eligible`` never enters the pool or the replacement band (used to score realised lines).
    """
    df = proj.copy()
    ids = df.index
    n = len(df)
    out = pd.DataFrame(index=ids)
    if n == 0:
        for c in CATEGORIES:
            out[f"z_{c}"] = []
        out["value_per_game"] = []
        out["value_total"] = []
        out["in_pool"] = []
        out["rank"] = []
        return out
    n_eligible = n if eligible is None else int(eligible.sum())
    pool = min(settings.pool_size, max(n_eligible - settings.teams, 1))
    rank = _rank(df["proj_minutes_pg"] if first_pass is None else first_pass, ids, eligible)
    fg_pct = df["proj_fgm_pg"] / df["proj_fga_pg"].replace(0, np.nan)
    ft_pct = df["proj_ftm_pg"] / df["proj_fta_pg"].replace(0, np.nan)
    z: dict[str, pd.Series] = {}
    for _ in (1, 2):
        in_pool = rank <= pool
        for c in COUNTING:
            x = df[f"proj_{c}_pg"]
            sd = x[in_pool].std()
            zc = ((x - x[in_pool].mean()) / sd) if sd and sd > 0 else pd.Series(0.0, index=ids)
            zc = zc.fillna(0)
            z[c] = -zc if c == "turnovers" else zc
        for name, pct, made, att in (
            ("field_goal_pct", fg_pct, "proj_fgm_pg", "proj_fga_pg"),
            ("free_throw_pct", ft_pct, "proj_ftm_pg", "proj_fta_pg"),
        ):
            denominator = df.loc[in_pool, att].sum()
            pool_pct = df.loc[in_pool, made].sum() / denominator if denominator else np.nan
            impact = ((pct - pool_pct) * df[att]).fillna(0)
            sd = impact[in_pool].std()
            z[name] = (impact / sd).fillna(0) if sd and sd > 0 else pd.Series(0.0, index=ids)
        total = sum(z[c] for c in CATEGORIES)
        rank = _rank(total, ids, eligible)
    band = (rank > pool) & (rank <= pool + settings.teams)
    for c in CATEGORIES:
        replacement = z[c][band].mean() if band.any() else 0.0
        out[f"z_{c}"] = z[c] - (0.0 if pd.isna(replacement) else replacement)
    out["value_per_game"] = out[[f"z_{c}" for c in CATEGORIES]].sum(axis=1)
    if "games_share" in df:
        vpg = out["value_per_game"]
        out["value_total"] = np.where(vpg > 0, vpg * df["games_share"], vpg)
    out["in_pool"] = rank <= pool
    out["rank"] = rank
    return out


@dataclass
class History:
    """Season aggregates of the games before a date."""

    lines: pd.DataFrame  # season, player_id, games, minutes_pg, <stat>_pg
    players: pd.DataFrame  # season, player_id, games_regular, season_team
    team_games: pd.Series  # season -> the most regular-season games any team played


def _aggregate(rows: pd.DataFrame) -> History:
    per_season = []
    for season, part in rows.groupby("season"):
        ln = lines(part)
        if len(ln):
            per_season.append(ln.assign(season=season))
    all_lines = (
        pd.concat(per_season).rename_axis("player_id").reset_index()
        if per_season
        else pd.DataFrame(columns=["player_id", "season", "games", "minutes_pg"])
    )
    played = rows[rows["played"]]
    regular = (
        played[played["regular"]].groupby(["season", "player_id"]).size().rename("games_regular")
    )
    by_team = played.groupby(["season", "player_id", "team_id"]).size().rename("n").reset_index()
    by_team = by_team.sort_values(
        ["season", "player_id", "n", "team_id"], ascending=[True, True, False, True]
    )
    main_team = (
        by_team.drop_duplicates(["season", "player_id"])
        .set_index(["season", "player_id"])["team_id"]
        .rename("season_team")
    )
    players = pd.concat([regular, main_team], axis=1).reset_index()
    if players.empty:
        players = pd.DataFrame(columns=["season", "player_id", "games_regular", "season_team"])
    reg = rows[rows["regular"]]
    team_games = reg.groupby(["season", "team_id"])["game_id"].nunique().groupby("season").max()
    return History(all_lines, players, team_games)


class Replay:
    """The board for one league, as of any date, from that league's fct_player_game rows."""

    def __init__(self, games: pd.DataFrame, settings: Settings) -> None:
        self.settings = settings
        self.games = prepare(games) if "regular" not in games else games
        self._season_end = self.games.groupby("season")["game_date"].max()
        self._season_start = self.games.groupby("season")["game_date"].min()
        self._cache: dict[str, History] = {}

    def seasons(self) -> list[str]:
        return sorted(self.games["season"].unique())

    def history(self, as_of: pd.Timestamp) -> History:
        """Aggregates of every game before ``as_of``; whole seasons are computed once."""
        parts = []
        for season, end in self._season_end.items():
            key = str(season)
            if self._season_start[season] >= as_of:
                continue
            if end < as_of:
                if key not in self._cache:
                    self._cache[key] = _aggregate(self.games[self.games["season"] == season])
                parts.append(self._cache[key])
            else:
                g = self.games
                parts.append(_aggregate(g[(g["season"] == season) & (g["game_date"] < as_of)]))
        if not parts:
            return _aggregate(self.games.iloc[0:0])
        return History(
            pd.concat([p.lines for p in parts], ignore_index=True),
            pd.concat([p.players for p in parts], ignore_index=True),
            pd.concat([p.team_games for p in parts]),
        )

    def replacement_line(self, hist: History, reference: str) -> pd.Series:
        """The average line of the players ranked just outside the pool by total minutes."""
        s = self.settings
        ref = hist.lines[hist.lines["season"] == reference].copy()
        ref["tm"] = ref["games"] * ref["minutes_pg"]
        ref = ref.sort_values(["tm", "player_id"], ascending=[False, True]).iloc[
            s.pool_size : s.pool_size + s.teams
        ]
        return ref[["minutes_pg", *[f"{p}_pg" for p in PRODUCTION]]].mean()

    def project(
        self,
        as_of: pd.Timestamp | str,
        roster: pd.DataFrame,
        *,
        in_season: bool,
        complete_seasons: Iterable[str] = (),
    ) -> pd.DataFrame:
        """mart_player_projection as of a date, for ``roster`` (player_id, team_id).

        ``in_season`` is whether the current season has regular-season games left (the recent
        minutes blend applies only then); ``complete_seasons`` are the seasons whose regular
        season had ended by ``as_of`` (the replacement line comes from the latest of them).
        """
        s = self.settings
        as_of = pd.Timestamp(as_of)
        hist = self.history(as_of)
        if hist.lines.empty or roster.empty:
            return pd.DataFrame()
        ordered = sorted(hist.lines["season"].unique(), reverse=True)
        rank_of = {season: i + 1 for i, season in enumerate(ordered)}
        current = ordered[0]
        complete = [x for x in complete_seasons if x in rank_of]
        reference = max(complete) if complete else (ordered[1] if len(ordered) > 1 else current)
        prior = self.replacement_line(hist, reference)
        if prior.isna().any():
            # fewer players than pool + teams in the reference season: use what there is
            prior = hist.lines[hist.lines["season"] == reference][
                ["minutes_pg", *[f"{p}_pg" for p in PRODUCTION]]
            ].mean()

        team = roster.drop_duplicates("player_id").set_index("player_id")["team_id"]
        ln = hist.lines[hist.lines["player_id"].isin(team.index)].copy()
        ln["season_rank"] = ln["season"].map(rank_of)
        ln = ln[(ln["season_rank"] <= 3) & (ln["games"] > 0)]
        if ln.empty:
            return pd.DataFrame()
        ln["r"] = ln["season_rank"].map(lambda k: s.recency[k - 1] if k <= len(s.recency) else 0.0)
        ln["mr"] = ln["season_rank"].map(
            lambda k: s.minutes_recency[k - 1] if k <= len(s.minutes_recency) else 0.0
        )
        ln = ln.merge(hist.players, on=["season", "player_id"], how="left")
        moved = (
            (ln["season_rank"] > 1)
            & ln["season_team"].notna()
            & (ln["season_team"] != ln["player_id"].map(team))
        )
        ln["role"] = np.where(moved, s.team_change, 1.0)
        ln["games_regular"] = pd.to_numeric(ln["games_regular"]).fillna(0)
        ln["team_games"] = ln["season"].map(hist.team_games).fillna(0)
        ln["minutes_pg"] = ln["minutes_pg"].fillna(0)

        g = ln.groupby("player_id")
        w = pd.DataFrame(index=g.size().index)
        for k, name in ((1, "games_current"), (2, "games_prev"), (3, "games_prev2")):
            w[name] = ln[ln["season_rank"] == k].groupby("player_id")["games"].sum()
        w = w.fillna(0)
        w["minutes_games_weight"] = (
            (ln["mr"] * ln["role"] * ln["games"]).groupby(ln["player_id"]).sum()
        )
        w["minutes_weighted"] = (
            (ln["mr"] * ln["role"] * ln["games"] * ln["minutes_pg"]).groupby(ln["player_id"]).sum()
        )
        w["rate_weight"] = (ln["r"] * ln["games"] * ln["minutes_pg"]).groupby(ln["player_id"]).sum()
        w["regular_games_weight"] = (ln["r"] * ln["games_regular"]).groupby(ln["player_id"]).sum()
        w["team_games_weight"] = (
            (ln["r"] * ln["team_games"])
            .where(ln["games_regular"] > 0, 0)
            .groupby(ln["player_id"])
            .sum()
        )
        for p in PRODUCTION:
            w[f"wsum_{p}"] = (
                (ln["r"] * ln["games"] * ln[f"{p}_pg"].fillna(0)).groupby(ln["player_id"]).sum()
            )

        k = s.prior_games
        base = (w["minutes_weighted"] + k * prior["minutes_pg"]) / (w["minutes_games_weight"] + k)
        recent = self._recent_minutes(as_of, current, team)
        w["minutes_last5_pg"] = recent["mean"].reindex(w.index)
        blend = in_season & (recent["n"].reindex(w.index).fillna(0) >= 5)
        w["proj_minutes_season_pg"] = base
        blended = np.where(
            blend, (1 - s.recent_minutes) * base + s.recent_minutes * w["minutes_last5_pg"], base
        )
        # a return from an absence: in season, with 5+ games this season, minutes are cut by
        # ramp_per_game per team game missed (at most ramp_max) while the player is still out,
        # fading to none once they have played ramp_games games back
        last_team = hist.players[hist.players["season"] == ordered[1]] if len(ordered) > 1 else None
        prev_team = (
            last_team.set_index("player_id")["season_team"]
            if last_team is not None
            else pd.Series(dtype=object)
        )
        absence = self.absence(as_of, current, team, prev_team)
        w["absence_games"] = absence["absence_games"].reindex(w.index)
        w["games_since_return"] = absence["games_since_return"].reindex(w.index)
        w["return_minutes_factor"] = ramp_factor(
            w["absence_games"], w["games_since_return"], s
        ).where(in_season & (w["games_current"] >= 5), 1.0)
        w["proj_minutes_pg"] = blended * w["return_minutes_factor"]
        w["games_share"] = np.minimum(
            1.0,
            (w["regular_games_weight"] + s.durability_games * s.typical_share)
            / (w["team_games_weight"] + s.durability_games),
        )
        prior_minutes = k * prior["minutes_pg"]
        denominator = (w["rate_weight"] + prior_minutes).replace(0, np.nan)
        for p in PRODUCTION:
            w[f"proj_{p}_pg"] = (
                (w[f"wsum_{p}"] + k * prior[f"{p}_pg"]) / denominator * w["proj_minutes_pg"]
            )
        w["proj_field_goal_pct"] = w["proj_fgm_pg"] / w["proj_fga_pg"].replace(0, np.nan)
        w["proj_free_throw_pct"] = w["proj_ftm_pg"] / w["proj_fta_pg"].replace(0, np.nan)
        w["w_prior"] = prior_minutes / denominator
        w["team_id"] = team.reindex(w.index)
        w["season"] = current
        w["reference_season"] = reference
        return w.drop(columns=[c for c in w.columns if c.startswith("wsum_")])

    def absence(
        self, as_of: pd.Timestamp, season: str, team: pd.Series, prev_team: pd.Series
    ) -> pd.DataFrame:
        """Each player's latest absence from their current team, before ``as_of``.

        An absence is a run of consecutive games of the player's current team (``team``) in
        ``season`` that the player did not play, of at least ``ramp_min_missed`` games. The team's games
        count from the player's first game for it this season, or from its first game when it was
        their main team last season (``prev_team``), so an injury carried over from last season counts.
        Returns ``absence_games`` (the run's length) and ``games_since_return`` (their games
        for the team after it; 0 while still out), for players with such an absence.
        """
        empty = pd.DataFrame(columns=["absence_games", "games_since_return"], dtype=float)
        g = self.games
        rows = g[(g["season"] == season) & (g["game_date"] < as_of)]
        if rows.empty or team.empty:
            return empty
        team_games = rows.drop_duplicates(["team_id", "game_id"])[
            ["team_id", "game_id", "game_date"]
        ]
        slots = team.rename("team_id").rename_axis("player_id").reset_index().merge(team_games)
        played = rows.loc[rows["played"], ["player_id", "team_id", "game_id"]].drop_duplicates()
        slots = slots.merge(played.assign(p=True), how="left")
        slots["p"] = slots["p"].astype("boolean").fillna(False).astype(bool)
        slots = slots.sort_values(["player_id", "game_date", "game_id"])
        slots["played_before"] = slots.groupby("player_id")["p"].cumsum()
        counted = (slots["played_before"] > 0) | (
            slots["player_id"].map(prev_team) == slots["team_id"]
        )
        slots = slots[counted]
        runs = (
            slots[~slots["p"]]
            .groupby(["player_id", "played_before"])
            .size()
            .rename("absence_games")
            .reset_index()
        )
        runs = runs[runs["absence_games"] >= self.settings.ramp_min_missed]
        if runs.empty:
            return empty
        latest = (
            runs.sort_values("played_before").groupby("player_id").tail(1).set_index("player_id")
        )
        total = slots.groupby("player_id")["p"].sum()
        latest["games_since_return"] = total.reindex(latest.index) - latest["played_before"]
        return latest[["absence_games", "games_since_return"]].astype(float)

    def _recent_minutes(self, as_of: pd.Timestamp, season: str, team: pd.Series) -> pd.DataFrame:
        g = self.games
        rows = g[(g["season"] == season) & (g["game_date"] < as_of) & g["played"]]
        rows = rows[rows["player_id"].map(team) == rows["team_id"]]
        rows = rows.sort_values(["game_date", "game_id"]).groupby("player_id").tail(5)
        return (
            rows.groupby("player_id")["minutes"].agg(["mean", "size"]).rename(columns={"size": "n"})
        )

    def board(
        self,
        as_of: pd.Timestamp | str,
        roster: pd.DataFrame,
        *,
        in_season: bool,
        complete_seasons: Iterable[str] = (),
    ) -> pd.DataFrame:
        """The projection with mart_board's values joined (value_per_game, value_total, rank)."""
        proj = self.project(as_of, roster, in_season=in_season, complete_seasons=complete_seasons)
        if proj.empty:
            return proj
        valued = score(proj, self.settings)
        out = proj.join(valued)
        out["rank_total"] = out["value_total"].rank(ascending=False, method="first")
        return out

    # --- the replay's checkpoints and targets ---

    def roster_at(self, season: str, as_of: pd.Timestamp, *, preseason: bool) -> pd.DataFrame:
        """Who a manager could see on a roster on ``as_of``: listed in a box score (played or not).

        Mid-season, the players listed in the 21 days before, on their latest team. Before a
        season, the players listed in its first seven days: the opening rosters, which are known
        before tip-off (a listing is not an outcome, and a player who never plays still counts).
        """
        g = self.games[self.games["season"] == season]
        if preseason:
            rows = g[g["game_date"] < as_of + pd.Timedelta(days=7)]
            rows = rows.sort_values(["game_date", "game_id"]).drop_duplicates("player_id")
        else:
            rows = g[(g["game_date"] < as_of) & (g["game_date"] >= as_of - pd.Timedelta(days=21))]
            rows = rows.sort_values(["game_date", "game_id"]).drop_duplicates(
                "player_id", keep="last"
            )
        return rows[["player_id", "team_id"]].reset_index(drop=True)

    def checkpoints(self, season: str) -> list[tuple[str, pd.Timestamp]]:
        """Before the season and a tenth, a quarter and half way through its regular season."""
        g = self.games
        dates = np.sort(g.loc[(g["season"] == season) & g["regular"], "game_date"].unique())
        if len(dates) < 10:
            return []
        has_history = (g["season"] < season).any()
        out = []
        for label, frac in CHECKPOINTS:
            if frac == 0.0 and not has_history:
                continue
            out.append((label, pd.Timestamp(dates[int(len(dates) * frac)])))
        return out

    def realised(self, season: str, start: pd.Timestamp, roster: pd.DataFrame) -> pd.DataFrame:
        """What each roster player went on to produce in the rest of the regular season.

        The realised lines are scored like projections, over the realised pool: first by total
        minutes, then by value, among players with at least a fifth of the team games left (and 3);
        anyone with fewer games still gets a value per game against that pool and replacement.
        ``value_pg`` is per game played (NaN without games); ``value_total`` counts every team
        game, a missed game as zero (value per game x share of the team's remaining games).
        """
        g = self.games
        rest = g[(g["season"] == season) & g["regular"] & (g["game_date"] >= start)]
        team_left = rest.groupby("team_id")["game_id"].nunique()
        ln = lines(rest)
        out = pd.DataFrame(index=pd.Index(roster["player_id"].drop_duplicates(), name="player_id"))
        out["team_games_left"] = (
            roster.drop_duplicates("player_id").set_index("player_id")["team_id"].map(team_left)
        )
        if ln.empty:
            out["games"] = 0
            out["value_pg"] = np.nan
            out["value_total"] = 0.0
            out["share"] = 0.0
            out["eligible"] = False
            return out
        proj = ln.rename(columns={f"{p}_pg": f"proj_{p}_pg" for p in [*PRODUCTION, "minutes"]})
        min_games = max(3, math.ceil(0.2 * float(team_left.median())))
        eligible = ln["games"] >= min_games
        valued = score(proj, self.settings, first_pass=ln["total_minutes"], eligible=eligible)
        out["games"] = ln["games"].reindex(out.index).fillna(0).astype(int)
        out["value_pg"] = valued["value_per_game"].reindex(out.index)
        out["eligible"] = eligible.reindex(out.index).fillna(False).astype(bool)
        out["share"] = (out["games"] / out["team_games_left"]).clip(upper=1).fillna(0)
        out["value_total"] = (out["value_pg"] * out["share"]).fillna(0)
        return out


def ramp_factor(absence_games: pd.Series, games_since_return: pd.Series, s: Settings) -> pd.Series:
    """The share of projected minutes kept after an absence (``fantasy_return_ramp``).

    ``ramp_per_game`` per game missed, at most ``ramp_max``, in full while the player is still out
    (no games back yet), fading linearly to nothing once they have played ``ramp_games`` games back;
    1 for a player with no absence (NaN).
    """
    cut = np.minimum(s.ramp_max, s.ramp_per_game * absence_games)
    fade = np.maximum(0.0, 1 - games_since_return / s.ramp_games)
    return (1 - cut * fade).fillna(1.0)


def baseline(replay: Replay, rows: pd.DataFrame, roster: pd.DataFrame) -> pd.Series:
    """Value per game above replacement of plain per-game lines (no prior, no blend)."""
    ln = lines(rows)
    ln = ln[ln.index.isin(roster["player_id"])]
    if len(ln) < 2:
        return pd.Series(dtype=float)
    proj = ln.rename(columns={f"{p}_pg": f"proj_{p}_pg" for p in [*PRODUCTION, "minutes"]})
    return score(proj, replay.settings)["value_per_game"]


# --- metrics ---


def average_rank(x: np.ndarray) -> np.ndarray:
    """Ranks from 1 with ties averaged (as scipy.stats.rankdata, without scipy)."""
    x = np.asarray(x, dtype=float)
    sorter = np.argsort(x, kind="mergesort")
    inverse = np.empty(len(x), dtype=int)
    inverse[sorter] = np.arange(len(x))
    xs = x[sorter]
    first = np.r_[True, xs[1:] != xs[:-1]]
    dense = first.cumsum()[inverse]
    bounds = np.r_[np.flatnonzero(first), len(x)]
    return 0.5 * (bounds[dense] + bounds[dense - 1] + 1)


def spearman(a: np.ndarray, b: np.ndarray) -> float:
    """Spearman rank correlation over the pairs where both are finite."""
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < 3:
        return float("nan")
    ra, rb = average_rank(a[ok]), average_rank(b[ok])
    if ra.std() == 0 or rb.std() == 0:
        return float("nan")
    return float(np.corrcoef(ra, rb)[0, 1])


def top_hits(pred: np.ndarray, target: np.ndarray, n: int) -> float:
    """Share of the predicted top n that finish in the realised top n (NaN never finishes there)."""
    n = min(n, len(pred))
    if n == 0:
        return float("nan")
    t = np.where(np.isfinite(target), target, -np.inf)
    p = np.where(np.isfinite(pred), pred, -np.inf)
    top_p = np.argsort(-p, kind="mergesort")[:n]
    top_t = np.argsort(-t, kind="mergesort")[:n]
    return len(np.intersect1d(top_p, top_t)) / n


def capture(pred: np.ndarray, total: np.ndarray, n: int) -> float:
    """Realised value of the predicted top n over that of the realised top n."""
    n = min(n, len(pred))
    p = np.where(np.isfinite(pred), pred, -np.inf)
    best = np.sort(total)[::-1][:n].sum()
    if n == 0 or best <= 0:
        return float("nan")
    return float(total[np.argsort(-p, kind="mergesort")[:n]].sum() / best)


def evaluate(
    pred_pg: np.ndarray,
    pred_total: np.ndarray,
    value_pg: np.ndarray,
    eligible: np.ndarray,
    value_total: np.ndarray,
    n: int,
) -> dict[str, float]:
    """The backtest's metrics for one checkpoint and method.

    Per game: against realised value per game, for players with enough games to have one (the
    only place the future enters, as the definition of a rate). Total: against value counting a
    missed game as zero, defined for every player on the roster, so nothing is conditioned on
    who went on to play.
    """
    target_pg = np.where(eligible, value_pg, np.nan)
    ok = np.isfinite(target_pg)
    return {
        "top_pg": top_hits(pred_pg, target_pg, n),
        "spearman_pg": spearman(pred_pg, target_pg),
        "mae_pg": float(np.mean(np.abs(pred_pg[ok] - target_pg[ok]))) if ok.any() else np.nan,
        "top_total": top_hits(pred_total, value_total, n),
        "spearman_total": spearman(pred_total, value_total),
        "mae_total": float(np.mean(np.abs(pred_total - value_total)))
        if len(pred_total)
        else np.nan,
        "capture": capture(pred_total, value_total, n),
    }


def bootstrap(
    frames: list[dict[str, Any]], n: int, *, reps: int = 200, seed: int = 7
) -> pd.DataFrame:
    """Player-bootstrap replicates of every metric: one row per replicate, checkpoint and method.

    Each frame is one checkpoint: ``player_id``, ``pred`` ({method: (per game, total)}),
    ``value_pg``, ``eligible`` and ``value_total`` arrays. A replicate draws Poisson(1) weights
    per player, the same across checkpoints, since a player recurs from one to the next.
    """
    rng = np.random.default_rng(seed)
    players = sorted({p for f in frames for p in f["player_id"]})
    index = {p: i for i, p in enumerate(players)}
    position = [np.array([index[p] for p in f["player_id"]], dtype=int) for f in frames]
    rows = []
    for rep in range(reps):
        weights = rng.poisson(1.0, len(players))
        for k, f in enumerate(frames):
            take = np.repeat(np.arange(len(position[k])), weights[position[k]])
            if len(take) < 5:
                continue
            for method, (p_pg, p_total) in f["pred"].items():
                metrics = evaluate(
                    p_pg[take],
                    p_total[take],
                    f["value_pg"][take],
                    f["eligible"][take],
                    f["value_total"][take],
                    n,
                )
                rows.append({"rep": rep, "frame": k, "method": method, **metrics})
    return pd.DataFrame(rows)
