"""The weekly scouting notes (SPEC.md, "Weekly scouting notes"; ADR 0017), in three steps that run
where each belongs (.github/workflows/notes.yml):

    uv run python -m ai.notes inputs --out inputs.json [--eval-dates 6]     # a GitHub runner
    uv run python -m ai.notes draft --inputs inputs.json --out draft.json    # the home runner
    uv run python -m ai.notes publish --inputs inputs.json --draft draft.json --store r2

``inputs`` picks the players from the published build without the model; ``draft`` asks the
local model for one note each; ``publish`` re-checks every note against the inputs (validate.py),
publishes the ones that pass to ``notes/<league>.json`` with the rejections and their reasons, and
the eval of past weeks to ``notes/evals.json``.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ai import client
from ai.inputs import connect, model_view, select, snapshot_dates
from ai.schema import draft_schema
from ai.validate import check, decimals_of, numbers_in, trace

LEAGUES = ("nba", "wnba")
PROMPT = Path(__file__).resolve().parent / "prompts" / "notes.md"
SITE = os.environ.get("FS_SITE_URL", "https://fantasyscout.beronilla.rodeo").rstrip("/")
LABEL = "AI-drafted from FantasyScout data"


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def build_id() -> str | None:
    pinned = os.environ.get("FS_BUILD_ID")
    if pinned:
        return pinned
    try:
        with urllib.request.urlopen(f"{SITE}/data/latest.json", timeout=30) as r:
            return str(json.load(r).get("build_id"))
    except Exception:
        return None


def make_inputs(source: str | None, eval_dates: int, days: int = 7) -> dict[str, Any]:
    con = connect(source)
    sets: list[dict[str, Any]] = []
    for league in LEAGUES:
        dates = snapshot_dates(con, league)
        current = select(con, league, days=days)
        current["kind"] = "current"
        sets.append(current)
        # the eval: the same selection on earlier snapshots (SPEC.md, "Eval")
        for as_of in dates[-1 - eval_dates : -1] if eval_dates else []:
            past = select(con, league, as_of=as_of, days=days)
            if past["players"]:
                past["kind"] = "eval"
                sets.append(past)
    return {"created_at": _now(), "build_id": build_id(), "sets": sets}


def draft(
    inputs: dict[str, Any], *, url: str | None = None, limit: int | None = None
) -> dict[str, Any]:
    system = PROMPT.read_text(encoding="utf-8")
    schema = draft_schema()
    out: list[dict[str, Any]] = []
    for s in inputs["sets"]:
        for inp in s["players"][:limit]:
            started = time.monotonic()
            entry: dict[str, Any] = {
                "league": s["league"],
                "after": s["after"],
                "player_id": inp["player_id"],
            }
            try:
                view = json.dumps(model_view(inp), ensure_ascii=False)
                entry["note"] = client.chat_json(system, view, schema, url=url)
            except Exception as e:  # the model failed this one: logged, the rest go on
                entry["error"] = f"{type(e).__name__}: {e}"[:300]
            entry["seconds"] = round(time.monotonic() - started, 1)
            out.append(entry)
    return {"created_at": _now(), "model": client.model_name(), "drafts": out}


def review(inputs: dict[str, Any], drafts: dict[str, Any]) -> dict[str, Any]:
    """Every draft checked against its input: the notes to publish per league, and the eval."""
    found = {(d["league"], d["after"], d["player_id"]): d for d in drafts["drafts"]}
    leagues: dict[str, Any] = {}
    evals: dict[str, Any] = {}
    for s in inputs["sets"]:
        published: list[dict[str, Any]] = []
        rejected: list[dict[str, Any]] = []
        claims = verified = 0
        for inp in s["players"]:
            d = found.get((s["league"], s["after"], inp["player_id"]))
            if d is None:
                continue
            if "note" not in d:
                rejected.append(
                    {
                        "player_id": inp["player_id"],
                        "name": inp["name"],
                        "reasons": [d.get("error", "no answer")],
                    }
                )
                continue
            # the eval's claim accuracy: of every number the drafts wrote, the build's share
            raw = d["note"] if isinstance(d["note"], dict) else {}
            written = numbers_in(f"{raw.get('headline', '')} {raw.get('body', '')}")
            claims += len(written)
            verified += sum(1 for tok, v in written if trace(v, inp, decimals_of(tok)) is not None)
            note, reasons = check(d["note"], inp)
            if note is None:
                rejected.append(
                    {"player_id": inp["player_id"], "name": inp["name"], "reasons": reasons}
                )
                continue
            published.append(
                {
                    **note.model_dump(),
                    "name": inp["name"],
                    "team": inp["team"],
                    "reason": inp["reason"],
                    "row_ref": inp["row_ref"],
                    "metrics": inp["metrics"],
                }
            )
        drafted = len(published) + len(rejected)
        summary = {
            "drafted": drafted,
            "published": len(published),
            "rejected": len(rejected),
            "numbers_written": claims,
            "numbers_traced": verified,
        }
        if s.get("kind") == "eval":
            evals.setdefault(s["league"], []).append(
                {"after": s["after"], "before": s["before"], **summary}
            )
        else:
            leagues[s["league"]] = {
                "league": s["league"],
                "label": LABEL,
                "model": drafts.get("model"),
                "generated_at": drafts.get("created_at"),
                "build_id": inputs.get("build_id"),
                "compared": {"before": s["before"], "after": s["after"]},
                "counts": summary,
                "notes": published,
                "rejected": rejected,
            }
    return {"leagues": leagues, "evals": evals}


def eval_summary(evals: dict[str, Any], model: str | None) -> dict[str, Any]:
    out: dict[str, Any] = {"model": model, "generated_at": _now(), "leagues": {}}
    for league, weeks in evals.items():
        drafted = sum(w["drafted"] for w in weeks)
        claims = sum(w["numbers_written"] for w in weeks)
        verified = sum(w["numbers_traced"] for w in weeks)
        out["leagues"][league] = {
            "weeks": weeks,
            "drafted": drafted,
            "rejection_rate": round(sum(w["rejected"] for w in weeks) / drafted, 3)
            if drafted
            else None,
            # every number in a published note is traced to the build, or the note is not published
            "published_claims_verified": 1.0 if drafted else None,
            # of every number the drafts wrote, published or not, the share that is the build's
            "claim_accuracy": round(verified / claims, 3) if claims else None,
        }
    return out


def _store(kind: str, out: Path) -> Any:
    from export.cli import make_store

    return make_store(kind, out)


def publish(
    inputs: dict[str, Any], drafts: dict[str, Any], *, store_kind: str, out: Path
) -> dict[str, Any]:
    from export.encode import to_json

    result = review(inputs, drafts)
    store = _store(store_kind, out)
    for league, doc in result["leagues"].items():
        body = to_json(doc)
        store.put(f"notes/{league}.json", body)
        if doc["compared"]["after"]:
            store.put(f"notes/archive/{doc['compared']['after']}/{league}.json", body)
        c = doc["counts"]
        print(
            f"{league}: {c['published']} published, {c['rejected']} rejected"
            f" of {c['drafted']} drafted"
        )
    if result["evals"]:
        summary = eval_summary(result["evals"], drafts.get("model"))
        store.put("notes/evals.json", to_json(summary))
        for league, s in summary["leagues"].items():
            print(
                f"{league} eval: claim accuracy {s['claim_accuracy']},"
                f" rejection rate {s['rejection_rate']} over {len(s['weeks'])} weeks"
            )
    return result


def _read(path: str) -> dict[str, Any]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        msg = f"{path} is not a JSON object"
        raise ValueError(msg)
    return data


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="ai.notes", description=__doc__.split("\n\n")[0] if __doc__ else None
    )
    sub = parser.add_subparsers(dest="command", required=True)
    p_in = sub.add_parser("inputs", help="pick the players from the published build")
    p_in.add_argument("--source", default=None, help="published (default in CI) or local")
    p_in.add_argument(
        "--eval-dates", type=int, default=0, help="earlier snapshots to draft for the eval"
    )
    p_in.add_argument("--out", required=True)
    p_dr = sub.add_parser("draft", help="ask the local model for one note per player")
    p_dr.add_argument("--inputs", required=True)
    p_dr.add_argument("--out", required=True)
    p_dr.add_argument(
        "--limit", type=int, default=None, help="at most this many players per set (a smoke test)"
    )
    p_pu = sub.add_parser("publish", help="validate the drafts and publish the notes")
    p_pu.add_argument("--inputs", required=True)
    p_pu.add_argument("--draft", required=True)
    p_pu.add_argument("--store", choices=("local", "r2"), default="local")
    p_pu.add_argument("--out", default="_notes")
    args = parser.parse_args(argv)
    if args.command == "inputs":
        data = make_inputs(args.source, args.eval_dates)
        Path(args.out).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        for s in data["sets"]:
            print(
                f"{s['league']} {s.get('kind')} {s['before']}..{s['after']}:"
                f" {len(s['players'])} players"
            )
        return 0
    if args.command == "draft":
        result = draft(_read(args.inputs), limit=args.limit)
        Path(args.out).write_text(
            json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        failed = sum(1 for d in result["drafts"] if "error" in d)
        print(f"drafted {len(result['drafts'])} notes with {result['model']}; {failed} failed")
        return 0
    publish(_read(args.inputs), _read(args.draft), store_kind=args.store, out=Path(args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
