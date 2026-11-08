"""Claims from the news the lakehouse already lands (#812, #833; ADR 0017), in two steps that run
where each belongs (.github/workflows/claims.yml):

    uv run python -m ai.claims inputs --source published --out claim-inputs.json   # GitHub runner
    uv run python -m ai.claims extract --inputs claim-inputs.json --backend volume   # home runner

``inputs`` reads, from the published build, the recent ESPN headlines (fct_player_news), the
ESPN injury notes on the current report (fct_availability) and the recent items of the outlets'
feeds (fct_player_rss_item: the headline, and the feed's summary where its terms allow), each with
the league players the lakehouse linked it to: through its crosswalks for ESPN, by the players'
whole names for a feed. An item no player is linked to is left out, so a claim's player is always
a league player. A feed item's source is ``rss:<feed_id>``.

``extract`` asks the local model for each item's claims, checks them (claim_check.py) and lands
each item's claims, the rejected ones with their reasons, and the text they were read from, as
one file under ``landing/ai/claims/<league>/<season>/<date>/``, through the ingest's Landing (a
sidecar per file, a per-scope index). An item already landed is not asked again, so a re-run
asks the model nothing and writes nothing; ``--full-refresh`` asks again. When the model is not
there, it says so and exits 0: the claims wait for the next run.

The claims are not shown on the site and change no number. They are kept, dated by when the
source said them, so the walk-forward harness (#769) can score each source's track record before
any of them may tune a projection (#812).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from collections import Counter
from collections.abc import Callable, Sequence
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from ai import client
from ai.claim_check import review
from ai.claim_schema import RSS_PREFIX, extraction_schema
from ai.inputs import connect
from ai.notes import build_id
from ingest.land import default_season, make_backend
from ingest.landing import eastern_today
from ingest.store import Landing, Scope

PROMPT = Path(__file__).resolve().parent / "prompts" / "claims.md"
DAYS = 3
# consecutive items the model did not answer before the run stands down: it has gone away
STOP_AFTER = 3
SOURCE_LABEL = {"espn_news": "an ESPN headline", "espn_injury_note": "an ESPN injury note"}

Log = Callable[[str], None]


def _now() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


def prompt_version() -> str:
    """The prompt's content hash, landed with every claim: a change of prompt is visible."""
    return hashlib.sha256(PROMPT.read_bytes()).hexdigest()[:12]


def _rows(con: Any, sql: str, params: list[Any]) -> list[dict[str, Any]]:
    cur = con.execute(sql, params)
    names = [d[0] for d in cur.description]
    return [dict(zip(names, r, strict=True)) for r in cur.fetchall()]


def news_items(con: Any, since: date) -> list[dict[str, Any]]:
    """One item per ESPN headline published since the date, with its linked players."""
    rows = _rows(
        con,
        """
        select n.league, cast(n.article_id as varchar) as article_id, n.headline,
               n.published_at, n.published_date, n.stats_player_id,
               coalesce(p.full_name, n.stats_player_id) as full_name
        from fct_player_news as n
        left join (select * from dim_player where is_current) as p
          on p.league = n.league and p.stats_player_id = n.stats_player_id
        where n.stats_player_id is not null and n.headline is not null
          and n.published_date >= ?
        order by n.published_at desc, n.article_id, n.stats_player_id
        """,
        [since],
    )
    items: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows:
        published: datetime = r["published_at"]
        # a naive timestamp is UTC (the lakehouse's convention); an aware one is put in UTC
        published = (
            published.replace(tzinfo=UTC) if published.tzinfo is None else published.astimezone(UTC)
        )
        item = items.setdefault(
            (r["league"], r["article_id"]),
            {
                "league": r["league"],
                "season": default_season(r["league"], r["published_date"]),
                "source": "espn_news",
                "source_id": r["article_id"],
                "published_at": published.isoformat(),
                "published_date": r["published_date"].isoformat(),
                "text": r["headline"],
                "players": [],
            },
        )
        if all(p["player_id"] != r["stats_player_id"] for p in item["players"]):
            item["players"].append({"player_id": r["stats_player_id"], "name": r["full_name"]})
    return list(items.values())


def injury_note_text(short: str | None, long: str | None) -> str:
    return "\n".join(t.strip() for t in (short, long) if t and t.strip())


def injury_items(con: Any) -> list[dict[str, Any]]:
    """One item per ESPN injury note on the current report, for a linked player. A note's id is
    its listing and its text's hash, so an edited note is a new item. ESPN dates a listing by its
    UTC day (silver.injuries), the day the note is taken to be said: never earlier than it was."""
    rows = _rows(
        con,
        """
        select league, season, cast(injury_id as varchar) as injury_id, stats_player_id,
               athlete_name, short_comment, long_comment,
               coalesce(reported_date, report_date) as said_on
        from fct_availability
        where is_current and stats_player_id is not null
          and coalesce(long_comment, short_comment) is not null
        order by league, injury_id
        """,
        [],
    )
    out: list[dict[str, Any]] = []
    for r in rows:
        text = injury_note_text(r["short_comment"], r["long_comment"])
        if not text or r["said_on"] is None:
            continue
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
        said_on: date = r["said_on"]
        out.append(
            {
                "league": r["league"],
                "season": r["season"] or default_season(r["league"], said_on),
                "source": "espn_injury_note",
                "source_id": f"{r['injury_id']}-{digest}",
                "published_at": datetime(
                    said_on.year, said_on.month, said_on.day, tzinfo=UTC
                ).isoformat(),
                "published_date": said_on.isoformat(),
                "text": text,
                "players": [{"player_id": r["stats_player_id"], "name": r["athlete_name"]}],
            }
        )
    return out


def rss_text(title: str, summary: str | None) -> str:
    """A feed item as the model reads it: the headline, and the feed's summary on its own line."""
    return "\n".join(t.strip() for t in (title, summary) if t and t.strip())


def rss_items(con: Any, since: date) -> list[dict[str, Any]]:
    """One item per outlet feed item published since the date, with the league players it names
    (fct_player_rss_item; an item naming none has no row there). Its source is the feed,
    ``rss:<feed_id>``; it is dated by the outlet's publish time, never later than when a feed
    first carried it. A build published before the feeds were landed has no such table: none."""
    present = con.execute(
        "select count(*) from information_schema.tables where table_name = 'fct_player_rss_item'"
    ).fetchone()
    if not present or not present[0]:
        return []
    rows = _rows(
        con,
        """
        select league, season, item_id, feed_id, outlet, title, summary, published_date,
               least(coalesce(published_at, first_seen_at), first_seen_at) as said_at,
               stats_player_id, full_name
        from fct_player_rss_item
        where published_date >= ? and title is not null
        order by said_at desc, item_id, stats_player_id
        """,
        [since],
    )
    items: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows:
        said: datetime = r["said_at"]
        said = said.replace(tzinfo=UTC) if said.tzinfo is None else said.astimezone(UTC)
        item = items.setdefault(
            (r["league"], r["item_id"]),
            {
                "league": r["league"],
                "season": r["season"] or default_season(r["league"], r["published_date"]),
                "source": f"{RSS_PREFIX}{r['feed_id']}",
                "source_id": r["item_id"],
                "outlet": r["outlet"],
                "published_at": said.isoformat(),
                "published_date": r["published_date"].isoformat(),
                "text": rss_text(r["title"], r["summary"]),
                "players": [],
            },
        )
        if all(p["player_id"] != r["stats_player_id"] for p in item["players"]):
            item["players"].append({"player_id": r["stats_player_id"], "name": r["full_name"]})
    return list(items.values())


def make_inputs(source: str | None, days: int, today: date | None = None) -> dict[str, Any]:
    con = connect(source)
    since = (today or eastern_today()) - timedelta(days=days)
    items = news_items(con, since) + injury_items(con) + rss_items(con, since)
    return {
        "created_at": _now().isoformat(),
        "build_id": build_id(),
        "since": since.isoformat(),
        "items": items,
    }


def item_key(item: dict[str, Any]) -> str:
    return f"{item['source']}-{item['source_id']}"


def source_label(item: dict[str, Any]) -> str:
    """What kind of item the model reads, in words."""
    if item["source"].startswith(RSS_PREFIX):
        what = "a headline and its summary" if "\n" in item["text"] else "a headline"
        return f"{what} from {item.get('outlet') or 'an outlet'}'s news feed"
    return SOURCE_LABEL[item["source"]]


def model_view(item: dict[str, Any]) -> dict[str, Any]:
    """What the model is given for one item."""
    return {
        "source": source_label(item),
        "date": item["published_date"],
        "players": item["players"],
        "text": item["text"],
    }


def _body(
    item: dict[str, Any], claims: list[Any], rejected: list[Any], meta: dict[str, str]
) -> bytes:
    doc = {
        **{k: item[k] for k in ("source", "source_id", "league", "season")},
        **{k: item[k] for k in ("published_at", "published_date", "text", "players")},
        **meta,
        "claims": [c.model_dump(mode="json") for c in claims],
        "rejected": rejected,
    }
    return json.dumps(doc, ensure_ascii=False, sort_keys=True, indent=1).encode("utf-8")


def extract(
    inputs: dict[str, Any],
    landing: Landing,
    *,
    url: str | None = None,
    http: httpx.Client | None = None,
    limit: int | None = None,
    log: Log = print,
) -> Counter[str]:
    """Each new item's claims, checked and landed; the counts of what happened."""
    system = PROMPT.read_text(encoding="utf-8")
    schema = extraction_schema()
    model = client.model_name()
    endpoint = f"{client.base_url(url)}/api/chat"
    params = {"model": model, "prompt": prompt_version()}
    counts: Counter[str] = Counter()
    misses = 0
    for item in inputs.get("items", [])[:limit]:
        scope = Scope("ai", "claims", item["league"], item["season"])
        key = item_key(item)
        if landing.has_landed(scope, key):
            counts["already landed"] += 1
            continue
        started = _now()
        try:
            view = json.dumps(model_view(item), ensure_ascii=False)
            raw: Any = client.chat_json(system, view, schema, url=url, model=model, client=http)
        except httpx.HTTPError as e:  # not answered: the item is asked again next run
            counts["not answered"] += 1
            misses += 1
            log(f"  {key}: the model did not answer ({type(e).__name__})")
            if misses >= STOP_AFTER:
                log(f"the model did not answer {misses} items in a row: standing down")
                break
            continue
        except (ValueError, KeyError) as e:  # answered, but not JSON: landed as rejected
            raw = {"error": f"{type(e).__name__}: {e}"[:200]}
        misses = 0
        claims, rejected = review(item, raw)
        meta = {**params, "extracted_at": started.isoformat()}
        landing.land(
            scope,
            key,
            _body(item, claims, rejected, meta),
            url=endpoint,
            params=params,
            status=200,
            fetched_at=started,
        )
        counts["items"] += 1
        counts["claims"] += len(claims)
        counts["rejected"] += len(rejected)
    return counts


def _warn(message: str) -> None:
    prefix = "::warning::" if os.environ.get("GITHUB_ACTIONS") else "warning: "
    print(f"{prefix}{message}")


def _read(path: str) -> dict[str, Any]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        msg = f"{path} is not a JSON object"
        raise ValueError(msg)
    return data


def run_extract(args: argparse.Namespace) -> int:
    inputs = _read(args.inputs)
    reason = client.unavailable()
    if reason:
        # the model lives on the home server and is sometimes away: nothing is lost, the items
        # are asked next run, and nothing fails or opens an incident
        _warn(f"{reason}; no claims extracted this run")
        return 0
    backend = make_backend(args.backend, Path(args.root))
    landing = Landing(backend, ingest_date=eastern_today(), full_refresh=args.full_refresh)
    try:
        counts = extract(inputs, landing, limit=args.limit)
    finally:
        failures = landing.flush()
        landing.close()
    print(
        f"{len(inputs.get('items', []))} items: {counts['items']} read by {client.model_name()},"
        f" {counts['already landed']} already landed, {counts['not answered']} not answered;"
        f" {counts['claims']} claims kept, {counts['rejected']} rejected"
    )
    for f in failures:
        print(f"  failed to write {f.endpoint}/{f.key}: {f.error}", file=sys.stderr)
    return 1 if failures else 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="ai.claims", description=__doc__.split("\n\n")[0] if __doc__ else None
    )
    sub = parser.add_subparsers(dest="command", required=True)
    p_in = sub.add_parser("inputs", help="read the recent news and injury notes from the build")
    p_in.add_argument("--source", default=None, help="published (default in CI) or local")
    p_in.add_argument("--days", type=int, default=DAYS, help="headlines published this recently")
    p_in.add_argument("--out", required=True)
    p_ex = sub.add_parser("extract", help="ask the local model for each new item's claims")
    p_ex.add_argument("--inputs", required=True)
    p_ex.add_argument("--backend", choices=("local", "volume"), default="local")
    p_ex.add_argument("--root", default=".", help="the local backend's root")
    p_ex.add_argument("--full-refresh", action="store_true", help="ask again for landed items")
    p_ex.add_argument("--limit", type=int, default=None, help="at most this many items")
    args = parser.parse_args(argv)
    if args.command == "inputs":
        data = make_inputs(args.source, args.days)
        Path(args.out).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        by_source = Counter(i["source"] for i in data["items"])
        print(
            f"{len(data['items'])} items since {data['since']}: {dict(sorted(by_source.items()))}"
        )
        return 0
    return run_extract(args)


if __name__ == "__main__":
    sys.exit(main())
