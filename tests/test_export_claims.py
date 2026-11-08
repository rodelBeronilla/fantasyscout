"""The claims the export ships leave out every claim read from a YouTube transcript (#823).

A transcript claim's quote is the transcript's own words, which never leave the lakehouse (ADR
0008, the YouTube addendum), not even in the owner-only Parquet. The export's filter tells one by
its source_id: the 11-character video id, then ``-t`` and the chunk's start in seconds.
"""

from __future__ import annotations

import duckdb

from export import layout


def _claims_spec() -> layout.TableSpec:
    return next(spec for spec in layout.GOLD if spec.table == "gold.fct_player_claim")


def test_the_claims_export_keeps_youtube_titles_and_drops_transcripts() -> None:
    con = duckdb.connect()
    con.execute("create schema gold")
    con.execute(
        "create table gold.fct_player_claim as select * from (values"
        " ('nba', current_date, '1', 'espn:headline', '123-x'),"
        " ('nba', current_date, '2', 'rss:hoopsrumors', 'item-t9'),"
        " ('nba', current_date, '3', 'youtube:sporting-logically', 'KGq6N_Nr7a4'),"
        " ('nba', current_date, '4', 'youtube:sporting-logically', 'KGq6N_Nr7a4-t31'),"
        " ('nba', current_date, '5', 'youtube:sporting-logically', 'a-tb_Nr7a40-t1')"
        ") as t(league, published_date, stats_player_id, source, source_id)"
    )
    kept = [row[2] for row in con.execute(_claims_spec().sql).fetchall()]
    # a feed id may hold -t anywhere; a video id may hold -t before its twelfth character
    assert sorted(kept) == ["1", "2", "3"]
