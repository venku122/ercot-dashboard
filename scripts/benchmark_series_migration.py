#!/usr/bin/env python3
"""Production-shaped throwaway benchmark for offline series migration."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import time


ROOT = Path(__file__).resolve().parents[1]
MIGRATION_PATH = Path(__file__).with_name("series_migration.py")
SPEC = importlib.util.spec_from_file_location("series_migration_benchmark_tool", MIGRATION_PATH)
assert SPEC is not None and SPEC.loader is not None
migration = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(migration)


def _seconds(callable_):
    started = time.perf_counter()
    result = callable_()
    return time.perf_counter() - started, result


def _create_fixture(path: Path, rows: int, physical_series: int) -> dict:
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(
        """
        CREATE TABLE metrics(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          metric_name TEXT NOT NULL,
          ts INTEGER NOT NULL,
          value REAL NOT NULL,
          interval INTEGER,
          metric_type TEXT,
          tags TEXT,
          dedupe_key TEXT);
        CREATE TABLE metric_tags(metric_id INTEGER NOT NULL,tag TEXT NOT NULL);
        CREATE INDEX idx_metrics_name_ts ON metrics(metric_name,ts);
        CREATE INDEX idx_metric_tags_metric ON metric_tags(metric_id);
        """
    )
    batch = []
    tag_rows = []
    inserted = 0
    for index in range(rows):
        series = index % physical_series
        batch.append(
            (
                "ercot.benchmark.demand_mw",
                1_700_000_000 + (index // physical_series) * 300,
                float((index * 17) % 100_000) / 10.0,
                300,
                "gauge",
                json.dumps(["source:benchmark", f"zone:{series:02d}"]),
                f"benchmark:{index}",
            )
        )
        if len(batch) == 5_000 or index == rows - 1:
            first_id = inserted + 1
            conn.executemany(
                "INSERT INTO metrics(metric_name,ts,value,interval,metric_type,tags,dedupe_key) "
                "VALUES(?,?,?,?,?,?,?)",
                batch,
            )
            for offset, item in enumerate(batch):
                decoded = json.loads(item[5])
                tag_rows.extend((first_id + offset, tag) for tag in decoded)
            conn.executemany("INSERT INTO metric_tags(metric_id,tag) VALUES(?,?)", tag_rows)
            inserted += len(batch)
            batch.clear()
            tag_rows.clear()
            conn.commit()
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.close()
    return {"rows": rows, "physical_series": physical_series}


def run_benchmark(rows: int, batch_size: int, physical_series: int) -> dict:
    with tempfile.TemporaryDirectory(prefix="series-migration-benchmark-") as directory:
        path = Path(directory) / "working-copy.db"
        fixture_seconds, fixture = _seconds(
            lambda: _create_fixture(path, rows, physical_series)
        )
        server = migration._load_server(migration.DEFAULT_SERVER)
        before = migration.status_report(path, server, batch_size=batch_size)
        conn = sqlite3.connect(path)
        legacy_seconds, legacy_count = _seconds(
            lambda: conn.execute(
                "SELECT COUNT(*) FROM metrics WHERE metric_name=? AND ts>=? AND ts<?",
                ("ercot.benchmark.demand_mw", 1_700_000_000, 1_700_086_400),
            ).fetchone()[0]
        )
        conn.close()
        first = migration.migrate(
            path,
            server,
            batch_size=batch_size,
            complete=True,
            verify=False,
            max_batches=1,
        )
        interrupted = migration.status_report(path, server, batch_size=batch_size)
        resumed = migration.migrate(
            path,
            server,
            batch_size=batch_size,
            complete=True,
            verify=True,
            max_batches=None,
        )
        final = migration.status_report(path, server, batch_size=batch_size)
        conn = sqlite3.connect(path)
        series_id = conn.execute(
            "SELECT id FROM series WHERE metric_name=? ORDER BY id LIMIT 1",
            ("ercot.benchmark.demand_mw",),
        ).fetchone()[0]
        normalized_seconds, normalized_count = _seconds(
            lambda: conn.execute(
                "SELECT COUNT(*) FROM metrics WHERE series_id=? AND ts>=? AND ts<?",
                (series_id, 1_700_000_000, 1_700_086_400),
            ).fetchone()[0]
        )
        plan = [
            str(row[3])
            for row in conn.execute(
                "EXPLAIN QUERY PLAN SELECT ts,value FROM metrics "
                "WHERE series_id=? AND ts>=? AND ts<? ORDER BY ts,id",
                (series_id, 1_700_000_000, 1_700_086_400),
            )
        ]
        conn.close()
        return {
            "schema": 1,
            "fixture": {**fixture, "creation_seconds": fixture_seconds},
            "before": before,
            "interruption": {
                "first_batch": first,
                "remaining_rows": interrupted["normalized_series"][
                    "unassigned_series_id_rows"
                ],
            },
            "resume": resumed,
            "after": final,
            "queries": {
                "legacy_count": legacy_count,
                "legacy_seconds": legacy_seconds,
                "normalized_series_count": normalized_count,
                "normalized_seconds": normalized_seconds,
                "normalized_plan": plan,
            },
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", type=int, default=500_000)
    parser.add_argument("--batch-size", type=int, default=25_000)
    parser.add_argument("--physical-series", type=int, default=32)
    args = parser.parse_args()
    if args.rows < 1 or args.batch_size < 1 or args.physical_series < 1:
        raise SystemExit("positive bounds required")
    print(json.dumps(run_benchmark(args.rows, args.batch_size, args.physical_series), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
