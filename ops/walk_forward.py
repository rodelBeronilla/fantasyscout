"""Walk-forward backtest of the board (#769 stage 2, #796).

    uv run python -m ops.walk_forward --league nba --season 2024-25 --out findings.json

For a league-season, the lakehouse is rebuilt as it stood at checkpoints through the season
(point-in-time builds, ADR 0018): the first game day, and a tenth, a quarter and half of the way
to the last (``backtest.checkpoints``). At each one the board's value per game above replacement
(``mart_board.z_total``) is judged against what each player then did in the rest of the regular
season, scored on that checkpoint's own value scale (ADR 0019), so the two are in the same units.
The baseline is a naive manager: the player's season so far on the same scale, or last season's
line before he has played. The market is a second baseline: ESPN's preseason draft order
(silver.espn_preseason_adp, #805), known from the season's first game and judged at every
checkpoint, where it shows how fast the draft goes stale. It is a ranking with no values, an
undrafted player below every drafted one. Over the players who then played at least
``backtest.min_games``:

- error of value per game (RMSE, MAE) of the board and of the naive manager;
- rank agreement with the realized values (Spearman), for the market too where it has one;
- how much of the realized top pool (the scale's pool size) each one put in its own;
- a paired bootstrap interval of the board's RMSE minus the naive manager's (players resampled,
  ``backtest.bootstrap`` times): below zero, the board beat the baseline.

With ``--market-prior`` the board is judged twice at each checkpoint: as built, and with the
market prior on (the ``market_prior`` var, #832), mart_board rebuilt from the same cut. For each the
run reports RMSE, Spearman and top-pool share, with the paired bootstrap interval of on minus off,
and checks that the prior's value is the one ``blend`` computes from the first build's columns.
``--players-out`` writes every judged player's figures, which ops.market_prior_fit fits the prior
on, for the tuning seasons only.

The held-out seasons (NBA 2025-26, WNBA 2026) are judged once, at the end of the plan (#751); the
harness refuses them unless ``--judge-locked`` says this is that judgement.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import pandas as pd

from ops import parameters

ROOT = Path(__file__).resolve().parent.parent
DBT = ROOT / "dbt"
LOCKED = {"nba": "2025-26", "wnba": "2026"}
COUNTING = (
    "points",
    "rebounds_total",
    "assists",
    "steals",
    "blocks",
    "three_pointers_made",
    "turnovers",
)


def _params() -> dict[str, Any]:
    return {p["id"]: p["value"] for p in parameters.load()}


def score_sql(line: str, scale: str) -> str:
    """The value per game above replacement of a line on a scale, as macros/value_scale.sql has it.

    ``line`` has <category>_pg and fgm_pg, fga_pg, ftm_pg, fta_pg; ``scale`` is an int_value_scale
    row. A test holds the two equal.
    """
    terms = []
    for c in COUNTING:
        z = f"coalesce(({line}.{c}_pg - {scale}.mean_{c}) / nullif({scale}.sd_{c}, 0), 0)"
        terms.append(f"{'-' if c == 'turnovers' else ''}{z} - {scale}.repl_z_{c}")
    terms.append(
        f"coalesce(({line}.fgm_pg - {scale}.pool_field_goal_pct * {line}.fga_pg)"
        f" / nullif({scale}.sd_fg_impact, 0), 0) - {scale}.repl_z_field_goal_pct"
    )
    terms.append(
        f"coalesce(({line}.ftm_pg - {scale}.pool_free_throw_pct * {line}.fta_pg)"
        f" / nullif({scale}.sd_ft_impact, 0), 0) - {scale}.repl_z_free_throw_pct"
    )
    return " + ".join(f"({t})" for t in terms)


def checkpoints(first: date, last: date, fractions: list[float]) -> list[date]:
    """The cut dates: the first game day plus each fraction of the way to the last."""
    span = (last - first).days
    return [first + timedelta(days=round(f * span)) for f in fractions]


def _season_span(full: duckdb.DuckDBPyConnection, league: str, season: str) -> tuple[date, date]:
    row = full.execute(
        "select min(game_date_est), max(game_date_est) from silver.schedule"
        " where league = ? and season = ? and game_type = 'regular'",
        [league, season],
    ).fetchone()
    if not row or row[0] is None:
        msg = f"no regular season {league} {season} in the build"
        raise SystemExit(msg)
    return row[0], row[1]


def _vars(as_of: date, prior: dict[str, Any] | None = None) -> str:
    out: dict[str, Any] = {"as_of": as_of.isoformat(), "point_in_time": True}
    if prior is not None:
        out["market_prior"] = prior
    return json.dumps(out)


def _build(as_of: date, db: Path) -> None:
    cmd = [
        "dbt", "build", "--target", "duckdb", "--full-refresh", "--exclude", "tag:quality",
        "--exclude-resource-type", "unit_test", "--exclude-resource-type", "test",
        "--vars", _vars(as_of),
    ]  # fmt: skip
    _dbt(cmd, db, as_of)


def _rebuild_board(as_of: date, db: Path, prior: dict[str, Any]) -> None:
    """Rebuild only mart_board in a copy of a checkpoint's build, with the market prior given."""
    cmd = [
        "dbt", "run", "--target", "duckdb", "--full-refresh", "--select", "mart_board",
        "--vars", _vars(as_of, prior),
    ]  # fmt: skip
    _dbt(cmd, db, as_of)


def _dbt(cmd: list[str], db: Path, as_of: date) -> None:
    env = {**os.environ, "DBT_DUCKDB_PATH": str(db), "DBT_PROFILES_DIR": "."}
    run = subprocess.run(cmd, cwd=DBT, env=env, capture_output=True, text=True, check=False)
    if run.returncode != 0:
        tail = f"{run.stdout[-3000:]}\n{run.stderr[-1000:]}"
        msg = f"the point-in-time build as of {as_of} failed:\n{tail}"
        raise SystemExit(msg)


def frame(cut: duckdb.DuckDBPyConnection, league: str, season: str, as_of: date) -> Any:
    """Per board player: the board's, the naive manager's and the realized value per game, and
    realized games, all on the board's scale. ``cut`` has the full build attached as ``whole``."""
    realized_line = ", ".join(
        [f"avg(coalesce({c}, 0)) as {c}_pg" for c in COUNTING]
        + [
            "avg(coalesce(field_goals_made, 0)) as fgm_pg",
            "avg(coalesce(field_goals_attempted, 0)) as fga_pg",
            "avg(coalesce(free_throws_made, 0)) as ftm_pg",
            "avg(coalesce(free_throws_attempted, 0)) as fta_pg",
        ]
    )
    sql = f"""
        with board as (
            select league, season, player_id, z_total as board_value, market_prior_value,
                market_prior_games
            from gold.mart_board where league = $league
        ),
        scale as (
            select s.* from gold.int_value_scale as s
            join (select distinct league, season from board) as b
                on b.league = s.league and b.season = s.season
        ),
        naive_line as (
            -- the season so far, else the latest earlier season (the cut's own lines)
            select * from gold.int_player_window_lines
            where league = $league and window_name = 'season' and season <= $season
            qualify row_number() over (partition by player_id order by season desc) = 1
        ),
        market as (
            -- the season's preseason draft order, known the day before its first game (#786)
            select x.stats_player_id as player_id, min(a.adp_rank) as adp_rank
            from silver.espn_preseason_adp as a
            join silver.player_xwalk as x
                on x.league = a.league and x.espn_player_id = a.espn_player_id
            where a.league = $league and a.season = $season
            group by x.stats_player_id
        ),
        realized_line as (
            select player_id, count(*) as games, {realized_line}
            from whole.gold.fct_player_game
            where league = $league and season = $season and played
                and substr(game_id, 3, 1) = '2' and game_date >= $as_of
            group by player_id
        )
        select
            b.player_id,
            b.board_value,
            b.market_prior_value,
            b.market_prior_games,
            {score_sql("n", "s")} as naive_value,
            {score_sql("r", "s")} as realized_value,
            coalesce(r.games, 0) as realized_games,
            m.adp_rank,
            s.pool
        from board as b
        cross join scale as s
        left join naive_line as n on n.player_id = b.player_id
        left join realized_line as r on r.player_id = b.player_id
        left join market as m on m.player_id = b.player_id
    """
    params = {"league": league, "season": season, "as_of": as_of}
    return cut.execute(sql, params).fetchdf()


@dataclass(frozen=True)
class Checkpoint:
    as_of: str
    players: int
    rmse_board: float
    rmse_naive: float
    mae_board: float
    mae_naive: float
    spearman_board: float
    spearman_naive: float
    top_pool_board: float
    top_pool_naive: float
    # the preseason draft order's, null for a season without one (past WNBA seasons)
    spearman_market: float | None
    top_pool_market: float | None
    rmse_gap: float
    rmse_gap_low: float
    rmse_gap_high: float


def _rank(x: np.ndarray) -> np.ndarray:
    order = np.argsort(x, kind="stable")
    ranks = np.empty(len(x))
    ranks[order] = np.arange(len(x))
    return ranks


def _spearman(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.corrcoef(_rank(a), _rank(b))[0, 1]) if len(a) > 2 else math.nan


def _top_share(pred: np.ndarray, real: np.ndarray, pool: int) -> float:
    k = min(pool, len(real))
    if k == 0:
        return math.nan
    top_real = set(np.argsort(-real, kind="stable")[:k])
    top_pred = set(np.argsort(-pred, kind="stable")[:k])
    return len(top_real & top_pred) / k


def judge(df: Any, as_of: date, *, min_games: int, resamples: int, seed: int = 0) -> Checkpoint:
    """The checkpoint's figures over the players who then played at least ``min_games``."""
    q = df[df["realized_games"] >= min_games]
    board, naive = q["board_value"].to_numpy(float), q["naive_value"].fillna(0).to_numpy(float)
    real = q["realized_value"].to_numpy(float)
    pool = int(df["pool"].iloc[0]) if len(df) else 0
    err_b, err_n = board - real, naive - real
    ranks = q.get("adp_rank")
    has_market = ranks is not None and bool(ranks.notna().any())
    # a market score: the earlier the pick the higher; an undrafted player below every pick
    market = (
        -ranks.fillna(ranks.max() + 1).to_numpy(float) if has_market and ranks is not None else None
    )

    def rmse(e: np.ndarray) -> float:
        return float(np.sqrt(np.mean(e**2))) if len(e) else math.nan

    rng = np.random.default_rng(seed)
    gaps = []
    for _ in range(resamples if len(q) else 0):
        i = rng.integers(0, len(q), len(q))
        gaps.append(rmse(err_b[i]) - rmse(err_n[i]))
    low, high = np.percentile(gaps, [2.5, 97.5]) if gaps else (math.nan, math.nan)
    return Checkpoint(
        as_of=as_of.isoformat(),
        players=len(q),
        rmse_board=rmse(err_b),
        rmse_naive=rmse(err_n),
        mae_board=float(np.mean(np.abs(err_b))) if len(q) else math.nan,
        mae_naive=float(np.mean(np.abs(err_n))) if len(q) else math.nan,
        spearman_board=_spearman(board, real),
        spearman_naive=_spearman(naive, real),
        top_pool_board=_top_share(board, real, pool),
        top_pool_naive=_top_share(naive, real, pool),
        spearman_market=_spearman(market, real) if market is not None else None,
        top_pool_market=_top_share(market, real, pool) if market is not None else None,
        rmse_gap=rmse(err_b) - rmse(err_n),
        rmse_gap_low=float(low),
        rmse_gap_high=float(high),
    )


def blend(
    own: np.ndarray, market: np.ndarray, games: np.ndarray, *, weight: float, fade_games: float
) -> np.ndarray:
    """The board's value with the market prior on, as mart_board has it (#832): own value blended
    toward the market's (null: none) at ``weight``, falling linearly to 0 by ``fade_games``."""
    w = weight * np.clip(1.0 - games / fade_games, 0.0, None)
    w = np.where(np.isnan(market), 0.0, w)
    out: np.ndarray = own + w * (np.where(np.isnan(market), own, market) - own)
    return out


@dataclass(frozen=True)
class PriorCheckpoint:
    """The board with the market prior off and on at one checkpoint; each gap is on minus off."""

    as_of: str
    players: int
    # judged players whose value the prior moved: none once it has faded
    moved: int
    rmse_off: float
    rmse_on: float
    spearman_off: float
    spearman_on: float
    top_pool_off: float
    top_pool_on: float
    rmse_gap: float
    rmse_gap_low: float
    rmse_gap_high: float
    spearman_gap: float
    spearman_gap_low: float
    spearman_gap_high: float
    top_pool_gap: float
    top_pool_gap_low: float
    top_pool_gap_high: float


def judge_prior(
    off: Any, on: Any, as_of: date, *, min_games: int, resamples: int, seed: int = 0
) -> PriorCheckpoint:
    """Off against on over the players who then played at least ``min_games``, paired by player."""
    q = off[off["realized_games"] >= min_games][["player_id", "board_value", "realized_value"]]
    q = q.merge(
        on[["player_id", "board_value"]].rename(columns={"board_value": "on_value"}),
        on="player_id",
        how="left",
    )
    a, b = q["board_value"].to_numpy(float), q["on_value"].to_numpy(float)
    real = q["realized_value"].to_numpy(float)
    pool = int(off["pool"].iloc[0]) if len(off) else 0

    def rmse(pred: np.ndarray, r: np.ndarray) -> float:
        return float(np.sqrt(np.mean((pred - r) ** 2))) if len(r) else math.nan

    def gaps(i: np.ndarray) -> tuple[float, float, float]:
        return (
            rmse(b[i], real[i]) - rmse(a[i], real[i]),
            _spearman(b[i], real[i]) - _spearman(a[i], real[i]),
            _top_share(b[i], real[i], pool) - _top_share(a[i], real[i], pool),
        )

    rng = np.random.default_rng(seed)
    draws = np.array(
        [gaps(rng.integers(0, len(q), len(q))) for _ in range(resamples if len(q) else 0)]
    ).reshape(-1, 3)
    if len(draws):
        low, high = np.percentile(draws, [2.5, 97.5], axis=0)
    else:
        low = high = np.full(3, math.nan)
    point = gaps(np.arange(len(q)))
    return PriorCheckpoint(
        as_of=as_of.isoformat(),
        players=len(q),
        moved=int(np.sum(np.abs(b - a) > 1e-12)),
        rmse_off=rmse(a, real),
        rmse_on=rmse(b, real),
        spearman_off=_spearman(a, real),
        spearman_on=_spearman(b, real),
        top_pool_off=_top_share(a, real, pool),
        top_pool_on=_top_share(b, real, pool),
        rmse_gap=point[0],
        rmse_gap_low=float(low[0]),
        rmse_gap_high=float(high[0]),
        spearman_gap=point[1],
        spearman_gap_low=float(low[1]),
        spearman_gap_high=float(high[1]),
        top_pool_gap=point[2],
        top_pool_gap_low=float(low[2]),
        top_pool_gap_high=float(high[2]),
    )


def _check_parity(off: Any, on: Any, prior: dict[str, Any], as_of: date) -> None:
    """The prior's value in SQL is the one blend() computes from the first build's columns."""
    q = off.merge(on[["player_id", "board_value"]], on="player_id", suffixes=("", "_on"))
    want = blend(
        q["board_value"].to_numpy(float),
        q["market_prior_value"].to_numpy(float),
        q["market_prior_games"].to_numpy(float),
        weight=float(prior["weight"]),
        fade_games=float(prior["fade_games"]),
    )
    worst = float(np.max(np.abs(q["board_value_on"].to_numpy(float) - want))) if len(q) else 0.0
    if len(q) != len(off) or worst > 1e-9:
        msg = f"as of {as_of}: the market prior in mart_board differs from blend() by {worst}"
        raise SystemExit(msg)


def _prior(p: dict[str, Any], weight: float | None, fade: float | None) -> dict[str, Any]:
    reg = p["projection.market_prior"]
    return {
        "enabled": True,
        "weight": reg["weight"] if weight is None else weight,
        "fade_games": reg["fade_games"] if fade is None else fade,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--league", choices=("nba", "wnba"), required=True)
    parser.add_argument("--season", required=True)
    parser.add_argument("--full-db", type=Path, default=DBT / "fantasyscout.duckdb")
    parser.add_argument("--out", type=Path, default=Path("walk_forward.json"))
    parser.add_argument("--judge-locked", action="store_true", help="the held-out season, once")
    parser.add_argument(
        "--market-prior", action="store_true", help="judge the board with the prior off and on"
    )
    parser.add_argument("--prior-weight", type=float, help="the prior's weight (default: registry)")
    parser.add_argument("--prior-fade", type=float, help="its fade_games (default: registry)")
    parser.add_argument("--players-out", type=Path, help="every board player's figures, as CSV")
    args = parser.parse_args(argv)
    if LOCKED.get(args.league) == args.season and not args.judge_locked:
        print(
            f"{args.league} {args.season} is held out and judged once at the end (#751);"
            " pass --judge-locked for that judgement",
            file=sys.stderr,
        )
        return 2
    p = _params()
    fractions = [float(f) for f in p["backtest.checkpoints"]]
    with duckdb.connect(str(args.full_db), read_only=True) as full:
        first, last = _season_span(full, args.league, args.season)
    min_games, resamples = int(p["backtest.min_games"]), int(p["backtest.bootstrap"])
    prior = _prior(p, args.prior_weight, args.prior_fade) if args.market_prior else None
    results: list[Checkpoint] = []
    prior_results: list[PriorCheckpoint] = []
    players: list[Any] = []

    def board_frame(db: Path, as_of: date) -> Any:
        with duckdb.connect(str(db)) as cut:
            cut.execute(f"attach '{args.full_db.as_posix()}' as whole (read_only)")
            return frame(cut, args.league, args.season, as_of)

    with tempfile.TemporaryDirectory() as tmp:
        for fraction, as_of in zip(fractions, checkpoints(first, last, fractions), strict=True):
            db = Path(tmp) / f"wf-{as_of.isoformat()}.duckdb"
            _build(as_of, db)
            df = board_frame(db, as_of)
            players.append(
                df.assign(league=args.league, season=args.season, as_of=as_of, checkpoint=fraction)
            )
            cp = judge(df, as_of, min_games=min_games, resamples=resamples)
            results.append(cp)
            if prior is not None:
                db_on = Path(tmp) / f"wf-{as_of.isoformat()}-prior.duckdb"
                shutil.copyfile(db, db_on)
                _rebuild_board(as_of, db_on, prior)
                on = board_frame(db_on, as_of)
                _check_parity(df, on, prior, as_of)
                pc = judge_prior(df, on, as_of, min_games=min_games, resamples=resamples)
                prior_results.append(pc)
                print(_prior_line(pc))
            print(
                f"{as_of}: {cp.players} players; RMSE board {cp.rmse_board:.3f} vs naive"
                f" {cp.rmse_naive:.3f} (gap {cp.rmse_gap:+.3f}, 95% {cp.rmse_gap_low:+.3f} to"
                f" {cp.rmse_gap_high:+.3f}); Spearman {cp.spearman_board:.3f} vs"
                f" {cp.spearman_naive:.3f}; top pool {cp.top_pool_board:.0%}"
                f" vs {cp.top_pool_naive:.0%}"
                + (
                    f"; market Spearman {cp.spearman_market:.3f}, top pool {cp.top_pool_market:.0%}"
                    if cp.spearman_market is not None and cp.top_pool_market is not None
                    else ""
                )
            )
    out = {
        "league": args.league,
        "season": args.season,
        "locked": LOCKED.get(args.league) == args.season,
        "min_games": p["backtest.min_games"],
        "checkpoints": [asdict(c) for c in results],
    }
    if prior is not None:
        out["market_prior"] = {**prior, "checkpoints": [asdict(c) for c in prior_results]}
    args.out.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    if args.players_out is not None:
        pd.concat(players).to_csv(args.players_out, index=False)
    return 0


def _prior_line(pc: PriorCheckpoint) -> str:
    def gap(name: str, v: float, lo: float, hi: float, f: str) -> str:
        return f"{name} {v:{f}} (95% {lo:{f}} to {hi:{f}})"

    return (
        f"{pc.as_of} market prior on minus off, {pc.players} players, {pc.moved} moved: "
        + gap("RMSE", pc.rmse_gap, pc.rmse_gap_low, pc.rmse_gap_high, "+.3f")
        + f" [{pc.rmse_off:.3f} to {pc.rmse_on:.3f}]; "
        + gap("Spearman", pc.spearman_gap, pc.spearman_gap_low, pc.spearman_gap_high, "+.3f")
        + f" [{pc.spearman_off:.3f} to {pc.spearman_on:.3f}]; "
        + gap("top pool", pc.top_pool_gap, pc.top_pool_gap_low, pc.top_pool_gap_high, "+.1%")
        + f" [{pc.top_pool_off:.0%} to {pc.top_pool_on:.0%}]"
    )


if __name__ == "__main__":
    sys.exit(main())
