from __future__ import annotations

from pathlib import Path

import pytest

from ops.docs_banner import BANNER, MARKER, main, with_banner


def test_the_banner_opens_the_body_once() -> None:
    html = '<html><head></head><body class="x"><div id="app"></div></body></html>'
    out = with_banner(html)
    assert (
        out == '<html><head></head><body class="x">' + BANNER + '<div id="app"></div></body></html>'
    )
    assert with_banner(out) == out
    assert out.count(MARKER) == 1


def test_a_page_without_a_body_is_refused() -> None:
    with pytest.raises(ValueError):
        with_banner("<html></html>")


def test_main_rewrites_the_file(tmp_path: Path) -> None:
    page = tmp_path / "index.html"
    page.write_text("<body></body>", encoding="utf-8")
    assert main([str(page)]) == 0
    assert MARKER in page.read_text(encoding="utf-8")
    assert main([]) == 2
