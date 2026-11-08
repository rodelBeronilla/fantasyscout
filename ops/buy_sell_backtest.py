"""Walk-forward backtest of the Trade page's buy low, sell high (#758).

    uv run python -m ops.walk_forward --league nba --season 2023-24 --standings-out standings/ \\
        --players-out walk_forward_players.csv
    uv run python -m ops.buy_sell_backtest judge standings/ walk_forward_players.csv --out bs.json
    uv run python -m ops.buy_sell_backtest fit tuning-2020-21.json tuning-2021-22.json ...

The leagues are #755's (ops.standings_backtest.simulate): at each checkpoint, 200 snake drafts of
the default size. Every team reads its lists as the Trade page does (ops/buy_sell.py, pinned to
web/src/lib/buy-sell.ts): its players running ``buysell.min_swing`` above their projection sell
high; healthy players elsewhere slumping that far below a projection that would start for it buy
low. Values are per game above replacement, as the web computes them: the projection's nine
categories plus the market prior's shift (#848), and last-ten form's nine categories.

What happened is each player's realized value per game over the rest of the season, from
ops.walk_forward (``realized_value``, on the checkpoint's scale), for a player with
``backtest.min_games`` or more. Judged per list, pooled over the checkpoints:

- **the reversal:** buy-low players' realized value above their last ten, sell-high players'
  below it;
- **against the naive manager:** the same lists with the season so far in place of the
  projection (regression to the season's mean);
- **the guess:** for the flagged players, the projection's squared error against last-ten form's.

Intervals are 95%, from ``backtest.bootstrap`` resamples of the season's players (a player sits on
many simulated rosters, so the player is the unit that varies). The pass bar was declared on #758
before any run; ``verdict`` applies it. ``fit`` reads the tuning seasons' caches only.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from ops import buy_sell, standings
from ops.standings import CATS
from ops.standings_backtest import TUNING, Cut, Season, _interval, _seed, load, simulate
from ops.walk_forward import LOCKED

RECENT = tuple(f"recent_{c}" for c in CATS)
LISTS = ("buy", "sell")
ARMS = ("tool", "naive")
UNHEALTHY = ("out", "doubtful")


# ---- what a checkpoint's build hands over ---------------------------------------------------


def export_checkpoint(cut: Any, league: str, as_of: date, out: Path) -> None:
    """The board's last-ten form per category, the injury listing and the market prior's
    columns, for the Trade page's buy low, sell high. ``cut`` is the point-in-time build."""
    cols = ", ".join([*RECENT, "injury_group", "market_prior_weight", "market_prior_value"])
    df = cut.execute(
        f"select player_id, {cols} from gold.mart_board where league = $league", {"league": league}
    ).fetchdf()
    df.to_csv(out / f"buysell-{as_of.isoformat()}.csv", index=False)


# ---- loading ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class Board:
    """A checkpoint's players, in the order of the standings export."""

    projected: np.ndarray  # the web's value per game (buy-sell.ts projected)
    recent: np.ndarray  # last-ten form's (recent)
    naive: np.ndarray  # the season so far
    healthy: np.ndarray  # bool
    realized: np.ndarray  # nan: too few games after the cut
    player: np.ndarray  # the season's player index, shared by every checkpoint


def boards(season: Season, folder: Path, realized_csv: Path, min_games: int) -> list[Board]:
    real = pd.read_csv(realized_csv, dtype={"player_id": str})
    ids: dict[str, int] = {}
    out = []
    for cut in season.cuts:
        players = pd.read_csv(
            folder / f"players-{cut.as_of.isoformat()}.csv", dtype={"player_id": str}
        )["player_id"]
        extra = pd.read_csv(
            folder / f"buysell-{cut.as_of.isoformat()}.csv", dtype={"player_id": str}
        )
        extra = players.to_frame().merge(extra, on="player_id", how="left")
        r = real[real["as_of"] == cut.as_of.isoformat()]
        r = players.to_frame().merge(r, on="player_id", how="left")
        out.append(_board(cut, extra, r, min_games, [ids.setdefault(p, len(ids)) for p in players]))
    return out


def _board(
    cut: Cut, extra: pd.DataFrame, real: pd.DataFrame, min_games: int, player: list[int]
) -> Board:
    own = cut.z.sum(1)
    w = extra["market_prior_weight"].astype(float).fillna(0).to_numpy()
    m = extra["market_prior_value"].astype(float).to_numpy()
    shift = np.where((w > 0) & np.isfinite(m), w * (np.nan_to_num(m) - own), 0.0)
    # week-value.ts recentForm: a category with no last-ten line keeps the projection's
    rec = extra[list(RECENT)].astype(float).to_numpy()
    recent = np.where(np.isfinite(rec), rec, cut.z).sum(1)
    games = real["realized_games"].astype(float).fillna(0).to_numpy()
    value = real["realized_value"].astype(float).to_numpy()
    return Board(
        projected=own + shift,
        recent=recent,
        naive=cut.naive.sum(1),
        healthy=~extra["injury_group"].isin(UNHEALTHY).to_numpy(),
        realized=np.where(games >= min_games, value, np.nan),
        player=np.array(player, dtype=int),
    )


# ---- the lists -------------------------------------------------------------------------------


def lists(
    rost: np.ndarray, projected: np.ndarray, recent: np.ndarray, healthy: np.ndarray, swing: float
) -> dict[str, list[int]]:
    """Every team's two lists in one league ``rost`` [T, R], as buy_sell.buy_sell makes them:
    the flagged players' indices, every team's lists concatenated."""
    out: dict[str, list[int]] = {"buy": [], "sell": []}
    form = recent - projected
    teams = rost.shape[0]
    for t in range(teams):
        mine = rost[t]
        line = buy_sell.median(projected[mine].tolist())
        sell = mine[form[mine] >= swing]
        out["sell"] += sell[np.argsort(-form[sell], kind="stable")][: buy_sell.SHOWN].tolist()
        others = np.concatenate([rost[u] for u in range(teams) if u != t])
        ok = others[(form[others] <= -swing) & (projected[others] >= line) & healthy[others]]
        out["buy"] += ok[np.argsort(-projected[ok], kind="stable")][: buy_sell.SHOWN].tolist()
    return out


def flags(
    cut: Cut, board: Board, p: dict[str, Any], league: str, swing: float
) -> dict[str, dict[str, np.ndarray]]:
    """Each arm's flagged players over every simulated league: arm -> list -> indices."""
    lg = simulate(cut, p, league, _seed(cut.as_of))
    out: dict[str, dict[str, list[int]]] = {a: {k: [] for k in LISTS} for a in ARMS}
    for rost in lg.rost:
        for arm, base in (("tool", board.projected), ("naive", board.naive)):
            got = lists(rost, base, board.recent, board.healthy, swing)
            for k in LISTS:
                out[arm][k] += got[k]
    return {a: {k: np.array(v, dtype=int) for k, v in d.items()} for a, d in out.items()}


# ---- judging ---------------------------------------------------------------------------------


@dataclass
class Flagged:
    player: np.ndarray  # the season's player index of each flag
    reversal: np.ndarray  # realized past last ten, in the direction the list claims
    advantage: np.ndarray  # last ten's squared error minus the arm's own guess's


def flagged(board: Board, idx: np.ndarray, kind: str, base: np.ndarray) -> Flagged:
    real = board.realized[idx]
    ok = np.isfinite(real)
    idx, real = idx[ok], real[ok]
    rec, guess = board.recent[idx], base[idx]
    rev = real - rec if kind == "buy" else rec - real
    return Flagged(board.player[idx], rev, (rec - real) ** 2 - (guess - real) ** 2)


def _weighted(f: Flagged, field: str, w: np.ndarray) -> np.ndarray:
    """The mean of a field for each weighting of the players w [B, N]; nan for a weighting that
    draws none of the flagged players, which the interval then leaves out."""
    v = getattr(f, field)
    if not len(v):
        return np.full(len(w), np.nan)
    ww = w[:, f.player]
    tot = ww.sum(1)
    out: np.ndarray = np.where(tot > 0, (ww * v).sum(1) / np.where(tot > 0, tot, 1), np.nan)
    return out


def judge(
    season: Season, bds: list[Board], p: dict[str, Any], *, seed: int = 0
) -> tuple[dict[str, Any], dict[str, Any]]:
    reg = p["buysell.min_swing"]
    swing = float(reg[season.league] if isinstance(reg, dict) else reg)
    n = int(max(b.player.max() for b in bds)) + 1
    rng = np.random.default_rng(seed)
    resamples = int(p["backtest.bootstrap"])
    w = np.concatenate([np.ones((1, n)), rng.multinomial(n, np.full(n, 1 / n), size=resamples)])
    pooled: dict[str, dict[str, list[Flagged]]] = {a: {k: [] for k in LISTS} for a in ARMS}
    cps = []
    cache: dict[str, Any] = {"league": season.league, "season": season.season, "cuts": []}
    for cut, board in zip(season.cuts, bds, strict=True):
        fl = flags(cut, board, p, season.league, swing)
        line: dict[str, Any] = {"as_of": cut.as_of.isoformat()}
        for arm, base in (("tool", board.projected), ("naive", board.naive)):
            for k in LISTS:
                f = flagged(board, fl[arm][k], k, base)
                pooled[arm][k].append(f)
                line[f"{arm}.{k}"] = {
                    "flags": len(fl[arm][k]),
                    "judged": len(f.reversal),
                    "reversal": float(f.reversal.mean()) if len(f.reversal) else math.nan,
                }
        cps.append(line)
        lg = simulate(cut, p, season.league, _seed(cut.as_of))
        rostered = np.unique(lg.rost)
        ok = rostered[np.isfinite(board.realized[rostered])]
        cache["cuts"].append(
            {
                "as_of": cut.as_of.isoformat(),
                "projected": board.projected[ok].tolist(),
                "recent": board.recent[ok].tolist(),
                "realized": board.realized[ok].tolist(),
            }
        )
    res: dict[str, Any] = {"league": season.league, "season": season.season, "checkpoints": cps}
    out: dict[str, Any] = {}
    for k in LISTS:
        cat = {
            a: Flagged(
                *(
                    np.concatenate([getattr(f, x) for f in pooled[a][k]])
                    for x in ("player", "reversal", "advantage")
                )
            )
            for a in ARMS
        }
        tool, naive = (_weighted(cat[a], "reversal", w) for a in ARMS)
        out[k] = {
            "judged": len(cat["tool"].reversal),
            "naive_judged": len(cat["naive"].reversal),
            "players": len(np.unique(cat["tool"].player)),
            "reversal": _interval(float(tool[0]), tool[1:]),
            "naive_reversal": _interval(float(naive[0]), naive[1:]),
            "vs_naive": _interval(float(tool[0] - naive[0]), (tool - naive)[1:]),
            "advantage": _iv(_weighted(cat["tool"], "advantage", w)),
            "naive_advantage": _iv(_weighted(cat["naive"], "advantage", w)),
        }
    res["pooled"] = out
    return res, cache


def _iv(s: np.ndarray) -> list[float]:
    return _interval(float(s[0]), s[1:])


def verdict(result: dict[str, Any]) -> list[str]:
    """The pass bar declared on #758: what fails, empty when everything passes."""
    fails = []
    for k, r in result["pooled"].items():
        for key in ("reversal", "vs_naive", "advantage"):
            v = r[key]
            if not (np.isfinite(v[1]) and v[1] > 0):
                fails.append(f"{k} {key}: {v}")
    return fails


# ---- the fit ---------------------------------------------------------------------------------


def fit(caches: list[dict[str, Any]], p: dict[str, Any]) -> dict[str, Any]:
    """The rule declared on #758, on the tuning seasons only: over every rostered player at the
    tuning checkpoints, the share of a swing that persists (beta, the slope of realized minus
    projected on last ten minus projected, through the origin) and the projection's root mean
    square error; the least swing worth flagging is the one whose expected reversal,
    (1 - beta) x swing, reaches that error: RMSE / (1 - beta), to 0.1."""
    league = caches[0]["league"]
    for c in caches:
        if c["league"] != league or c["season"] not in TUNING[league]:
            msg = (
                f"{c['league']} {c['season']} is not a tuning season ({sorted(TUNING[league])});"
                " the fit reads only those"
            )
            raise SystemExit(msg)
    cuts = [cut for c in caches for cut in c["cuts"]]
    proj = np.concatenate([np.array(c["projected"]) for c in cuts])
    rec = np.concatenate([np.array(c["recent"]) for c in cuts])
    real = np.concatenate([np.array(c["realized"]) for c in cuts])
    form, err = rec - proj, real - proj
    beta = float((form * err).sum() / (form**2).sum())
    rmse = float(np.sqrt((err**2).mean()))
    out: dict[str, Any] = {
        "league": league,
        "seasons": sorted(c["season"] for c in caches),
        "checkpoints": len(cuts),
        "players": len(proj),
        "beta": beta,
        "rmse": rmse,
        "form_sd": float(form.std()),
        "informative": beta < 1,
    }
    if beta < 1:
        out["min_swing"] = round(rmse / (1 - beta), 1)
        out["flagged_share"] = float((np.abs(form) >= out["min_swing"]).mean())
    return out


# ---- the command line ------------------------------------------------------------------------


def _fmt(v: list[float], f: str = "+.3f") -> str:
    return f"{v[0]:{f}} ({v[1]:{f}} to {v[2]:{f}})"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    j = sub.add_parser("judge", help="judge one season's checkpoints against the bar")
    j.add_argument("folder", type=Path)
    j.add_argument("realized", type=Path, help="ops.walk_forward --players-out")
    j.add_argument("--out", type=Path)
    j.add_argument("--cache", type=Path, help="what fit reads, for a tuning season")
    j.add_argument("--judge-locked", action="store_true", help="the held-out season, once")
    f = sub.add_parser("fit", help="fit the least swing on the tuning seasons' caches")
    f.add_argument("caches", type=Path, nargs="+")
    f.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    p = standings.registry()
    if args.cmd == "fit":
        res = fit([json.loads(c.read_text(encoding="utf-8")) for c in args.caches], p)
        print(json.dumps(res, indent=2))
        if args.out:
            args.out.write_text(json.dumps(res, indent=2) + "\n", encoding="utf-8")
        return 0
    season = load(args.folder)
    if LOCKED.get(season.league) == season.season and not args.judge_locked:
        print(
            f"{season.league} {season.season} is held out and judged once at the end (#751)",
            file=sys.stderr,
        )
        return 2
    bds = boards(season, args.folder, args.realized, int(p["backtest.min_games"]))
    res, cache = judge(season, bds, p)
    for cp in res["checkpoints"]:
        print(cp)
    for k, r in res["pooled"].items():
        print(
            f"{k}: {r['judged']} flags judged ({r['players']} players); reversal"
            f" {_fmt(r['reversal'])}, naive {_fmt(r['naive_reversal'])} ({r['naive_judged']}),"
            f" vs naive {_fmt(r['vs_naive'])}; the projection's advantage over last ten"
            f" {_fmt(r['advantage'])}, naive's {_fmt(r['naive_advantage'])}"
        )
    fails = verdict(res)
    res["verdict"] = {"pass": not fails, "fails": fails}
    print(
        "PASS: every condition of the bar holds" if not fails else "FAIL:\n  " + "\n  ".join(fails)
    )
    if args.out:
        args.out.write_text(json.dumps(res, indent=2) + "\n", encoding="utf-8")
    if args.cache:
        args.cache.write_text(json.dumps(cache) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
