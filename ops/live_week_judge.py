"""The live-week judge (#1096): the calls judged on 2026-27's weeks, each against its frozen bar.

    uv run python -m ops.live_week_judge judge --look first --cases cases/ --out look.json

Eight calls and S1's NBA rule are judged at two looks: Monday 2027-01-18 on the 13 weeks completed
by Sunday 2027-01-17, and Monday 2027-03-15 on the 21 weeks completed by 2027-03-14. Each bar was
written on its issue before any 2026-27 week was looked at; the function that scores a call names
its bar's comment. This module is the scoring: given each call's cases, one row per unit the bar
pairs on (a matchup, a league-week, a case, a call), it applies the bar's statistic, comparator,
minimum count and pass rule. It was built and tested on invented weeks only.

What every bar shares (the "How it is measured" of #759 and the bars after it):

- **Weeks:** NBA 2026-27's fantasy weeks, Monday to Sunday; the opening days to 25 October 2026
  count as week 1. A look reads only the weeks completed by its cutoff.
- **Intervals:** 95%, from 1,000 resamples of the weeks (the leagues share the same games, so the
  week is the unit that varies), seed 0.
- **Gaps:** the call minus the baseline, signed so that positive is better. **Beats:** the interval
  lies above zero. **No worse:** the interval's upper end is at zero or above.

The judge refuses to run a look before its date, and a call whose minimum count is not met is
reported as not judged, with no pass or fail.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

# def: the season's first fantasy week starts on the Monday before its first game (20 October
# 2026), so the opening days to 25 October are week 1 (every bar's "Weeks")
WEEK_ONE = date(2026, 10, 19)
# def: the bars' bootstrap, 1,000 resamples of the weeks at seed 0
RESAMPLES = 1000
SEED = 0
ISSUES = "https://github.com/rodelBeronilla/fantasyscout/issues/"


@dataclass(frozen=True)
class Look:
    name: str
    on: date  # the Monday the look runs
    cutoff: date  # the Sunday its last week ends
    weeks: int


LOOKS = {
    "first": Look("first", date(2027, 1, 18), date(2027, 1, 17), 13),
    "second": Look("second", date(2027, 3, 15), date(2027, 3, 14), 21),
}


def week_of(day: date) -> int:
    """The fantasy week of a day: 1 for the opening days, then one per Monday."""
    return (day - WEEK_ONE).days // 7 + 1


def week_end(week: int) -> date:
    return WEEK_ONE + timedelta(days=7 * week - 1)


def check_look(look: Look, today: date) -> None:
    """No look runs before its date (#1096 bar 4)."""
    if today < look.on:
        raise SystemExit(f"the {look.name} look runs on {look.on}, not before (today {today})")
    if week_end(look.weeks) != look.cutoff:
        raise SystemExit(f"the {look.name} look's {look.weeks} weeks do not end on {look.cutoff}")


def completed(cases: pd.DataFrame, look: Look, *, weeks_after: int = 0) -> pd.DataFrame:
    """The cases of the weeks the look reads: those whose week (and the ``weeks_after`` weeks the
    bar scores after it) ended by the cutoff. A case of a later week is not read at all."""
    last = look.weeks - weeks_after
    return cases[(cases["week"] >= 1) & (cases["week"] <= last)].copy()


@dataclass(frozen=True)
class Gap:
    mean: float
    low: float
    high: float

    @property
    def beats(self) -> bool:
        return self.low > 0

    @property
    def no_worse(self) -> bool:
        return self.high >= 0


def gap(values: np.ndarray, weeks: np.ndarray, resamples: int = RESAMPLES) -> Gap:
    """The pooled mean of per-unit gaps, with its 95% interval from resampling whole weeks."""
    if len(values) == 0:
        return Gap(float("nan"), float("nan"), float("nan"))
    labels, idx = np.unique(weeks, return_inverse=True)
    sums = np.bincount(idx, weights=values, minlength=len(labels))
    counts = np.bincount(idx, minlength=len(labels)).astype(float)
    rng = np.random.default_rng(SEED)
    pick = rng.integers(0, len(labels), (resamples, len(labels)))
    boot = sums[pick].sum(axis=1) / counts[pick].sum(axis=1)
    low, high = np.percentile(boot, [2.5, 97.5])
    return Gap(float(values.mean()), float(low), float(high))


def paired(cases: pd.DataFrame, call: str, baseline: str) -> Gap:
    """Call minus baseline, per row (a matchup, a team-week, a case), pooled over the weeks."""
    rows = cases.dropna(subset=[call, baseline])
    return gap((rows[call] - rows[baseline]).to_numpy(float), rows["week"].to_numpy())


def verdict(
    call: str,
    issue: int,
    comment: int,
    look: Look,
    n: int,
    gaps: dict[str, Gap],
    conditions: dict[str, bool],
    *,
    minimum: int | None = None,
    reported: dict[str, Any] | None = None,
    outcome: str | None = None,
) -> dict[str, Any]:
    """One call's result. Under its minimum count it is not judged: no pass and no fail."""
    judged = minimum is None or n >= minimum
    return {
        "call": call,
        "bar": f"{ISSUES}{issue}#issuecomment-{comment}",
        "look": look.name,
        "cases": n,
        "minimum": minimum,
        "judged": judged,
        "gaps": {k: asdict(g) for k, g in gaps.items()},
        "conditions": conditions if judged else {},
        "passes": bool(judged and all(conditions.values())),
        "outcome": outcome if judged else None,
        "reported": reported or {},
    }


# ---- the eight calls ----------------------------------------------------------------------


def lineup(cases: pd.DataFrame, look: Look) -> dict[str, Any]:
    """#759 (bar 6735149779): one row per matchup and week, the categories won with each arm's
    lineup (``plan``, ``naive``, ``market``). Pass: Plan beats Naive and is no worse than Market."""
    c = completed(cases, look)
    g = {
        "plan_minus_naive": paired(c, "plan", "naive"),
        "plan_minus_market": paired(c, "plan", "market"),
    }
    cond = {
        "beats_naive": g["plan_minus_naive"].beats,
        "no_worse_than_market": g["plan_minus_market"].no_worse,
    }
    rep = {k: float(c[k].mean()) for k in ("started_games", "benched_games") if k in c}
    return verdict("lineup planner", 759, 6735149779, look, len(c), g, cond, reported=rep)


def top_adds(
    cases: pd.DataFrame, look: Look, spearman: pd.DataFrame | None = None
) -> dict[str, Any]:
    """#762 (bar 6735150416): one row per league and week, the top 3's summed real value for each
    arm (``window``, ``naive``, ``market``, ``projection``). Pass: Window beats Naive, is no worse
    than Market and no worse than Projection. If the first two hold but Projection beats Window,
    the call comes back ranked by the projection."""
    c = completed(cases, look)
    g = {f"window_minus_{a}": paired(c, "window", a) for a in ("naive", "market", "projection")}
    cond = {
        "beats_naive": g["window_minus_naive"].beats,
        "no_worse_than_market": g["window_minus_market"].no_worse,
        "no_worse_than_projection": g["window_minus_projection"].no_worse,
    }
    outcome = None
    if (
        cond["beats_naive"]
        and cond["no_worse_than_market"]
        and not cond["no_worse_than_projection"]
    ):
        outcome = "ranked by the projection times games; window value stays a column"
    rep: dict[str, Any] = {}
    if spearman is not None:
        s = completed(spearman, look)
        rep["spearman"] = {a: float(s[a].mean()) for a in s.columns if a != "week"}
    return verdict(
        "top adds", 762, 6735150416, look, len(c), g, cond, reported=rep, outcome=outcome
    )


def minutes(cases: pd.DataFrame, look: Look) -> dict[str, Any]:
    """#763 (bar 6735151667): one row per game a covered player missed while listed out on that
    morning's build: the minutes gained by the call's, Naive's and Market's teammate, and the named
    and naive pickups' values (null where the default league does not leave the named one free).
    Pass: the call's gain beats Naive's and is no worse than Market's, the pickup is no worse than
    Naive's, on at least 150 cases."""
    c = completed(cases, look)
    g = {
        "call_minus_naive": paired(c, "call_gain", "naive_gain"),
        "call_minus_market": paired(c, "call_gain", "market_gain"),
        "pickup_minus_naive": paired(c, "pickup_value", "naive_pickup_value"),
    }
    cond = {
        "beats_naive": g["call_minus_naive"].beats,
        "no_worse_than_market": g["call_minus_market"].no_worse,
        "pickup_no_worse": g["pickup_minus_naive"].no_worse,
    }
    rep = (
        {"top_gainer_share": float(c["call_was_top_gainer"].mean())}
        if "call_was_top_gainer" in c
        else {}
    )
    return verdict(
        "who takes an out player's minutes",
        763,
        6735151667,
        look,
        len(c),
        g,
        cond,
        minimum=150,
        reported=rep,
    )


def injury_estimate(cases: pd.DataFrame, il: pd.DataFrame, look: Look) -> dict[str, Any]:
    """#770 (bar 6735151942): ``cases``, one row per player listed out or doubtful on a Monday's
    build whose absence has ended by the cutoff (or the season), with the games he missed and each
    arm's games (``estimate``, ``listing``, ``so_far``, ``return_date`` where one was given);
    ``il``, one row per team and week of the IL replay with the categories won by each rule.
    The error is the absolute games wrong; a gap is the baseline's error less the estimate's.
    Pass: the estimate beats Listing and So far, is no worse than Return date on its cases, the
    Estimate rule is no worse than the Listing rule, on at least 150 scored cases. If the first two
    hold and the IL replay fails, the estimate comes back as a number on the Player page."""
    c = completed(cases.dropna(subset=["missed"]), look)
    err = {a: (c[a] - c["missed"]).abs() for a in ("estimate", "listing", "so_far", "return_date")}
    w = c["week"].to_numpy()

    def vs(arm: str) -> Gap:
        ok = err[arm].notna() & err["estimate"].notna()
        return gap((err[arm] - err["estimate"])[ok].to_numpy(float), w[ok.to_numpy()])

    g = {
        "vs_listing": vs("listing"),
        "vs_so_far": vs("so_far"),
        "vs_return_date": vs("return_date"),
    }
    i = completed(il, look)
    g["il_estimate_minus_listing"] = paired(i, "estimate_rule", "listing_rule")
    cond = {
        "beats_listing": g["vs_listing"].beats,
        "beats_so_far": g["vs_so_far"].beats,
        "no_worse_than_return_date": g["vs_return_date"].no_worse,
        "il_no_worse": g["il_estimate_minus_listing"].no_worse,
    }
    outcome = None
    first_two = cond["beats_listing"] and cond["beats_so_far"] and cond["no_worse_than_return_date"]
    if first_two and not cond["il_no_worse"]:
        outcome = "a number on the Player page; IL moves keep following the listing"
    rep = {f"mae_{a}": float(err[a].mean()) for a in err}
    return verdict(
        "games-missed estimate and the IL threshold",
        770,
        6735151942,
        look,
        len(c),
        g,
        cond,
        minimum=150,
        reported=rep,
        outcome=outcome,
    )


def swaps(cases: pd.DataFrame, look: Look) -> dict[str, Any]:
    """#895 (bar 6735150083): one row per team and swap week, the categories won over the four
    weeks from the swap for each arm (``review``, ``stand_pat``, ``naive``, ``market``). Only swaps
    with four completed weeks after them count (to 21 December at the first look). Pass: Review
    beats Stand pat and Naive, and is no worse than Market."""
    c = completed(cases, look, weeks_after=3)
    g = {f"review_minus_{a}": paired(c, "review", a) for a in ("stand_pat", "naive", "market")}
    cond = {
        "beats_stand_pat": g["review_minus_stand_pat"].beats,
        "beats_naive": g["review_minus_naive"].beats,
        "no_worse_than_market": g["review_minus_market"].no_worse,
    }
    rep: dict[str, Any] = {}
    if "offered" in c:
        rep["share_offered"] = float(c["offered"].mean())
    if "projected_gain" in c:
        offered = c[c["projected_gain"].notna()]
        if len(offered) >= 5:
            fifth = pd.qcut(offered["projected_gain"], 5, labels=False, duplicates="drop")
            gain = offered["review"] - offered["stand_pat"]
            rep["gain_by_fifth"] = {int(k): float(v) for k, v in gain.groupby(fifth).mean().items()}
    return verdict("roster review's swaps", 895, 6735150083, look, len(c), g, cond, reported=rep)


def streams(cases: pd.DataFrame, look: Look) -> dict[str, Any]:
    """#902 (bar 6735149425): one row per matchup and week, the categories the team wins with each
    arm's add (``stream``, ``all``, ``naive``, ``market``). Pass: Stream beats Naive, is no worse
    than Market and no worse than All. If the first two hold but All does better, the pick comes
    back without its targets."""
    c = completed(cases, look)
    g = {f"stream_minus_{a}": paired(c, "stream", a) for a in ("naive", "market", "all")}
    cond = {
        "beats_naive": g["stream_minus_naive"].beats,
        "no_worse_than_market": g["stream_minus_market"].no_worse,
        "no_worse_than_all": g["stream_minus_all"].no_worse,
    }
    outcome = None
    if cond["beats_naive"] and cond["no_worse_than_market"] and not g["stream_minus_all"].beats:
        outcome = (
            "the pick without its targets: need chips off, the best add by last-ten production"
        )
    return verdict("stream picks", 902, 6735149425, look, len(c), g, cond, outcome=outcome)


def calibration_slope(chance: np.ndarray, outcome: np.ndarray) -> float:
    """The slope of a logistic fit of the outcome (a tie counts half) on logit(chance)."""
    p = np.clip(chance, 1e-6, 1 - 1e-6)
    x = np.column_stack([np.ones(len(p)), np.log(p / (1 - p))])
    beta = np.zeros(2)
    for _ in range(50):
        mu = 1 / (1 + np.exp(-x @ beta))
        wgt = mu * (1 - mu)
        step = np.linalg.solve(x.T @ (x * wgt[:, None]), x.T @ (outcome - mu))
        beta += step
        if np.max(np.abs(step)) < 1e-10:
            break
    return float(beta[1])


def midweek_chances(cases: pd.DataFrame, look: Look) -> dict[str, Any]:
    """#950 (bar 6735150995): one row per category of a matchup at a read (``read`` Thursday or
    Saturday), with the card's ``chance``, the naive manager's ``naive``, and the ``outcome`` (1
    won, 0 lost, 0.5 tied). At each read: the chances beat a coin flip and the naive manager in
    Brier (gap: the baseline's squared error less the chance's), and the calibration slope is
    between 0.8 and 1.25."""
    c = completed(cases, look)
    gaps: dict[str, Gap] = {}
    cond: dict[str, bool] = {}
    rep: dict[str, Any] = {}
    for read in ("thursday", "saturday"):
        r = c[c["read"] == read]
        y, w = r["outcome"].to_numpy(float), r["week"].to_numpy()
        se = (r["chance"].to_numpy(float) - y) ** 2
        gaps[f"{read}_vs_coin"] = gap((0.5 - y) ** 2 - se, w)
        gaps[f"{read}_vs_naive"] = gap((r["naive"].to_numpy(float) - y) ** 2 - se, w)
        slope = calibration_slope(r["chance"].to_numpy(float), y) if len(r) else float("nan")
        cond[f"{read}_beats_coin"] = gaps[f"{read}_vs_coin"].beats
        cond[f"{read}_beats_naive"] = gaps[f"{read}_vs_naive"].beats
        cond[f"{read}_slope_in_range"] = bool(0.8 <= slope <= 1.25)
        tenth = np.minimum((r["chance"] * 10).astype(int), 9)
        rep[read] = {
            "slope": slope,
            "by_tenth": {int(k): float(v) for k, v in r["outcome"].groupby(tenth).mean().items()},
            "settled_share": float(((r["chance"] < 0.05) | (r["chance"] > 0.95)).mean())
            if len(r)
            else None,
        }
    return verdict("mid-week chances", 950, 6735150995, look, len(c), gaps, cond, reported=rep)


START_SIT = ("start", "sit")
ADD_HOLD_DROP = ("add", "hold", "drop")


def note_right(call: str, row: pd.Series) -> float:
    """Whether a call was right, as #951's bar scores it (NaN for watch, which claims nothing)."""
    above = row["value_per_game_7d"] >= row["replacement"]
    if call == "start":
        return float(bool(row["played_next"]) and row["next_value"] >= row["replacement"])
    if call == "sit":
        return float(not bool(row["played_next"]) or row["next_value"] < row["replacement"])
    if call in ("add", "hold"):
        return float(above)
    if call == "drop":
        return float(not above)
    return float("nan")


def naive_call(row: pd.Series, group: str) -> str:
    if group == "start_sit":
        return "sit" if row["listed_out_or_doubtful"] else "start"
    return "add" if row["season_value_per_game"] > row["replacement"] else "drop"


def market_call(row: pd.Series) -> str | None:
    if pd.isna(row["ownership_change_7d"]) or row["ownership_change_7d"] == 0:
        return None
    return "add" if row["ownership_change_7d"] > 0 else "drop"


def one_call_a_day(calls: pd.DataFrame) -> pd.DataFrame:
    """A player called more than once on a day counts once, by his last call before the day's
    first tip-off; a call made after it does not count that day."""
    before = calls[calls["made_at"] < calls["first_tipoff"]]
    return before.sort_values("made_at").groupby(["player_id", "day"], as_index=False).tail(1)


def notes(calls: pd.DataFrame, look: Look) -> dict[str, Any]:
    """#951 (bar 6735151348): one row per published call (``player_id``, ``day``, ``made_at``,
    ``first_tipoff``, ``call``) with what the scoring reads. The share right minus each baseline's,
    over the same player-days, for start and sit pooled and add, hold and drop pooled. Pass: start
    and sit beat Naive; add, hold and drop beat Naive and are no worse than Market; at least 200
    calls in each group. If only one group passes, only its calls come back."""
    c = one_call_a_day(calls)
    c = c.assign(week=[week_of(d) for d in c["day"]])
    c = completed(c, look)
    gaps: dict[str, Gap] = {}
    counts: dict[str, int] = {}
    for group, kinds in (("start_sit", START_SIT), ("add_hold_drop", ADD_HOLD_DROP)):
        rows = c[c["call"].isin(kinds)]
        counts[group] = len(rows)
        mine = np.array(
            [note_right(k, r) for k, (_, r) in zip(rows["call"], rows.iterrows(), strict=True)]
        )
        naive = np.array([note_right(naive_call(r, group), r) for _, r in rows.iterrows()])
        gaps[f"{group}_minus_naive"] = gap(mine - naive, rows["week"].to_numpy())
        if group == "add_hold_drop":
            mk = [market_call(r) for _, r in rows.iterrows()]
            has = np.array([m is not None for m in mk], dtype=bool)
            market = np.array(
                [
                    note_right(m, r)
                    for m, (_, r) in zip(mk, rows.iterrows(), strict=True)
                    if m is not None
                ]
            )
            gaps["add_hold_drop_minus_market"] = gap(
                mine[has] - market, rows["week"].to_numpy()[has]
            )
    enough = {g: n >= 200 for g, n in counts.items()}
    group_pass = {
        "start_sit": enough["start_sit"] and gaps["start_sit_minus_naive"].beats,
        "add_hold_drop": enough["add_hold_drop"]
        and gaps["add_hold_drop_minus_naive"].beats
        and gaps["add_hold_drop_minus_market"].no_worse,
    }
    res = verdict(
        "the notes' calls", 951, 6735151348, look, min(counts.values()), gaps,
        {"start_sit": group_pass["start_sit"], "add_hold_drop": group_pass["add_hold_drop"]},
        minimum=200,
        reported={"calls": counts, "watch": int((c["call"] == "watch").sum())},
    )  # fmt: skip
    # each group is judged on its own count; a group with fewer than 200 is not judged
    res["groups"] = {
        g: ("not judged" if not enough[g] else ("passes" if group_pass[g] else "fails"))
        for g in group_pass
    }
    if any(enough.values()):
        res["judged"] = True
        res["conditions"] = {g: group_pass[g] for g in group_pass if enough[g]}
        res["passes"] = all(enough.values()) and all(group_pass.values())
        passed = [g for g in group_pass if group_pass[g]]
        if len(passed) == 1:
            res["outcome"] = f"only the {passed[0].replace('_', ' ')} calls come back"
    return res


# ---- S1's NBA rule, the ninth ---------------------------------------------------------------


def s1_confirmation(
    weeks: list[Any], s0_categories: list[dict[str, Any]], look: Look, *, min_weeks: int = 6
) -> dict[str, Any]:
    """S1's NBA rule (#1079, bar 7068301572): judged on 2026-27's weeks with S0's bar, against the
    projection-week and against the flat-discount placebo (#1088: the study's total discount spread
    over every game). ``weeks`` holds ``ops.s1_games_played.Monday`` with the study's games, one per
    completed week. The owner decides whether the placebo binds (#1088), so both are reported; at
    least six live weeks are needed (#1079: six live weeks agree before it shows publicly)."""
    from ops import s1_games_played as s1
    from ops import week_yardstick as wy

    use = [(m, g) for m, g in weeks if 1 <= week_of(m.as_of) <= look.weeks]
    counted = [np.where(m.listed, 0.0, m.scheduled) for m, _ in use]
    total = float(sum(c.sum() for c in counted))
    share = 1.0 - float(sum(g.sum() for _, g in use)) / total if total else 0.0
    flat = [c * (1.0 - share) for c in counted]

    def against(base: list[np.ndarray]) -> tuple[list[dict[str, Any]], list[str]]:
        paired_weeks = [
            wy.Week(
                as_of=m.as_of,
                proj=wy.category_weeks(m.line, g, m.real),
                naive=wy.category_weeks(m.line, b, m.real),
                real=wy.real_weeks(m.real),
            )
            for (m, g), b in zip(use, base, strict=True)
        ]
        return s1.apply_bar(wy.judge(paired_weeks, seeds=1), s0_categories)

    n = len({m.as_of for m, _ in use})
    if n < min_weeks:
        return verdict("S1's NBA games rule", 1079, 7068301572, look, n, {}, {}, minimum=min_weeks)
    rows_p, fails_p = against(counted)
    rows_f, fails_f = against(flat)
    res = verdict(
        "S1's NBA games rule", 1079, 7068301572, look, n, {},
        {"against_the_projection": not fails_p, "against_the_placebo": not fails_f},
        minimum=min_weeks,
        reported={
            "discount_share": share,
            "against_the_projection": rows_p,
            "against_the_placebo": rows_f,
        },
    )  # fmt: skip
    # the placebo's role is the owner's to decide (#1088): the pass reported is the projection's
    res["passes"] = not fails_p
    res["passes_against_the_placebo"] = not fails_f
    return res


# ---- reading the cases ----------------------------------------------------------------------

CALLS: dict[str, Callable[..., dict[str, Any]]] = {
    "lineup": lineup,
    "top_adds": top_adds,
    "minutes": minutes,
    "streams": streams,
    "swaps": swaps,
    "midweek_chances": midweek_chances,
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ops.live_week_judge")
    sub = parser.add_subparsers(dest="cmd", required=True)
    j = sub.add_parser("judge", help="one look, on the cases each call's export wrote")
    j.add_argument("--look", choices=sorted(LOOKS), required=True)
    j.add_argument("--cases", type=Path, required=True)
    j.add_argument("--out", type=Path, required=True)
    j.add_argument("--today", type=date.fromisoformat, default=date.today())
    args = parser.parse_args(argv)
    look = LOOKS[args.look]
    check_look(look, args.today)
    results = []
    for name, fn in CALLS.items():
        path = args.cases / f"{name}.csv"
        if path.exists():
            results.append(fn(pd.read_csv(path), look))
        else:
            print(f"{name}: no cases at {path}", file=sys.stderr)
    est, il = args.cases / "injury_estimate.csv", args.cases / "injury_il.csv"
    if est.exists() and il.exists():
        results.append(injury_estimate(pd.read_csv(est), pd.read_csv(il), look))
    note_path = args.cases / "notes.csv"
    if note_path.exists():
        n = pd.read_csv(note_path, parse_dates=["made_at", "first_tipoff"])
        n["day"] = pd.to_datetime(n["day"]).dt.date
        results.append(notes(n, look))
    args.out.write_text(json.dumps(results, indent=1, default=str) + "\n", encoding="utf-8")
    for r in results:
        state = ("PASS" if r["passes"] else "FAIL") if r["judged"] else "NOT JUDGED"
        print(f"{r['call']}: {state} ({r['cases']} cases) {r['bar']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
