from ingest.cli import build_parser, main


def test_parser_accepts_spec_flags() -> None:
    args = build_parser().parse_args(
        ["espn", "--league", "nba", "--since", "2026-10-01", "--full-refresh"]
    )
    assert args.source == "espn"
    assert args.league == "nba"
    assert args.since.isoformat() == "2026-10-01"
    assert args.full_refresh is True


def test_main_runs_without_fetching() -> None:
    assert main(["stats", "--dry-run"]) == 0
