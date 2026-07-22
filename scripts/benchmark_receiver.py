#!/usr/bin/env python3
import argparse
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def load_server(server_path):
    spec = importlib.util.spec_from_file_location("ercot_receiver_server", server_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {server_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def timed(callback, iterations=5):
    samples = []
    value = None
    for _ in range(iterations):
        started = time.perf_counter()
        value = callback()
        samples.append(time.perf_counter() - started)
    return {"best_seconds": min(samples), "median_seconds": sorted(samples)[len(samples) // 2]}, value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--server-path",
        type=Path,
        default=ROOT / "ercot-receiver" / "server.py",
    )
    args = parser.parse_args()
    server = load_server(args.server_path.resolve())
    with tempfile.TemporaryDirectory() as directory:
        db_path = Path(directory) / "metrics.db"
        conn = sqlite3.connect(db_path)
        server.init_db(conn)
        start = 1_735_689_600
        rows = 365 * 24 * 12
        metric_rows = [
            ("ercot.pricing", start + index * 300, float((index % 240) - 80), 300, "gauge", '["ercot_region:HB_HOUSTON"]')
            for index in range(rows)
        ]
        conn.executemany(
            """
            INSERT INTO metrics (metric_name, ts, value, interval, metric_type, tags)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            metric_rows,
        )
        ids = conn.execute("SELECT id FROM metrics ORDER BY id").fetchall()
        conn.executemany(
            "INSERT INTO metric_tags (metric_id, tag) VALUES (?, ?)",
            [(row[0], "ercot_region:HB_HOUSTON") for row in ids],
        )
        conn.commit()
        handler = server.Handler.__new__(server.Handler)
        end = start + rows * 300

        tagged, raw_points = timed(
            lambda: handler._series_query(
                conn,
                "ercot.pricing",
                start,
                end,
                ["ercot_region:HB_HOUSTON"],
            ),
            iterations=3,
        )
        hourly, hourly_points = timed(
            lambda: handler._series_query(
                conn,
                "ercot.pricing",
                start,
                end,
                ["ercot_region:HB_HOUSTON"],
                bucket_seconds=3600,
            )
        )
        extrema = None
        extrema_points = []
        dedupe = None
        if hasattr(server, "ingest_metrics"):
            extrema, extrema_points = timed(
                lambda: handler._series_query(
                    conn,
                    "ercot.pricing",
                    start,
                    end,
                    ["ercot_region:HB_HOUSTON"],
                    bucket_seconds=7200,
                    aggregation="minmax",
                )
            )
            dedupe_payload = [
                {
                    "metric_name": "ercot.benchmark.dedupe",
                    "points": [
                        {"timestamp": end, "value": 1, "dedupe_key": "benchmark:dedupe"}
                    ],
                }
            ]
            first = server.ingest_metrics(conn, dedupe_payload)
            page_count_before = conn.execute("PRAGMA page_count").fetchone()[0]
            second = server.ingest_metrics(conn, dedupe_payload)
            page_count_after = conn.execute("PRAGMA page_count").fetchone()[0]
            dedupe = {
                "first_inserted": first["inserted"],
                "retry_unchanged": second["unchanged"],
                "retry_page_growth": page_count_after - page_count_before,
            }

        evidence = {
            "rows": rows,
            "database_bytes": db_path.stat().st_size,
            "tagged_12_month_raw": {**tagged, "points": len(raw_points)},
            "sql_hourly_average": {**hourly, "points": len(hourly_points)},
            "sql_two_hour_minmax": (
                {**extrema, "points": len(extrema_points)} if extrema else None
            ),
            "dedupe": dedupe,
            "server_path": str(args.server_path.resolve()),
        }
        print(json.dumps(evidence, indent=2, sort_keys=True))
        conn.close()


if __name__ == "__main__":
    main()
