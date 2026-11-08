"""The player-game helpers the notebooks share, and the build's own value scale.

The notebooks read ``fct_player_game`` and measure what a game adds in the units every value on
the site is measured in. They do not re-implement the board: the scale is read from the build
(``value_scale``), and the board is judged point in time by ``ops.walk_forward`` on rebuilt
lakehouses (ADR 0018), which retired the pandas replay of the projection (#776).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import pandas as pd
import yaml

ROOT = Path(__file__).resolve().parent.parent
PROJECT_FILE = ROOT / "dbt" / "dbt_project.yml"

# Box-score columns the notebooks read from fct_player_game (read only these: the table is large).
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
BOX = {
    "fgm": "field_goals_made",
    "fga": "field_goals_attempted",
    "ftm": "free_throws_made",
    "fta": "free_throws_attempted",
}
SHOOTING = (("field_goal_pct", "fgm", "fga"), ("free_throw_pct", "ftm", "fta"))


def pool_size(league: str, path: Path = PROJECT_FILE) -> int:
    """The default league's rostered pool, teams x roster spots (the ``fantasy`` var)."""
    s = yaml.safe_load(path.read_text(encoding="utf-8"))["vars"]["fantasy"][league]
    return int(s["teams"]) * int(s["roster_spots"])


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
    """Per-player per-game lines over played rows, as int_player_window_lines builds a window.

    A missing box-score number in a game played counts as zero, as the lakehouse counts it.
    """
    p = rows[rows["played"]]
    stats = [*COUNTING, *BOX]
    cols = ["games", "total_minutes", "minutes_pg", *[f"{s}_pg" for s in stats]]
    if p.empty:
        return pd.DataFrame(columns=cols)
    filled = p[stats].fillna(0).assign(player_id=p["player_id"], minutes=p["minutes"])
    grouped = filled.groupby("player_id")
    out = pd.DataFrame({"games": grouped.size()})
    out["total_minutes"] = grouped["minutes"].sum()
    out["minutes_pg"] = grouped["minutes"].mean()
    for s in stats:
        out[f"{s}_pg"] = grouped[s].mean()
    return out


def value_scale(con: duckdb.DuckDBPyConnection, league: str) -> dict[str, dict[str, Any]]:
    """The build's value scale per season (int_value_scale, ADR 0019), read off its scored lines.

    mart_category_zscores scores each season's line on the scale: a counting category is
    (x - pool mean) / pool sd less replacement, turnovers negative, and shooting is
    (makes - pool percentage x attempts) / the impact's spread less replacement. Each is affine
    in the line, so a least-squares fit over the season's players recovers it exactly: a weight
    per counting category (``counting``), a weight on makes and on attempts per shooting
    category (``shooting``), and the value of an empty line (``base``). The published build
    ships the scored lines but not the scale itself, so this reads the scale every value on the
    site is measured on rather than re-implementing it.
    """
    zs = [f"z_{c}" for c in (*COUNTING, "field_goal_pct", "free_throw_pct")]
    pgs = [f"{c}_pg" for c in COUNTING]
    df = con.sql(
        f"select season, {', '.join(pgs)}, field_goal_pct, fga_pg, free_throw_pct, fta_pg, "
        f"{', '.join(zs)} from mart_category_zscores "
        f"where window_name = 'season' and league = '{league}'"
    ).df()
    out: dict[str, dict[str, Any]] = {}
    for season, rows in df.groupby("season"):
        part = rows.drop(columns="season").astype(float)
        if len(part) < 3:
            continue
        scale: dict[str, Any] = {"counting": {}, "shooting": {}, "base": 0.0}
        for c in COUNTING:
            x = part[f"{c}_pg"].fillna(0).to_numpy()
            a, b = np.linalg.lstsq(
                np.c_[x, np.ones(len(x))], part[f"z_{c}"].to_numpy(), rcond=None
            )[0]
            scale["counting"][c] = float(a)
            scale["base"] += float(b)
        for name, _, att in SHOOTING:
            attempts = part[f"{att}_pg"].fillna(0).to_numpy()
            makes = (part[name].fillna(0) * part[f"{att}_pg"].fillna(0)).to_numpy()
            x = np.c_[makes, attempts, np.ones(len(part))]
            a, b, c0 = np.linalg.lstsq(x, part[f"z_{name}"].to_numpy(), rcond=None)[0]
            scale["shooting"][name] = (float(a), float(b))
            scale["base"] += float(c0)
        out[str(season)] = scale
    return out


def contribution(rows: pd.DataFrame, scale: dict[str, Any], suffix: str = "") -> pd.Series:
    """What each row adds on the scale, without replacement level: a game's counting stats and
    shooting (columns ``<category><suffix>``, fgm, fga, ftm, fta) in the scale's units.

    Summed over a week's games it is what the games add to the week's category totals; a game not
    played adds nothing.
    """
    v = pd.Series(0.0, index=rows.index)
    for c, w in scale["counting"].items():
        v += w * rows[f"{c}{suffix}"].fillna(0)
    for name, made, att in SHOOTING:
        w_made, w_att = scale["shooting"][name]
        v += w_made * rows[f"{made}{suffix}"].fillna(0) + w_att * rows[f"{att}{suffix}"].fillna(0)
    return v


def line_value(ln: pd.DataFrame, scale: dict[str, Any]) -> pd.Series:
    """A per-game line's value above replacement on the scale (mart_category_zscores' z_total)."""
    return contribution(ln, scale, suffix="_pg") + scale["base"]


def ols(x: np.ndarray, y: np.ndarray, w: np.ndarray | None = None) -> np.ndarray:
    """Least-squares coefficients, weighted by ``w`` when given (a bootstrap passes resample counts)."""
    if w is not None:
        s = np.sqrt(w)
        x, y = x * s[:, None], y * s
    return np.linalg.lstsq(x, y, rcond=None)[0]


def finished(games: pd.DataFrame) -> list[str]:
    """The seasons that are over: every one but the latest, and the latest once it has playoff games.

    ``games`` has a ``season`` and a ``regular`` column (false for a playoff game).
    """
    seasons = sorted(games["season"].unique())
    playoffs = set(games.loc[~games["regular"], "season"])
    return [s for i, s in enumerate(seasons) if s in playoffs or i < len(seasons) - 1]


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
