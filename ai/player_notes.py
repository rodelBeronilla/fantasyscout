"""A one-line note for each flagged player (#823; ADR 0017), in three steps that run in one job on
the home runner (.github/workflows/player-notes.yml), passing their files on its disk: the inputs
and drafts hold source text, which never leaves the lakehouse and the owner-only storage.

    uv run python -m ai.player_notes inputs --out inputs.json
    uv run python -m ai.player_notes draft --inputs inputs.json --out draft.json
    uv run python -m ai.player_notes publish --inputs inputs.json --draft draft.json --store r2

``inputs`` picks, from the published build and without the model, the players the pages flag: an
injury listing (My Team's roster, Today, Pickups) or a flagged ESPN headline (the board, Pickups),
within the ranks a deep league rosters. Each comes with the numbers a line may use, rounded as it
should write them, and the texts it may draw on: the injury note, the flagged headline, and the
recent claims the local model read from the news (fct_player_claim) and the outlets' feed items
that name him (fct_player_rss_item), each with its row. ``draft`` asks the local model for one
line each; when the model is not there it says so and drafts nothing. ``publish`` checks every
line (player_note_check.py) and publishes the ones that pass to ``notes/players/<league>.json``,
with the rejections and their reasons.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections.abc import Sequence
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from ai import client
from ai.claim_schema import RSS_PREFIX
from ai.inputs import MAX_RANK, connect
from ai.notes import LEAGUES, build_id
from ai.player_note_check import check, line_schema
from ingest.landing import eastern_today

PROMPT = Path(__file__).resolve().parent / "prompts" / "player_notes.md"
LABEL = "AI-written from FantasyScout data and the news"
# the news a line may draw on: the claims and feed items of the last few days
DAYS = 3
# at most this many players a league, the best ranked first: a day's run stays short
MOST = 60
# players the model did not answer in a row before the run stands down: it has gone away
STOP_AFTER = 3
# a YouTube channel's claims (#851): source youtube:<channel>; a transcript chunk's id ends in
# its start in the video, <video_id>-t<seconds>, a title-and-description item's does not
YOUTUBE_PREFIX = "youtube:"
TRANSCRIPT_ID = re.compile(r"-t\d+$")

# metric -> (mart_board's column, decimals a line writes it with)
METRICS: dict[str, tuple[str, int]] = {
    "rank": ("rank_total", 0),
    "value_rest_of_season": ("value_rest_of_season", 1),
    "projected_minutes": ("proj_minutes_pg", 1),
    "availability_share": ("availability_multiplier", 2),
    "expected_games_missed": ("expected_games_missed", 1),
    "games_this_week": ("games_this_week", 0),
    "games_remaining": ("games_remaining", 0),
}
# how the model sees each metric: plain words
LABELS: dict[str, str] = {
    "rank": "board rank",
    "value_rest_of_season": "rest-of-season value",
    "projected_minutes": "projected minutes",
    "availability_share": "share of games expected to play",
    "expected_games_missed": "games expected to miss",
    "games_this_week": "games this week",
    "games_remaining": "games left",
}
# the claims' kinds in words
KINDS = {
    "role_up": "a bigger role",
    "role_down": "a smaller role",
    "minutes_up": "more minutes",
    "minutes_down": "fewer minutes",
    "injury_out": "will miss games",
    "injury_return": "returns",
    "injury_worse": "injury worse",
    "injury_better": "injury better",
    "trade_rumor": "trade rumor",
    "other": "other",
}


def _rows(con: Any, sql: str, params: list[Any]) -> list[dict[str, Any]]:
    cur = con.execute(sql, params)
    names = [d[0] for d in cur.description]
    return [dict(zip(names, r, strict=True)) for r in cur.fetchall()]


def _has(con: Any, table: str) -> bool:
    found = con.execute(
        "select count(*) from information_schema.tables where table_name = ?", [table]
    ).fetchone()
    return bool(found and found[0])


def _num(value: Any, digits: int) -> float | None:
    if value is None:
        return None
    v = float(value)
    return None if v != v else round(v, digits)  # NaN is no number


def flagged(con: Any, league: str) -> list[dict[str, Any]]:
    """The board rows the pages flag, within the ranks a deep league rosters, best first."""
    cols = sorted({c for c, _ in METRICS.values()})
    return _rows(
        con,
        f"""
        select player_id, full_name, team_abbreviation, injury_status, injury_group, injury_type,
               expected_return, injury_note, news_flag, news_headline, news_date, {", ".join(cols)}
        from mart_board
        where league = ? and rank_total <= ?
          and (coalesce(injury_group, 'healthy') <> 'healthy' or news_flag is not null)
        order by rank_total, player_id
        limit ?
        """,
        [league, MAX_RANK.get(league, 200), MOST],
    )


def quotable_claim(source: str, source_id: str) -> bool:
    """Whether a line may quote a claim's words: only when they are a headline's, a feed item's
    title or summary, or a YouTube video's title or description. A transcript chunk's are speech
    (its id ends in its start, ``<video_id>-t<seconds>``) and an injury note is the desk's prose:
    their numbers may inform a line, their words are never quoted."""
    if source == "espn_news" or source.startswith(RSS_PREFIX):
        return True
    if source.startswith(YOUTUBE_PREFIX):
        return TRANSCRIPT_ID.search(source_id) is None
    return False


def claim_texts(con: Any, league: str, since: date) -> dict[str, list[dict[str, Any]]]:
    """Each player's recent claims, as texts a line may draw on, newest first."""
    if not _has(con, "fct_player_claim"):
        return {}
    out: dict[str, list[dict[str, Any]]] = {}
    for r in _rows(
        con,
        """
        select stats_player_id, source, source_id, kind, quote, published_date
        from fct_player_claim
        where league = ? and published_date >= ?
        order by published_date desc, confidence desc, source_id
        """,
        [league, since],
    ):
        out.setdefault(str(r["stats_player_id"]), []).append(
            {
                "what": f"claim: {KINDS.get(r['kind'], r['kind'])}",
                "text": r["quote"],
                "date": str(r["published_date"]),
                "row_ref": f"fct_player_claim/{league}/{r['source']}/{r['source_id']}",
                "quotable": quotable_claim(str(r["source"]), str(r["source_id"])),
            }
        )
    return out


def feed_texts(con: Any, league: str, since: date) -> dict[str, list[dict[str, Any]]]:
    """Each player's recent outlet feed headlines, newest first."""
    if not _has(con, "fct_player_rss_item"):
        return {}
    out: dict[str, list[dict[str, Any]]] = {}
    for r in _rows(
        con,
        """
        select stats_player_id, item_id, outlet, title, published_date
        from fct_player_rss_item
        where league = ? and published_date >= ? and title is not null
        order by published_date desc, item_id
        """,
        [league, since],
    ):
        out.setdefault(str(r["stats_player_id"]), []).append(
            {
                "what": f"headline from {r['outlet'] or 'an outlet'}",
                "text": r["title"],
                "date": str(r["published_date"]),
                "row_ref": f"fct_player_rss_item/{league}/{r['item_id']}",
                "quotable": True,
            }
        )
    return out


def player_input(
    r: dict[str, Any], league: str, news: list[dict[str, Any]], as_of: str
) -> dict[str, Any]:
    """One flagged player's input: his numbers (as the weekly notes' validator reads them, the
    value under ``after``) and the texts a line may draw on, each with its row."""
    pid = str(r["player_id"])
    ref = f"mart_board/{league}/{pid}/{as_of}"
    metrics = {
        m: {"after": v}
        for m, (col, digits) in METRICS.items()
        if (v := _num(r.get(col), digits)) is not None
    }
    texts: list[dict[str, Any]] = []
    if r.get("injury_note"):
        texts.append(
            {"what": "injury note", "text": r["injury_note"], "row_ref": ref, "quotable": False}
        )
    if r.get("expected_return"):
        texts.append(
            {
                "what": "expected return",
                "text": str(r["expected_return"]),
                "row_ref": ref,
                "quotable": False,
            }
        )
    if r.get("news_headline"):
        texts.append(
            {
                "what": "flagged ESPN headline",
                "text": r["news_headline"],
                "date": str(r.get("news_date") or ""),
                "row_ref": ref,
                "quotable": True,
            }
        )
    texts += news
    return {
        "player_id": pid,
        "name": r["full_name"],
        "team": r["team_abbreviation"] or "",
        "injury_status": r.get("injury_status"),
        "injury_type": r.get("injury_type"),
        "news_flag": r.get("news_flag"),
        "row_ref": ref,
        "metrics": metrics,
        "texts": texts,
    }


def make_inputs(source: str | None, today: date | None = None) -> dict[str, Any]:
    con = connect(source)
    day = today or eastern_today()
    since = day - timedelta(days=DAYS)
    sets = []
    for league in LEAGUES:
        claims = claim_texts(con, league, since)
        feeds = feed_texts(con, league, since)
        players = [
            player_input(
                r,
                league,
                claims.get(str(r["player_id"]), []) + feeds.get(str(r["player_id"]), []),
                day.isoformat(),
            )
            for r in flagged(con, league)
        ]
        sets.append({"league": league, "as_of": day.isoformat(), "players": players})
    return {"build_id": build_id(), "sets": sets}


def model_view(inp: dict[str, Any]) -> dict[str, Any]:
    """What the model is given for one player: the numbers under plain names, and the texts."""
    return {
        "player_id": inp["player_id"],
        "player": inp["name"],
        "team": inp["team"],
        "injury status": inp.get("injury_status") or "healthy",
        "injury": inp.get("injury_type"),
        "numbers": {LABELS.get(m, m): v["after"] for m, v in inp["metrics"].items()},
        "news": [
            {
                "what": t["what"],
                "date": t.get("date"),
                "may quote": bool(t.get("quotable")),
                "text": t["text"],
            }
            for t in inp["texts"]
        ],
    }


def draft(
    inputs: dict[str, Any], *, url: str | None = None, limit: int | None = None
) -> dict[str, Any]:
    """One line per player; nothing, and the reason, when the model is not there."""
    away = client.unavailable(url=url)
    if away:
        print(f"no notes drafted: {away}")
        return {"model": client.model_name(), "unavailable": away, "drafts": []}
    system = PROMPT.read_text(encoding="utf-8")
    schema = line_schema()
    out: list[dict[str, Any]] = []
    misses = 0
    for s in inputs["sets"]:
        for inp in s["players"][:limit]:
            started = time.monotonic()
            entry: dict[str, Any] = {"league": s["league"], "player_id": inp["player_id"]}
            try:
                view = json.dumps(model_view(inp), ensure_ascii=False, default=str)
                entry["note"] = client.chat_json(system, view, schema, url=url)
                misses = 0
            except Exception as e:  # this one failed: logged, the rest go on
                entry["error"] = f"{type(e).__name__}: {e}"[:300]
                misses += 1
            entry["seconds"] = round(time.monotonic() - started, 1)
            out.append(entry)
            if misses >= STOP_AFTER:
                print(f"the model did not answer {misses} players in a row: standing down")
                return {"model": client.model_name(), "drafts": out}
    return {"model": client.model_name(), "drafts": out}


def review(inputs: dict[str, Any], drafts: dict[str, Any]) -> dict[str, Any]:
    """Every line checked against its input: the notes to publish per league, and the rejections."""
    found = {(d["league"], d["player_id"]): d for d in drafts["drafts"]}
    leagues: dict[str, Any] = {}
    for s in inputs["sets"]:
        published: dict[str, Any] = {}
        rejected: list[dict[str, Any]] = []
        for inp in s["players"]:
            d = found.get((s["league"], inp["player_id"]))
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
            note, reasons = check(d["note"], inp)
            if note is None:
                rejected.append(
                    {"player_id": inp["player_id"], "name": inp["name"], "reasons": reasons}
                )
                continue
            published[inp["player_id"]] = {
                "line": note.line,
                "sources": [x.model_dump() for x in note.sources],
                # the page shows a line only while the player's listing is the one it was written on
                "injury_status": inp.get("injury_status"),
                "news_flag": inp.get("news_flag"),
            }
        if published or rejected:
            leagues[s["league"]] = {
                "league": s["league"],
                "label": LABEL,
                "model": drafts.get("model"),
                "as_of": s["as_of"],
                "build_id": inputs.get("build_id"),
                "counts": {
                    "drafted": len(published) + len(rejected),
                    "published": len(published),
                    "rejected": len(rejected),
                },
                "notes": published,
                "rejected": rejected,
            }
    return leagues


def publish(
    inputs: dict[str, Any], drafts: dict[str, Any], *, store_kind: str, out: Path
) -> dict[str, Any]:
    """The lines that pass, to notes/players/<league>.json (R2, and a copy under ``out``). A
    league with nothing drafted (the model was away) keeps the file it had: the page shows a line
    only while it still holds. The log says the counts and each rejection's reasons, which name
    numbers and word counts, never a source's words."""
    from export.cli import make_store
    from export.encode import to_json
    from export.store import LocalStore

    leagues = review(inputs, drafts)
    stores = [make_store(store_kind, out)]
    if store_kind != "local":
        stores.append(LocalStore(out))
    for league, doc in leagues.items():
        body = to_json(doc)
        for store in stores:
            store.put(f"notes/players/{league}.json", body)
        c = doc["counts"]
        print(
            f"{league}: {c['published']} published, {c['rejected']} rejected"
            f" of {c['drafted']} drafted"
        )
        for r in doc["rejected"]:
            print(f"  {r['player_id']}: {'; '.join(r['reasons'])}")
    if not leagues:
        print("nothing drafted: the published notes stand")
    return leagues


def _read(path: str) -> dict[str, Any]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        msg = f"{path} is not a JSON object"
        raise ValueError(msg)
    return data


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="ai.player_notes", description=__doc__.split("\n\n")[0] if __doc__ else None
    )
    sub = parser.add_subparsers(dest="command", required=True)
    p_in = sub.add_parser("inputs", help="pick the flagged players from the published build")
    p_in.add_argument("--source", default=None, help="published (default in CI) or local")
    p_in.add_argument("--out", required=True)
    p_dr = sub.add_parser("draft", help="ask the local model for one line per player")
    p_dr.add_argument("--inputs", required=True)
    p_dr.add_argument("--out", required=True)
    p_dr.add_argument("--limit", type=int, default=None, help="at most this many per league")
    p_pu = sub.add_parser("publish", help="check the lines and publish the ones that pass")
    p_pu.add_argument("--inputs", required=True)
    p_pu.add_argument("--draft", required=True)
    p_pu.add_argument("--store", choices=("local", "r2"), default="local")
    p_pu.add_argument("--out", default="_player_notes")
    args = parser.parse_args(argv)
    if args.command == "inputs":
        data = make_inputs(args.source)
        Path(args.out).write_text(
            json.dumps(data, ensure_ascii=False, indent=1, default=str), encoding="utf-8"
        )
        for s in data["sets"]:
            print(f"{s['league']} {s['as_of']}: {len(s['players'])} flagged players")
        return 0
    if args.command == "draft":
        result = draft(_read(args.inputs), limit=args.limit)
        Path(args.out).write_text(
            json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        failed = sum(1 for d in result["drafts"] if "error" in d)
        print(f"drafted {len(result['drafts'])} lines with {result['model']}; {failed} failed")
        return 0
    publish(_read(args.inputs), _read(args.draft), store_kind=args.store, out=Path(args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
