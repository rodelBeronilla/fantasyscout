"""The live-week judge (#1096), on invented weeks only: each call passes when its planted effect is
there and fails when it is not, no look runs before its date, a call under its minimum count is not
judged, and a row from after the cutoff moves nothing while the same row a day earlier does."""

from __future__ import annotations

from datetime import date, datetime, timedelta

import numpy as np
import pandas as pd
import pytest

from ops import live_week_judge as lj

FIRST = lj.LOOKS["first"]


def weekly(n_per_week: int, arms: dict[str, float], weeks: int = 13, seed: int = 0) -> pd.DataFrame:
    """Invented units: each arm's outcome is a shared noisy base plus its planted effect."""
    rng = np.random.default_rng(seed)
    rows = []
    for w in range(1, weeks + 1):
        for _ in range(n_per_week):
            base = rng.normal(4.5, 1.0)
            rows.append({"week": w, **{a: base + e + rng.normal(0, 0.3) for a, e in arms.items()}})
    return pd.DataFrame(rows)


def test_the_looks_end_on_their_sundays_and_none_runs_early() -> None:
    assert lj.week_of(date(2026, 10, 20)) == 1 and lj.week_of(date(2026, 10, 25)) == 1
    assert lj.week_end(13) == date(2027, 1, 17) and lj.week_end(21) == date(2027, 3, 14)
    with pytest.raises(SystemExit):
        lj.check_look(FIRST, date(2027, 1, 17))
    lj.check_look(FIRST, date(2027, 1, 18))


def test_beats_and_no_worse_read_the_interval() -> None:
    g = lj.Gap(0.2, 0.1, 0.3)
    assert g.beats and g.no_worse
    g = lj.Gap(-0.05, -0.1, 0.02)
    assert not g.beats and g.no_worse
    assert not lj.Gap(-0.2, -0.3, -0.1).no_worse


@pytest.mark.parametrize(
    ("fn", "arms", "passes"),
    [
        (lj.lineup, {"plan": 0.3, "naive": 0.0, "market": 0.0}, True),
        (lj.lineup, {"plan": 0.0, "naive": 0.0, "market": 0.0}, False),
        (lj.streams, {"stream": 0.3, "all": 0.0, "naive": 0.0, "market": 0.0}, True),
        (lj.streams, {"stream": 0.3, "all": 0.0, "naive": 0.0, "market": 0.6}, False),
        (lj.swaps, {"review": 0.3, "stand_pat": 0.0, "naive": 0.0, "market": 0.0}, True),
        (lj.swaps, {"review": 0.3, "stand_pat": 0.3, "naive": 0.0, "market": 0.0}, False),
        (lj.top_adds, {"window": 0.3, "naive": 0.0, "market": 0.0, "projection": 0.0}, True),
        (lj.top_adds, {"window": 0.3, "naive": 0.0, "market": 0.0, "projection": 0.8}, False),
    ],
)
def test_a_planted_effect_passes_and_its_absence_fails(fn, arms, passes) -> None:  # type: ignore[no-untyped-def]
    assert fn(weekly(40, arms), FIRST)["passes"] is passes


def test_top_adds_comes_back_ranked_by_the_projection_when_only_it_beats_window() -> None:
    res = lj.top_adds(
        weekly(40, {"window": 0.3, "naive": 0.0, "market": 0.0, "projection": 0.8}), FIRST
    )
    assert res["outcome"].startswith("ranked by the projection")


def test_swaps_read_only_those_with_four_finished_weeks_after_them() -> None:
    res = lj.swaps(
        weekly(10, {"review": 0.3, "stand_pat": 0.0, "naive": 0.0, "market": 0.0}), FIRST
    )
    assert res["cases"] == 10 * 10  # weeks 1 to 10: swaps made to 21 December
    assert lj.WEEK_ONE + timedelta(days=7 * 9) == date(2026, 12, 21)


def _minutes(n: int, effect: float) -> pd.DataFrame:
    rng = np.random.default_rng(1)
    rows = []
    for i in range(n):
        base = rng.normal(5, 3)
        rows.append(
            {
                "week": 1 + i % 13,
                "call_gain": base + effect,
                "naive_gain": base + rng.normal(0, 1),
                "market_gain": base + rng.normal(0, 1),
                "pickup_value": 1.0 + effect,
                "naive_pickup_value": 1.0 + rng.normal(0, 0.2),
                "call_was_top_gainer": i % 3 == 0,
            }
        )
    return pd.DataFrame(rows)


def test_minutes_needs_150_cases_and_then_its_planted_gain_passes() -> None:
    assert lj.minutes(_minutes(149, 3.0), FIRST)["judged"] is False
    assert lj.minutes(_minutes(149, 3.0), FIRST)["passes"] is False
    assert lj.minutes(_minutes(300, 3.0), FIRST)["passes"] is True
    assert lj.minutes(_minutes(300, 0.0), FIRST)["passes"] is False


def _injury(n: int, good: bool) -> tuple[pd.DataFrame, pd.DataFrame]:
    rng = np.random.default_rng(2)
    missed = rng.integers(1, 10, n).astype(float)
    est = missed + rng.normal(0, 0.5 if good else 4.0, n)
    cases = pd.DataFrame(
        {
            "week": 1 + np.arange(n) % 13,
            "missed": missed,
            "estimate": est,
            "listing": np.ones(n),
            "so_far": np.maximum(1, missed - rng.integers(0, 6, n)),
            "return_date": np.where(np.arange(n) % 4 == 0, missed + rng.normal(0, 2, n), np.nan),
        }
    )
    il = weekly(20, {"estimate_rule": 0.1 if good else -0.5, "listing_rule": 0.0})
    return cases, il


def test_the_injury_estimate_passes_when_accurate_and_fails_when_not() -> None:
    assert lj.injury_estimate(*_injury(300, True), FIRST)["passes"] is True
    assert lj.injury_estimate(*_injury(300, False), FIRST)["passes"] is False
    assert lj.injury_estimate(*_injury(120, True), FIRST)["judged"] is False


def _chances(calibrated: bool) -> pd.DataFrame:
    rng = np.random.default_rng(3)
    rows = []
    for read in ("thursday", "saturday"):
        for i in range(4000):
            truth = rng.uniform(0.02, 0.98)
            won = float(rng.uniform() < truth)
            chance = truth if calibrated else float(np.clip(0.5 + 2.5 * (truth - 0.5), 0.01, 0.99))
            rows.append(
                {
                    "week": 1 + i % 13,
                    "read": read,
                    "chance": chance,
                    "naive": 0.5 + 0.5 * (truth - 0.5),
                    "outcome": won,
                }
            )
    return pd.DataFrame(rows)


def test_midweek_chances_need_calibration_as_well_as_brier() -> None:
    good = lj.midweek_chances(_chances(True), FIRST)
    assert good["passes"] is True
    assert 0.8 <= good["reported"]["thursday"]["slope"] <= 1.25
    bad = lj.midweek_chances(_chances(False), FIRST)
    assert bad["conditions"]["thursday_slope_in_range"] is False and bad["passes"] is False


def _calls(n: int, right_rate: float, day0: date = date(2026, 11, 2)) -> pd.DataFrame:
    rng = np.random.default_rng(4)
    rows = []
    for i in range(n):
        day = day0 + timedelta(days=i % 70)
        tip = datetime.combine(day, datetime.min.time()) + timedelta(hours=19)
        call = ["start", "sit", "add", "hold", "drop"][i % 5]
        right = rng.uniform() < right_rate
        good = (call in ("start", "add", "hold")) == right
        rows.append(
            {
                "player_id": f"p{i}",
                "day": day,
                "made_at": tip - timedelta(hours=3),
                "first_tipoff": tip,
                "call": call,
                "played_next": good,
                "next_value": 1.0 if good else -1.0,
                "replacement": 0.0,
                "value_per_game_7d": 1.0 if good else -1.0,
                "listed_out_or_doubtful": i % 2 == 0,
                "season_value_per_game": 1.0 if i % 3 == 0 else -1.0,
                "ownership_change_7d": 1.0 if i % 2 else -1.0,
            }
        )
    return pd.DataFrame(rows)


def test_the_notes_pass_on_planted_skill_and_need_200_calls_a_group() -> None:
    assert lj.notes(_calls(1500, 0.95), FIRST)["passes"] is True
    assert lj.notes(_calls(1500, 0.5), FIRST)["passes"] is False
    few = lj.notes(_calls(300, 0.95), FIRST)
    assert few["groups"] == {"start_sit": "not judged", "add_hold_drop": "not judged"}
    assert few["judged"] is False and few["passes"] is False


def test_a_call_after_the_days_first_tipoff_does_not_count_and_one_before_does() -> None:
    calls = _calls(5, 0.9).iloc[:1]
    late = calls.assign(made_at=calls["first_tipoff"] + timedelta(minutes=1), call="sit")
    early = calls.assign(made_at=calls["first_tipoff"] - timedelta(minutes=1), call="sit")
    assert lj.one_call_a_day(pd.concat([calls, late]))["call"].tolist() == [calls["call"].iloc[0]]
    assert lj.one_call_a_day(pd.concat([calls, early]))["call"].tolist() == ["sit"]


def test_a_row_after_the_cutoff_moves_no_score_and_the_same_row_a_day_earlier_does() -> None:
    base = weekly(20, {"plan": 0.3, "naive": 0.0, "market": 0.0})
    before = lj.lineup(base, FIRST)["gaps"]
    plant = {"plan": 50.0, "naive": 0.0, "market": 0.0}
    later = pd.concat([base, pd.DataFrame([{**plant, "week": lj.week_of(date(2027, 1, 18))}])])
    earlier = pd.concat([base, pd.DataFrame([{**plant, "week": lj.week_of(date(2027, 1, 17))}])])
    assert lj.lineup(later, FIRST)["gaps"] == before
    assert lj.lineup(earlier, FIRST)["gaps"] != before


def test_s1_is_reported_against_the_projection_and_against_the_placebo() -> None:
    from ops import s1_games_played as s1
    from ops import week_yardstick as wy

    rng = np.random.default_rng(5)
    weeks = []
    for k in range(8):
        line = np.abs(rng.normal(5, 2, (40, 11)))
        scheduled = rng.integers(2, 5, 40).astype(float)
        played = np.maximum(scheduled - rng.integers(0, 2, 40), 0)
        real = line * played[:, None]
        m = s1.Monday(
            as_of=date(2026, 11, 2) + timedelta(days=7 * k),
            players=[f"p{i}" for i in range(40)],
            scheduled=scheduled,
            listed=np.zeros(40, dtype=bool),
            line=line,
            real=real,
            games=played,
            proj=wy.category_weeks(line, scheduled, real),
        )
        weeks.append((m, scheduled * 0.85))  # a flat discount, nothing specific to anyone
    noise = [{"category": c, "noise": 0.01} for c in wy.CATEGORIES]
    res = lj.s1_confirmation(weeks, noise, FIRST)
    assert res["conditions"]["against_the_projection"] is True
    assert res["conditions"]["against_the_placebo"] is False  # the placebo is the same discount
    assert res["passes"] is True and res["passes_against_the_placebo"] is False
    short = lj.s1_confirmation(weeks[:5], noise, FIRST)
    assert short["judged"] is False
