"""The banner at the top of the published dbt docs: generated from the CI fixture sample (#625).

    uv run python -m ops.docs_banner dbt-docs/index.html

The dbt docs at /docs/ are generated on DuckDB from the CI fixture sample, so their column types
are DuckDB's and their row counts the sample's; the banner says so and points to the pages with
the lakehouse's own numbers (#350). CI writes it into the `dbt-docs` artifact that every deploy
ships; a manual deploy that builds the docs itself runs the same command. Adding it twice is a
no-op.
"""

from __future__ import annotations

import sys
from pathlib import Path

MARKER = "generated from the CI fixture sample"
STYLE = "background:#fde68a;color:#1f2937;padding:.5rem 1rem;font:14px system-ui,sans-serif"
BANNER = (
    f'<div style="{STYLE}">These dbt docs are {MARKER} (a few rows per source), so column types '
    "are DuckDB&#39;s and row counts are the sample&#39;s. The models are the lakehouse&#39;s; its "
    'numbers are on <a href="/health/">Data Health</a>, and the <a href="/schema/">Schema</a> page '
    "describes every model with its lineage.</div>"
)


def with_banner(html: str) -> str:
    """The page with the banner first in its body; unchanged when it already has it."""
    if MARKER in html:
        return html
    start = html.find("<body")
    if start < 0:
        raise ValueError("no body tag in the dbt docs")
    i = html.index(">", start) + 1
    return html[:i] + BANNER + html[i:]


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        print("usage: python -m ops.docs_banner <dbt docs index.html>", file=sys.stderr)
        return 2
    path = Path(args[0])
    path.write_text(with_banner(path.read_text(encoding="utf-8")), encoding="utf-8")
    print(f"docs banner: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
