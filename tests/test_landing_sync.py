"""The landing mirror copies the seasons asked for, once, never the ingest's index (#769)."""

from __future__ import annotations

from pathlib import Path, PurePosixPath

from ingest.store import LocalBackend
from ops.landing_sync import plan, sync


def _volume(root: Path) -> LocalBackend:
    files = {
        "landing/stats/playergamelogs/nba/2023-24/2024-04-15/regular.json": b'{"a": 1}',
        "landing/stats/playergamelogs/nba/2023-24/2024-04-15/regular.meta.json": b"{}",
        "landing/stats/playergamelogs/nba/2023-24/_index.json": b"{}",
        "landing/stats/playergamelogs/nba/2024-25/2025-04-14/regular.json": b'{"b": 2}',
        "landing/stats/playergamelogs/wnba/2024/2024-09-20/regular.json": b'{"c": 3}',
        "landing/espn/injuries/nba/2023-24/2024-03-01/league.json": b'{"d": 4}',
        "landing/_ops/ingest_log/2024-04-15/run.json": b"{}",
    }
    backend = LocalBackend(root)
    for path, body in files.items():
        backend.write_bytes(PurePosixPath(path), body)
    return backend


def test_the_plan_takes_the_seasons_asked_for_from_every_feed(tmp_path: Path) -> None:
    files = plan(_volume(tmp_path / "volume"), ["nba"], ["2023-24"])
    assert [f.as_posix() for f in files] == [
        "landing/espn/injuries/nba/2023-24/2024-03-01/league.json",
        "landing/stats/playergamelogs/nba/2023-24/2024-04-15/regular.json",
        "landing/stats/playergamelogs/nba/2023-24/2024-04-15/regular.meta.json",
    ]


def test_a_sync_copies_once_and_counts_what_the_volume_lost(tmp_path: Path) -> None:
    volume = _volume(tmp_path / "volume")
    out = tmp_path / "mirror"
    files = plan(volume, ["nba"], ["2023-24", "2024-25"])
    first = sync(volume, out, files, workers=2)
    assert (first.copied, first.present, first.missing) == (4, 0, 0)
    assert (
        out / "landing/stats/playergamelogs/nba/2024-25/2025-04-14/regular.json"
    ).read_bytes() == b'{"b": 2}'
    assert not list(out.rglob("*.part"))
    again = sync(volume, out, files)
    assert (again.copied, again.present, again.missing) == (0, 4, 0)
    gone = sync(
        volume, tmp_path / "other", [PurePosixPath("landing/stats/x/nba/2023-24/d/none.json")]
    )
    assert gone.missing == 1


class Flaky:
    """A source whose first two reads of each file fail, as a rate-limited Files API does."""

    def __init__(self, inner: LocalBackend) -> None:
        self.inner = inner
        self.fails: dict[str, int] = {}

    def list_directory(self, directory: PurePosixPath) -> list[tuple[PurePosixPath, bool]]:
        return self.inner.list_directory(directory)

    def list_files(self, directory: PurePosixPath) -> list[PurePosixPath]:
        return self.inner.list_files(directory)

    def read_bytes(self, path: PurePosixPath) -> bytes | None:
        n = self.fails.get(str(path), 0)
        if n < 2:
            self.fails[str(path)] = n + 1
            raise RuntimeError("HTTP 429 RESOURCE_EXHAUSTED")
        return self.inner.read_bytes(path)


def test_a_rate_limited_read_is_retried_in_later_rounds(tmp_path: Path) -> None:
    volume = Flaky(_volume(tmp_path / "volume"))
    files = plan(volume, ["nba"], ["2023-24"])
    pauses: list[float] = []
    done = sync(volume, tmp_path / "mirror", files, workers=2, sleep=pauses.append)
    assert (done.copied, done.missing, done.failed) == (3, 0, [])
    assert pauses == [30.0, 60.0], "two rounds of retries, the pause doubling"
    stuck = sync(
        Flaky(_volume(tmp_path / "v2")), tmp_path / "m2", files, rounds=2, sleep=pauses.append
    )
    assert stuck.copied == 0 and len(stuck.failed) == 3
