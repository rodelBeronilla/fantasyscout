"""dbt unit-test fixtures written as SQL run on Databricks too (#651).

CI runs the unit tests on DuckDB only; the nightly build runs them on Databricks, which rejects a
VARCHAR without a length (DATATYPE_MISSING_SIZE). A fixture casts to STRING, which both accept.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VARCHAR = re.compile(r"\bvarchar\b(?!\s*\()", re.IGNORECASE)


def test_sql_fixtures_cast_to_string_not_varchar() -> None:
    bad = []
    for path in sorted((ROOT / "dbt" / "models").rglob("*.yml")):
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if VARCHAR.search(line):
                bad.append(f"{path.relative_to(ROOT)}:{n}")
    assert not bad, f"use string, not varchar, in: {bad}"
