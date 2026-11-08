"""Claims from the news (#812, #833): the schema, the quote and player checks, the confidence cap,
dedup, and idempotent landing, with the local model faked by a mock transport."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

import duckdb
import httpx
import pytest
from pydantic import ValidationError

from ai import claims, client
from ai.claim_check import cap, locate, review
from ai.claim_schema import KINDS, Extraction, SourceClaim, extraction_schema
from ingest.store import Landing, LocalBackend

ROOT = Path(__file__).resolve().parent.parent
CURLY = chr(0x2019)  # the right single quote ESPN writes for an apostrophe
NEWS: dict[str, Any] = {
    "league": "nba",
    "season": "2026-27",
    "source": "espn_news",
    "source_id": "46969411",
    "published_at": "2026-10-30T01:22:00+00:00",
    "published_date": "2026-10-29",
    "text": f"Knicks{CURLY} Jose Alvarado (ankle) to miss fourth straight vs. 76ers",
    "players": [{"player_id": "1628407", "name": "Jose Alvarado"}],
}
NOTE: dict[str, Any] = {
    **NEWS,
    "source": "espn_injury_note",
    "source_id": "501-abc",
    "text": "Smith (knee) has been ruled out for Friday.\nHe could return next week.",
    "players": [{"player_id": "7", "name": "Sam Smith"}],
}


def claim(**extra: Any) -> dict[str, Any]:
    return {
        "player_id": "1628407",
        "kind": "injury_out",
        "direction": -1,
        "confidence": 0.9,
        "quote": "to miss fourth straight",
        **extra,
    }


# the schema


def test_the_model_is_held_to_one_flat_schema_with_every_kind() -> None:
    schema = extraction_schema()
    assert "$ref" not in json.dumps(schema) and "$defs" not in json.dumps(schema)
    item = schema["properties"]["claims"]["items"]
    assert tuple(item["properties"]["kind"]["enum"]) == KINDS
    assert set(item["required"]) == {"player_id", "kind", "direction", "confidence", "quote"}


@pytest.mark.parametrize(
    "bad",
    [
        {"confidence": 1.2},
        {"confidence": -0.1},
        {"kind": "breakout"},
        {"direction": 2},
        {"quote": ""},
    ],
)
def test_an_answer_off_the_schema_is_refused(bad: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        Extraction.model_validate({"claims": [claim(**bad)]})


def test_an_answer_without_its_claims_list_is_refused_not_read_as_none() -> None:
    with pytest.raises(ValidationError):
        Extraction.model_validate({"error": "JSONDecodeError"})


# the quote


def test_a_quote_is_found_as_the_sources_own_span() -> None:
    text = NEWS["text"]
    assert locate("to miss fourth straight", text) == (
        text.index("to miss"),
        "to miss fourth straight",
    )
    # case and a straight apostrophe for the source's curly one still find it; the span kept is
    # the source's, curly apostrophe and capitals included
    at, span = locate("knicks' jose alvarado", text) or (None, None)
    assert at == 0 and span == f"Knicks{CURLY} Jose Alvarado"
    assert locate('"to miss fourth straight"', text) == (
        text.index("to miss"),
        "to miss fourth straight",
    )


@pytest.mark.parametrize("quote", ["to miss five straight", "out for the season", "vs"])
def test_a_quote_that_is_not_a_span_of_the_text_is_not_found(quote: str) -> None:
    assert locate(quote, NEWS["text"]) is None


# the checks


def test_a_claim_passes_with_its_quote_dates_and_source_from_the_item() -> None:
    kept, rejected = review(NEWS, {"claims": [claim()]})
    assert rejected == []
    [c] = kept
    assert (c.player_id, c.kind, c.direction, c.source, c.source_id) == (
        "1628407",
        "injury_out",
        -1,
        "espn_news",
        "46969411",
    )
    assert NEWS["text"][c.quote_start : c.quote_start + len(c.quote)] == c.quote
    assert c.published_date == date(2026, 10, 29)
    assert c.model_confidence == 0.9 and c.confidence == 0.8  # a headline is capped at 0.8


@pytest.mark.parametrize(
    ("bad", "reason"),
    [
        ({"player_id": "999"}, "does not name"),
        ({"quote": "will miss the rest of the season"}, "not a span"),
        ({"direction": 1}, "direction +1 for injury_out"),
        ({"kind": "injury_return", "direction": -1}, "direction -1 for injury_return"),
        ({"kind": "trade_rumor", "direction": 1}, "direction +1 for trade_rumor"),
    ],
)
def test_a_claim_about_another_player_off_its_quote_or_the_wrong_way_is_rejected(
    bad: dict[str, Any], reason: str
) -> None:
    kept, rejected = review(NEWS, {"claims": [claim(**bad)]})
    assert kept == []
    assert len(rejected) == 1 and reason in rejected[0]["reason"], rejected
    assert rejected[0]["claim"]["quote"]


def test_other_may_go_either_way() -> None:
    kept, _ = review(NEWS, {"claims": [claim(kind="other", direction=1)]})
    assert [c.direction for c in kept] == [1]


def test_the_same_player_and_kind_twice_keeps_the_more_confident() -> None:
    kept, rejected = review(
        NEWS,
        {
            "claims": [
                claim(confidence=0.4, quote="(ankle)"),
                claim(confidence=0.7),
                claim(kind="role_down", confidence=0.5, quote="fourth straight"),
            ]
        },
    )
    assert rejected == []
    assert sorted((c.kind, c.confidence, c.quote) for c in kept) == [
        ("injury_out", 0.7, "to miss fourth straight"),
        ("role_down", 0.5, "fourth straight"),
    ]


def test_an_answer_off_the_schema_lands_no_claim_and_says_why() -> None:
    kept, rejected = review(NEWS, {"error": "JSONDecodeError: Expecting value"})
    assert kept == [] and rejected and rejected[0]["reason"].startswith("schema:")
    assert rejected[0]["claim"] is None


# the cap


def _cap(item: dict[str, Any], kind: str, quote: str) -> tuple[float, list[str]]:
    found = locate(quote, item["text"])
    assert found is not None
    return cap(item, kind, found[1], found[0])


def test_the_cap_is_the_lowest_rule_that_applies_and_names_it() -> None:
    assert _cap(NOTE, "injury_out", "has been ruled out for Friday") == (
        0.9,
        ["source espn_injury_note"],
    )
    assert _cap(NEWS, "injury_out", "to miss fourth straight") == (0.8, ["source espn_news"])
    shared = {**NEWS, "players": [*NEWS["players"], {"player_id": "2", "name": "Other"}]}
    assert _cap(shared, "injury_out", "to miss fourth straight") == (
        0.7,
        ["the item names 2 players"],
    )
    assert _cap(NEWS, "trade_rumor", "to miss fourth straight") == (0.5, ["kind trade_rumor"])
    assert _cap(NEWS, "injury_out", "(ankle)") == (0.6, ["a quote of fewer than 3 words"])
    # a hedge in the quote's own sentence, not in another one
    assert _cap(NOTE, "injury_return", "return next week") == (0.4, ["hedged: could"])


def test_an_expectation_caps_lower_than_a_fact_but_higher_than_a_hedge() -> None:
    item = {**NOTE, "text": "Smith is expected to return Monday."}
    assert _cap(item, "injury_return", "to return Monday") == (0.7, ["an expectation: expected"])


def test_the_month_of_may_is_not_a_hedge() -> None:
    item = {**NOTE, "text": "Smith will return from his knee injury in May."}
    assert _cap(item, "injury_return", "will return from his knee injury") == (
        0.9,
        ["source espn_injury_note"],
    )


# the model and the landing


def _model(answers: dict[str, dict[str, Any]], seen: list[str]) -> httpx.Client:
    """A fake Ollama: the answer for the item whose text the request carries."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": client.model_name()}]})
        body = json.loads(request.content)
        assert body["format"] == extraction_schema() and body["think"] is False
        view = json.loads(body["messages"][1]["content"])
        seen.append(view["text"])
        answer = answers[view["text"]]
        return httpx.Response(200, json={"message": {"content": json.dumps(answer)}})

    return httpx.Client(transport=httpx.MockTransport(handler))


def _landed(root: Path) -> list[Path]:
    return sorted(
        p for p in (root / "landing/ai/claims").rglob("*.json") if p.name != "_index.json"
    )


def test_claims_land_once_per_item_with_sidecars_and_a_rerun_asks_nothing(tmp_path: Path) -> None:
    inputs = {"items": [NEWS, NOTE]}
    answers = {
        NEWS["text"]: {"claims": [claim()]},
        NOTE["text"]: {
            "claims": [
                claim(player_id="7", quote="has been ruled out for Friday"),
                claim(player_id="7", quote="Sam Smith is done"),
            ]
        },
    }
    seen: list[str] = []
    http = _model(answers, seen)
    landing = Landing(LocalBackend(tmp_path), ingest_date=date(2026, 10, 30))
    counts = claims.extract(inputs, landing, http=http, log=lambda _: None)
    assert landing.flush() == []
    assert (counts["items"], counts["claims"], counts["rejected"]) == (2, 2, 1)
    files = _landed(tmp_path)
    names = {p.name for p in files}
    assert names == {
        "espn_news-46969411.json",
        "espn_news-46969411.meta.json",
        "espn_injury_note-501-abc.json",
        "espn_injury_note-501-abc.meta.json",
    }
    news = tmp_path / "landing/ai/claims/nba/2026-27/2026-10-30/espn_news-46969411.json"
    doc = json.loads(news.read_text(encoding="utf-8"))
    assert doc["text"] == NEWS["text"] and doc["model"] == client.model_name()
    assert doc["prompt"] == claims.prompt_version()
    [landed] = doc["claims"]
    assert SourceClaim.model_validate(landed).quote == "to miss fourth straight"
    sidecar = json.loads(news.with_suffix(".meta.json").read_text(encoding="utf-8"))
    assert sidecar["url"].endswith("/api/chat") and sidecar["key"] == "espn_news-46969411"
    assert sidecar["params"] == {"model": client.model_name(), "prompt": claims.prompt_version()}
    note = json.loads(
        next(p for p in files if p.name == "espn_injury_note-501-abc.json").read_text()
    )
    assert [r["reason"] for r in note["rejected"]] == ["the quote is not a span of the source text"]

    # a re-run, on another day: nothing asked, nothing written
    stamps = {p: p.stat().st_mtime_ns for p in files}
    again = Landing(LocalBackend(tmp_path), ingest_date=date(2026, 10, 31))
    counts = claims.extract(inputs, again, http=http, log=lambda _: None)
    assert again.flush() == []
    assert counts["already landed"] == 2 and counts["items"] == 0
    assert len(seen) == 2
    assert {p: p.stat().st_mtime_ns for p in _landed(tmp_path)} == stamps

    # a full refresh asks again
    fresh = Landing(LocalBackend(tmp_path), ingest_date=date(2026, 10, 31), full_refresh=True)
    assert claims.extract(inputs, fresh, http=http, log=lambda _: None)["items"] == 2
    assert len(seen) == 4


def test_an_item_the_model_does_not_answer_is_left_for_the_next_run(tmp_path: Path) -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        raise httpx.ConnectError("the model is away", request=request)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    items = [{**NEWS, "source_id": str(i), "text": f"{NEWS['text']} {i}"} for i in range(5)]
    landing = Landing(LocalBackend(tmp_path), ingest_date=date(2026, 10, 30))
    logged: list[str] = []
    counts = claims.extract({"items": items}, landing, http=http, log=logged.append)
    landing.flush()
    # three misses in a row and the run stands down; nothing is landed, so all are asked again
    assert counts["not answered"] == claims.STOP_AFTER == len(calls)
    assert "standing down" in logged[-1]
    assert not (tmp_path / "landing/ai/claims").exists() or _landed(tmp_path) == []


def test_an_answer_that_is_not_json_lands_as_rejected(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"message": {"content": "not json"}})

    http = httpx.Client(transport=httpx.MockTransport(handler))
    landing = Landing(LocalBackend(tmp_path), ingest_date=date(2026, 10, 30))
    counts = claims.extract({"items": [NEWS]}, landing, http=http, log=lambda _: None)
    landing.flush()
    assert (counts["items"], counts["claims"], counts["rejected"]) == (1, 0, 1)


def test_the_model_is_unavailable_when_the_service_is_down_or_the_model_not_pulled() -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    def pulled(names: list[str]) -> httpx.Client:
        return httpx.Client(
            transport=httpx.MockTransport(
                lambda r: httpx.Response(200, json={"models": [{"name": n} for n in names]})
            )
        )

    reason = client.unavailable(client=httpx.Client(transport=httpx.MockTransport(down)))
    assert reason is not None and "not reachable" in reason
    reason = client.unavailable(model="qwen3:8b", client=pulled(["llama3:8b"]))
    assert reason is not None and "not pulled" in reason
    assert client.unavailable(model="qwen3:8b", client=pulled(["qwen3:8b"])) is None


def test_extract_stands_down_quietly_when_the_model_is_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    inputs = tmp_path / "inputs.json"
    inputs.write_text(json.dumps({"items": [NEWS]}), encoding="utf-8")
    monkeypatch.setattr(client, "unavailable", lambda **_: "the service is not reachable")
    code = claims.main(["extract", "--inputs", str(inputs), "--root", str(tmp_path)])
    assert code == 0
    assert "no claims extracted" in capsys.readouterr().out
    assert not (tmp_path / "landing").exists()


# the inputs


def _con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute(
        "create table fct_player_news (league varchar, article_id varchar, stats_player_id varchar,"
        " headline varchar, published_at timestamptz, published_date date)"
    )
    con.execute(
        "create table dim_player (league varchar, stats_player_id varchar, full_name varchar,"
        " is_current boolean)"
    )
    con.execute(
        "create table fct_availability (league varchar, season varchar, injury_id varchar,"
        " stats_player_id varchar, athlete_name varchar, short_comment varchar,"
        " long_comment varchar, reported_date date, report_date date, is_current boolean)"
    )
    con.execute(
        "insert into fct_player_news values"
        " ('nba', '1', 'p1', 'Two players move', '2026-10-30 01:00:00+00', '2026-10-29'),"
        " ('nba', '1', 'p2', 'Two players move', '2026-10-30 01:00:00+00', '2026-10-29'),"
        " ('nba', '2', 'p1', 'An old headline', '2026-10-20 01:00:00+00', '2026-10-19')"
    )
    con.execute(
        "insert into dim_player values ('nba', 'p1', 'Player One', true),"
        " ('nba', 'p1', 'Player One', false), ('nba', 'p2', 'Player Two', true)"
    )
    con.execute(
        "insert into fct_availability values"
        " ('nba', '2026-27', '501', 'p1', 'Player One', 'One (knee) is out.', 'Out a week.',"
        "  '2026-10-28', '2026-10-30', true),"
        " ('nba', '2026-27', '502', null, 'Unlinked', 'Out.', null,"
        "  '2026-10-28', '2026-10-30', true),"
        " ('nba', '2026-27', '503', 'p2', 'Player Two', 'Old.', null,"
        "  '2026-10-01', '2026-10-02', false)"
    )
    return con


def test_inputs_are_recent_headlines_with_their_players_and_current_linked_notes() -> None:
    con = _con()
    news = claims.news_items(con, date(2026, 10, 27))
    assert len(news) == 1
    [item] = news
    assert item["source_id"] == "1" and item["season"] == "2026-27"
    assert item["players"] == [
        {"player_id": "p1", "name": "Player One"},
        {"player_id": "p2", "name": "Player Two"},
    ]
    assert item["published_at"].startswith("2026-10-30T01:00:00")
    [note] = claims.injury_items(con)
    assert note["text"] == "One (knee) is out.\nOut a week."
    assert note["source_id"].startswith("501-") and note["published_date"] == "2026-10-28"
    assert note["players"] == [{"player_id": "p1", "name": "Player One"}]
    # an edited note is a new item
    con.execute(
        "update fct_availability set long_comment = 'Out two weeks.' where injury_id = '501'"
    )
    [edited] = claims.injury_items(con)
    assert edited["source_id"] != note["source_id"]


def test_the_model_sees_the_item_and_its_players_only() -> None:
    assert claims.model_view(NEWS) == {
        "source": "an ESPN headline",
        "date": "2026-10-29",
        "players": NEWS["players"],
        "text": NEWS["text"],
    }


# the dbt sample's claims are the extractor's own output


@pytest.mark.parametrize("path", sorted((ROOT / "tests/fixtures/ai").glob("claims_*.json")))
def test_the_sample_claims_pass_the_extractors_checks(path: Path) -> None:
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert doc["claims"]
    for raw in doc["claims"]:
        c = SourceClaim.model_validate(raw)
        assert doc["text"][c.quote_start : c.quote_start + len(c.quote)] == c.quote
        assert c.player_id in {p["player_id"] for p in doc["players"]}
        assert c.confidence == min(c.model_confidence, c.confidence_cap)
