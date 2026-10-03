#!/usr/bin/env python3
"""Isolated benchmark for correction-aware historical demand context.

The default fixture spans the maximum 401 stored Chicago local dates. It uses
an ephemeral SQLite database and never reads or mutates production state.
"""

from __future__ import annotations

import argparse
from datetime import date, timedelta
import importlib.util
import json
from pathlib import Path
import sqlite3
import statistics
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "ercot-receiver" / "server.py"
FINAL_DAY = date(2026, 2, 5)


def load_server(path: Path):
    spec = importlib.util.spec_from_file_location(
        "ercot_receiver_historical_context_benchmark", path
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load receiver module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def timed(callback, iterations: int = 1):
    samples = []
    value = None
    for _ in range(iterations):
        started = time.perf_counter()
        value = callback()
        samples.append(time.perf_counter() - started)
    return {
        "best_seconds": min(samples),
        "median_seconds": statistics.median(samples),
    }, value


def run(server_path: Path = SERVER, *, days: int = 401):
    if not 2 <= days <= 401:
        raise ValueError("historical_context_benchmark_days")
    server = load_server(server_path.resolve())
    historical = sys.modules[server.resolve_historical_context.__module__]
    first_day = FINAL_DAY - timedelta(days=days - 1)
    start, _ = historical._date_bounds(first_day)
    _, end = historical._date_bounds(FINAL_DAY)

    with tempfile.TemporaryDirectory() as directory:
        database_path = Path(directory) / "historical-context.db"
        conn = sqlite3.connect(database_path)
        try:
            server.init_db(conn)
            series_id = server.resolve_series_id(
                conn, historical.METRIC, ["source:supply_demand"]
            )
            points = list(range(start, end, historical.CADENCE_SECONDS))
            conn.executemany(
                """
                INSERT INTO metrics
                    (metric_name,ts,value,interval,metric_type,tags,series_id)
                VALUES (?,?,?,?,?,?,?)
                """,
                (
                    (
                        historical.METRIC,
                        timestamp,
                        45_000.0 + float((timestamp // 300) % 288),
                        historical.CADENCE_SECONDS,
                        "gauge",
                        historical.TAGS_JSON,
                        series_id,
                    )
                    for timestamp in points
                ),
            )
            conn.commit()

            cold, initial = timed(
                lambda: historical.resolve_historical_context(conn, end)
            )
            old_version = initial["resource"]["content_version"]
            old_resource = historical.historical_context_resource(
                conn, old_version, end
            )
            warm, replay = timed(
                lambda: historical.resolve_historical_context(conn, end), iterations=5
            )

            corrected_day = FINAL_DAY - timedelta(days=10)
            corrected_timestamp = historical._hour_starts(corrected_day, 23)[0]
            conn.execute(
                "UPDATE metrics SET value=? WHERE series_id=? AND ts=?",
                (99_999.0, series_id, corrected_timestamp),
            )
            historical.mark_demand_history_changes(conn, [corrected_timestamp])
            conn.commit()
            statements = []
            conn.set_trace_callback(statements.append)
            correction, corrected = timed(
                lambda: historical.resolve_historical_context(conn, end)
            )
            conn.set_trace_callback(None)

            new_version = corrected["resource"]["content_version"]
            day_rows = conn.execute(
                "SELECT count(*) FROM historical_demand_days"
            ).fetchone()[0]
            hour_rows = conn.execute(
                "SELECT count(*) FROM historical_demand_hours"
            ).fetchone()[0]
            resource_rows = conn.execute(
                "SELECT count(*) FROM historical_context_resources"
            ).fetchone()[0]
            corrected_generation = conn.execute(
                "SELECT generation FROM historical_context_state WHERE series_key=?",
                (historical.SERIES_KEY,),
            ).fetchone()[0]
            rewritten_days = conn.execute(
                "SELECT count(*) FROM historical_demand_days WHERE generation=?",
                (corrected_generation,),
            ).fetchone()[0]
            resource_bytes = conn.execute(
                "SELECT coalesce(sum(length(payload_json)),0) FROM historical_context_resources"
            ).fetchone()[0]
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            database_bytes = database_path.stat().st_size

            return {
                "fixture": {
                    "chicago_local_dates": days,
                    "raw_points": len(points),
                    "start": start,
                    "end": end,
                },
                "materialization": {
                    "cold": cold,
                    "warm": warm,
                    "correction": correction,
                    "day_rows": day_rows,
                    "hour_rows": hour_rows,
                    "rewritten_days_after_correction": rewritten_days,
                    "bounded_raw_queries_after_correction": sum(
                        "SELECT ts,value FROM metrics" in statement
                        and "LIMIT 301" in statement
                        for statement in statements
                    ),
                },
                "resources": {
                    "rows": resource_rows,
                    "payload_bytes": resource_bytes,
                    "replay_content_version_stable": replay["resource"]
                    ["content_version"]
                    == old_version,
                    "correction_created_version": new_version != old_version,
                    "old_resource_bytes_stable": historical.historical_context_resource(
                        conn, old_version, end
                    )
                    == old_resource,
                },
                "database_bytes": database_bytes,
                "selected_state": corrected["state"],
                "server_path": str(server_path.resolve()),
            }
        finally:
            conn.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--server-path", type=Path, default=SERVER)
    parser.add_argument("--days", type=int, default=401)
    args = parser.parse_args()
    print(json.dumps(run(args.server_path, days=args.days), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
