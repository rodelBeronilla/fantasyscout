"""The dbt exposures name the same tables the consumers' code reads (#275)."""

from __future__ import annotations

import re
from pathlib import Path

import yaml

from export import layout

ROOT = Path(__file__).resolve().parent.parent
EXPOSURES = yaml.safe_load((ROOT / "dbt" / "models" / "exposures.yml").read_text(encoding="utf-8"))


def _refs(name: str) -> set[str]:
    exposure = next(e for e in EXPOSURES["exposures"] if e["name"] == name)
    return {re.fullmatch(r"ref\('([a-z_0-9]+)'\)", d).group(1) for d in exposure["depends_on"]}


def _nodes() -> set[str]:
    models = {p.stem for p in (ROOT / "dbt" / "models").rglob("*.sql")}
    seeds = {p.stem for p in (ROOT / "dbt" / "seeds").glob("*.csv")}
    return models | seeds


def test_the_site_export_exposure_lists_every_exported_dbt_node() -> None:
    exported = {spec.name for spec in (*layout.GOLD, *layout.OPS)}
    assert _refs("site_export") == exported & _nodes()
    # the exported tables that are not dbt nodes are the ones ops.results writes after the build
    assert exported - _nodes() == {"build_log", "publish_gate", "test_results"}


def test_each_notebook_exposure_names_the_tables_its_cells_read() -> None:
    models = {p.stem for p in (ROOT / "dbt" / "models").rglob("*.sql")}
    for exposure in EXPOSURES["exposures"]:
        if not exposure["name"].startswith("notebook_"):
            continue
        source = (ROOT / "notebooks" / f"nb_{exposure['name'][9:]}.py").read_text(encoding="utf-8")
        read = {
            m
            for m in re.findall(
                r"\b((?:fct|dim|mart)_[a-z_0-9]+|reconciliation_summary|reconciliation|ingest_log|test_results|publish_gate)\b",
                source,
            )
        }
        assert _refs(exposure["name"]) == read & models, exposure["name"]


def test_every_exposure_ref_is_a_dbt_node() -> None:
    for exposure in EXPOSURES["exposures"]:
        assert _refs(exposure["name"]) <= _nodes(), exposure["name"]
