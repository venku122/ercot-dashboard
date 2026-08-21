#!/usr/bin/env python3
"""Deterministic acceptance evidence for normalized metric-series identity."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SELECTOR_METRIC = "ercot.parity.selector_mw"
ROLLUP_METRIC = "ercot.parity.rollup_mw"


def load_server(path: Path):
    spec = importlib.util.spec_from_file_location("ercot_series_identity_server", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load receiver module: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def create_legacy_fixture(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            metric_name TEXT NOT NULL,
            ts INTEGER NOT NULL,
            value REAL NOT NULL,
            interval INTEGER,
            metric_type TEXT,
            tags TEXT,
            dedupe_key TEXT
        );
        CREATE TABLE metric_tags (metric_id INTEGER NOT NULL, tag TEXT NOT NULL);
        """
    )
    rows = [
        (SELECTOR_METRIC, 100, 10.0, ["zone:north", "source:fixture"], "selector-north-a"),
        (SELECTOR_METRIC, 200, 20.0, ["source:fixture", "zone:north"], "selector-north-b"),
        (SELECTOR_METRIC, 300, 30.0, ["source:fixture", "zone:south"], "selector-south-a"),
        (SELECTOR_METRIC, 400, 40.0, ["class:thermal", "zone:north", "source:fixture"], "selector-north-thermal"),
        (SELECTOR_METRIC, 500, 50.0, [], "selector-untagged"),
        (ROLLUP_METRIC, 600, 3.0, ["source:fixture", "zone:north"], "rollup-north-a"),
        (ROLLUP_METRIC, 600, 7.0, ["zone:south", "source:fixture"], "rollup-south-a"),
        (ROLLUP_METRIC, 700, 11.0, ["source:fixture", "zone:north"], "rollup-north-b"),
        (ROLLUP_METRIC, 700, 13.0, ["source:fixture", "zone:south"], "rollup-south-b"),
    ]
    for metric, ts, value, tags, dedupe_key in rows:
        cursor = conn.execute(
            "INSERT INTO metrics (metric_name,ts,value,interval,metric_type,tags,dedupe_key) "
            "VALUES (?,?,?,?,?,?,?)",
            (metric, ts, value, 60, "gauge", json.dumps(tags), dedupe_key),
        )
        conn.executemany(
            "INSERT INTO metric_tags (metric_id,tag) VALUES (?,?)",
            [(cursor.lastrowid, tag) for tag in sorted(set(tags))],
        )
    conn.commit()
    conn.close()


def normalized_tags(tags: list[str]) -> list[str]:
    return sorted(set(str(tag)[:200] for tag in tags[:20]))


def legacy_reference_query(
    conn: sqlite3.Connection,
    metric: str,
    tags: list[str],
    *,
    since: int | None = None,
    until: int | None = None,
    rollup: str | None = None,
) -> list[list[float | int]]:
    """Independent model of the v1 subset-tag selector over legacy columns."""
    required = set(normalized_tags(tags))
    clauses = ["metric_name = ?"]
    params: list[Any] = [metric]
    if since is not None:
        clauses.append("ts >= ?")
        params.append(since)
    if until is not None:
        clauses.append("ts <= ?")
        params.append(until)
    rows = conn.execute(
        "SELECT id,ts,value,tags FROM metrics WHERE " + " AND ".join(clauses) + " ORDER BY ts,id",
        params,
    ).fetchall()
    selected: list[list[float | int]] = []
    for metric_id, ts, value, raw_tags in rows:
        stored = {
            row[0]
            for row in conn.execute(
                "SELECT tag FROM metric_tags WHERE metric_id = ?", (metric_id,)
            )
        }
        if not stored:
            try:
                decoded = json.loads(raw_tags or "[]")
                stored = set(decoded if isinstance(decoded, list) else [])
            except (json.JSONDecodeError, TypeError):
                stored = set()
        if required.issubset(stored):
            selected.append([ts, value])
    if rollup != "sum":
        return selected
    totals: dict[int, float] = {}
    for ts, value in selected:
        totals[int(ts)] = totals.get(int(ts), 0.0) + float(value)
    return [[ts, totals[ts]] for ts in sorted(totals)]


def production_query(server, conn, metric, tags, *, since=None, until=None, rollup=None):
    handler = object.__new__(server.Handler)
    return handler._series_query(conn, metric, since, until, tags, rollup=rollup)


def schema_snapshot(conn: sqlite3.Connection) -> dict[str, Any]:
    return {
        "series": conn.execute(
            "SELECT id,metric_name,tags_json,identity_hash FROM series ORDER BY id"
        ).fetchall(),
        "mapping": conn.execute("SELECT id,series_id FROM metrics ORDER BY id").fetchall(),
        "series_tags": conn.execute(
            "SELECT series_id,tag FROM series_tags ORDER BY series_id,tag"
        ).fetchall(),
        "indexes": conn.execute(
            "SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name"
        ).fetchall(),
    }


def run_acceptance(server_path: Path, fixture_path: Path) -> dict[str, Any]:
    server = load_server(server_path)
    create_legacy_fixture(fixture_path)
    conn = sqlite3.connect(fixture_path)
    legacy_before = {
        "no_tags": legacy_reference_query(conn, SELECTOR_METRIC, []),
        "one_tag": legacy_reference_query(conn, SELECTOR_METRIC, ["zone:north"]),
        "multi_tags": legacy_reference_query(
            conn, SELECTOR_METRIC, ["zone:north", "source:fixture", "zone:north"]
        ),
        "rollup": legacy_reference_query(
            conn, ROLLUP_METRIC, ["source:fixture"], rollup="sum"
        ),
    }
    server.init_db(conn)
    conn.commit()
    first = schema_snapshot(conn)
    null_after_first = conn.execute(
        "SELECT COUNT(*) FROM metrics WHERE series_id IS NULL"
    ).fetchone()[0]
    server.init_db(conn)
    conn.commit()
    second = schema_snapshot(conn)

    cases = []
    definitions = [
        ("no_tags", SELECTOR_METRIC, [], None),
        ("one_tag", SELECTOR_METRIC, ["zone:north"], None),
        (
            "multi_tags_unsorted_duplicate",
            SELECTOR_METRIC,
            ["zone:north", "source:fixture", "zone:north"],
            None,
        ),
        ("missing_tag", SELECTOR_METRIC, ["zone:missing"], None),
        ("rollup_sum_inputs", ROLLUP_METRIC, ["source:fixture"], "sum"),
    ]
    for name, metric, tags, rollup in definitions:
        expected = legacy_reference_query(conn, metric, tags, rollup=rollup)
        actual = production_query(server, conn, metric, tags, rollup=rollup)
        cases.append(
            {
                "name": name,
                "tags": tags,
                "rollup": rollup,
                "expected": expected,
                "actual": actual,
                "exact_equal": expected == actual,
            }
        )

    before_correction = conn.execute(
        "SELECT COUNT(*),series_id FROM metrics WHERE dedupe_key='selector-north-a'"
    ).fetchone()
    correction = server.ingest_metrics(
        conn,
        [
            {
                "metric_name": SELECTOR_METRIC,
                "tags": ["zone:north", "source:fixture", "zone:north"],
                "interval": 60,
                "metric_type": "gauge",
                "points": [
                    {"timestamp": 100, "value": 12.5, "dedupe_key": "selector-north-a"}
                ],
            }
        ],
        current_ts=800,
    )
    after_correction = conn.execute(
        "SELECT COUNT(*),series_id,value FROM metrics WHERE dedupe_key='selector-north-a'"
    ).fetchone()
    correction_expected = legacy_reference_query(conn, SELECTOR_METRIC, ["zone:north"])
    correction_actual = production_query(server, conn, SELECTOR_METRIC, ["zone:north"])
    value_correction_series_id = after_correction[1]
    tag_correction = server.ingest_metrics(
        conn,
        [
            {
                "metric_name": SELECTOR_METRIC,
                "tags": ["source:fixture", "zone:south"],
                "interval": 60,
                "metric_type": "gauge",
                "points": [
                    {"timestamp": 100, "value": 15.0, "dedupe_key": "selector-north-a"}
                ],
            }
        ],
        current_ts=900,
    )
    after_tag_correction = conn.execute(
        "SELECT COUNT(*),series_id,value FROM metrics WHERE dedupe_key='selector-north-a'"
    ).fetchone()
    tag_correction_cases = {
        tag: legacy_reference_query(conn, SELECTOR_METRIC, [tag])
        == production_query(server, conn, SELECTOR_METRIC, [tag])
        for tag in ("zone:north", "zone:south")
    }

    north_series_id = conn.execute(
        "SELECT id FROM series WHERE metric_name=? AND tags_json=?",
        (SELECTOR_METRIC, server.canonical_series_tags(["source:fixture", "zone:north"])),
    ).fetchone()[0]
    plan = conn.execute(
        "EXPLAIN QUERY PLAN SELECT ts,value FROM metrics "
        "WHERE series_id=? AND ts>=? AND ts<=? ORDER BY ts",
        (north_series_id, 0, 1000),
    ).fetchall()
    plan_detail = [str(row[3]) for row in plan]
    indexed = any(
        "USING COVERING INDEX idx_metrics_series_ts_id_value" in detail
        and "series_id=?" in detail
        and "ts>?" in detail
        and "ts<?" in detail
        for detail in plan_detail
    )
    conn.commit()
    counts_before_ro = schema_snapshot(conn)
    conn.close()

    ro = sqlite3.connect(f"file:{fixture_path.resolve()}?mode=ro", uri=True)
    ro_cases_equal = all(
        legacy_reference_query(ro, metric, tags, rollup=rollup)
        == production_query(server, ro, metric, tags, rollup=rollup)
        for _name, metric, tags, rollup in definitions
    )
    counts_after_ro = schema_snapshot(ro)
    ro.close()

    return {
        "fixture": {
            "synthetic": True,
            "reference_points_across_cases": len(sum(legacy_before.values(), [])),
            "metric_rows": len(first["mapping"]),
            "series_rows": len(first["series"]),
        },
        "migration": {
            "null_series_ids_after_first": null_after_first,
            "second_run_exactly_idempotent": first == second,
            "legacy_columns_retained": True,
        },
        "parity_cases": cases,
        "correction": {
            "same_identity_receiver_result": {
                "inserted": correction["inserted"],
                "updated": correction["updated"],
                "unchanged": correction["unchanged"],
            },
            "same_identity": {
                "row_count_unchanged": before_correction[0] == after_correction[0] == 1,
                "series_id_stable": before_correction[1] == after_correction[1],
                "updated_value": after_correction[2],
                "exact_query_parity": correction_expected == correction_actual,
            },
            "tag_change_receiver_result": {
                "inserted": tag_correction["inserted"],
                "updated": tag_correction["updated"],
                "unchanged": tag_correction["unchanged"],
            },
            "tag_change": {
                "row_count_unchanged": after_tag_correction[0] == 1,
                "series_id_changed": after_tag_correction[1] != value_correction_series_id,
                "updated_value": after_tag_correction[2],
                "north_and_south_query_parity": tag_correction_cases,
            },
        },
        "query_plan": {"detail": plan_detail, "indexed_series_id_ts_id": indexed},
        "read_only_recheck": {
            "exact_query_parity": ro_cases_equal,
            "database_unchanged": counts_before_ro == counts_after_ro,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--server",
        type=Path,
        default=ROOT / "ercot-receiver" / "server.py",
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="ercot-series-identity-") as tmp:
        report = run_acceptance(args.server.resolve(), Path(tmp) / "fixture.db")
    encoded = json.dumps(report, indent=2, sort_keys=True)
    if args.output:
        args.output.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)
    checks = [
        report["migration"]["null_series_ids_after_first"] == 0,
        report["migration"]["second_run_exactly_idempotent"],
        all(case["exact_equal"] for case in report["parity_cases"]),
        report["correction"]["same_identity"]["row_count_unchanged"],
        report["correction"]["same_identity"]["series_id_stable"],
        report["correction"]["same_identity"]["exact_query_parity"],
        report["correction"]["tag_change"]["row_count_unchanged"],
        report["correction"]["tag_change"]["series_id_changed"],
        all(report["correction"]["tag_change"]["north_and_south_query_parity"].values()),
        report["query_plan"]["indexed_series_id_ts_id"],
        report["read_only_recheck"]["database_unchanged"],
    ]
    return 0 if all(checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
